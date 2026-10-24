import type { WebReadRequest, WebReadResult, WebReader } from "@eval/contracts";
import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { assessWebDate, parseAbsoluteWebDate, validateDateRange } from "./web-date.js";

interface ResolvedAddress { address: string; family: number }
interface WebDownload {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  destroy?: () => void;
}
/** DNS and transport overrides are trusted test seams, never tool input. */
export interface WebReaderOptions {
  beforeRequest?: (url: string) => void;
  timeoutMs?: number;
  maxBytes?: number;
  maxTextChars?: number;
  maxPdfPages?: number;
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  publicLookup?: (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;
  download?: (url: URL, address: ResolvedAddress, signal: AbortSignal, accept?:string) => Promise<WebDownload>;
}
interface ParsedLine { text: string; page?: number }
interface ParsedDocument {
  title: string;
  format: WebReadResult["format"];
  lines: ParsedLine[];
  publicationDate?: string;
  modifiedDate?: string;
  totalPages?: number;
  readPages?: number;
  truncated: boolean;
  limitations: string[];
  links?: { text: string; url: string }[];
}
interface ParserInput {
  purpose: "web-reader-parse";
  bytes: Uint8Array;
  contentType: string;
  url: string;
  page?: number;
  maxTextChars: number;
  maxPdfPages: number;
}
const fields = new Set(["url", "find", "startLine", "lineCount", "page", "dateFrom", "dateTo"]);
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_LINE_CHARS = 1000;
const MAX_OUTPUT_CHARS = 20_000;

function readParameters(value: WebReadRequest) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((field) => !fields.has(field)))
    throw new Error("读取参数必须使用 WebReadRequest 的字段");
  if (typeof value.url !== "string" || !value.url || value.url.length > 2048) throw new Error("读取 url 必须为有效 HTTP(S) 地址");
  publicUrl(value.url);
  if (value.find !== undefined && (typeof value.find !== "string" || !value.find.trim() || value.find.length > 200))
    throw new Error("读取 find 必须为 1—200 个字符的文本，不是正则表达式");
  for (const [name, maximum] of [["startLine", 100_000], ["lineCount", 200], ["page", 1000]] as const) {
    const number = value[name];
    if (number !== undefined && (!Number.isInteger(number) || number < 1 || number > maximum))
      throw new Error(`读取 ${name} 必须为 1—${maximum} 的整数`);
  }
  validateDateRange(value.dateFrom, value.dateTo);
  return { ...value, lineCount: value.lineCount ?? 80 };
}

function publicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("读取 url 必须为有效 HTTP(S) 地址"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    (url.port && url.port !== "80" && url.port !== "443") || !hostname ||
    /(^|\.)(localhost|local|internal)$/.test(hostname) || hostname.endsWith(".home.arpa") ||
    (!isIP(hostname) && !hostname.includes("."))) throw new Error("读取只允许公共 HTTP(S) 地址与 80/443 端口");
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error("读取地址不能指向私有、保留或本机网络");
  url.hash = "";
  return url;
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes("%")) return false;
  const first = parseInt(address.split(":")[0] || "0", 16);
  // Only global unicast; excludes mapped IPv4, NAT64, local, multicast and reserved ranges.
  if (first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
  const second = parseInt(address.split(":")[1] || "0", 16);
  if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
  if (first === 0x3fff && second < 0x1000) return false; // documentation prefix 3fff::/20
  return true;
}

export async function defaultDownload(url: URL, address: ResolvedAddress, signal: AbortSignal, accept?: string): Promise<WebDownload> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      signal,
      headers: {
        "User-Agent": "ErisEvidenceReader",
        Accept: accept ?? "text/html,application/pdf,text/plain,application/xhtml+xml;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      // Preserve hostname for HTTP Host and TLS SNI while pinning the validated address.
      agent: false,
    }, (response) => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: response, destroy: () => response.destroy() }));
    request.once("error", reject);
    request.end();
  });
}

function networkErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UNKNOWN";
}

/** Resolve non-public local DNS answers independently, then validate and pin the public replacement. */
async function defaultPublicLookup(hostname: string, callerSignal: AbortSignal,download:NonNullable<WebReaderOptions['download']>=defaultDownload): Promise<ResolvedAddress[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  try {
    const answers = await Promise.all([1, 28].map(async (type) => {
      const url = new URL("https://cloudflare-dns.com/dns-query");
      url.searchParams.set("name", hostname);
      url.searchParams.set("type", type === 1 ? "A" : "AAAA");
      const response = await download(url, { address: "1.1.1.1", family: 4 }, signal, "application/dns-json");
      if (response.statusCode !== 200) { response.destroy?.(); throw new Error("读取公共 DNS 核验失败"); }
      const bytes = await collectBody(response, 64 * 1024, signal);
      let json: unknown;
      try { json = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("读取公共 DNS 核验响应无效"); }
      if (!json || typeof json !== "object" || (json as Record<string, unknown>).Status !== 0)
        throw new Error("读取公共 DNS 核验失败");
      const items = (json as Record<string, unknown>).Answer;
      if (items === undefined) return [];
      if (!Array.isArray(items)) throw new Error("读取公共 DNS 核验响应无效");
      return items.filter((item): item is { type: number; data: string } => !!item && typeof item === "object" && item.type === type)
        .map((item) => {
          const family = type === 1 ? 4 : 6;
          if (typeof item.data !== "string" || isIP(item.data) !== family) throw new Error("读取公共 DNS 核验响应无效");
          return { address: item.data, family };
        });
    }));
    return answers.flat();
  } finally { clearTimeout(timeout); controller.abort(); }
}

async function collectBody(response: WebDownload, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers["content-length"];
  if (typeof length === "string" && Number(length) > maximum) {
    response.destroy?.(); throw new Error("读取响应超过 15 MiB 大小限制");
  }
  let encodedBytes = 0;
  const source = Readable.from((async function* () {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      encodedBytes += chunk.byteLength;
      if (encodedBytes > maximum) throw new Error("读取响应超过 15 MiB 大小限制");
      yield chunk;
    }
  })());
  const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  const decompressor = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : undefined;
  if (encoding !== "identity" && !decompressor) {
    source.destroy(); response.destroy?.(); throw new Error("读取响应的压缩编码不受支持");
  }
  const stream = decompressor ? source.pipe(decompressor) : source;
  // pipe does not forward source errors automatically.
  if (decompressor) source.on("error", (error) => decompressor.destroy(error));
  const abort = () => { source.destroy(new Error("读取已取消")); stream.destroy(new Error("读取已取消")); response.destroy?.(); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > maximum) throw new Error("读取解压后的响应超过 15 MiB 大小限制");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    signal.removeEventListener("abort", abort);
    source.destroy(); stream.destroy(); response.destroy?.();
  }
}

function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name]; return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function decodeText(bytes: Uint8Array, contentType: string): string {
  let encoding = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  if (!encoding) {
    const beginning = Buffer.from(bytes.subarray(0, 4096)).toString("ascii");
    encoding = /<meta[^>]+charset\s*=\s*["']?([^\s;"'/>]+)/i.exec(beginning)?.[1] ?? "utf-8";
  }
  try { return new TextDecoder(encoding).decode(bytes); }
  catch { throw new Error("读取响应的文字编码不受支持"); }
}

function normalizeLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[\t\u00a0 ]+/g, " ").trim()).filter(Boolean);
}

function bodyLinks(content: Element, baseUrl: string): { links: { text: string; url: string }[]; limited: boolean } {
  const seen = new Set<string>();
  const links: { text: string; url: string; priority: number; index: number }[] = [];
  for (const anchor of content.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href?.trim()) continue;
    let url: URL;
    try { url = publicUrl(new URL(href, baseUrl).href); } catch { continue; }
    if (url.href.length > 2048 || seen.has(url.href) || url.href === publicUrl(baseUrl).href) continue;
    seen.add(url.href);
    const text = [anchor.textContent, anchor.getAttribute("aria-label"), anchor.getAttribute("title"), anchor.querySelector("img[alt]")?.getAttribute("alt"), url.pathname.split("/").at(-1), url.hostname]
      .map((value) => (value ?? "").replace(/\s+/g, " ").trim()).find(Boolean)!.slice(0, 200);
    const isPdf = /\.pdf(?:$|[?#])/i.test(url.href);
    const isAttachment = /\.(?:xlsx?|csv|docx?)(?:$|[?#])/i.test(url.href) || /(?:download|attachment)/i.test(url.pathname);
    const isFinancial = /(?:annual|financial|statement|report|财务|年报|报告|报表|附件)/i.test(`${text} ${url.pathname}`);
    links.push({ text, url: url.href, priority: isPdf ? 3 : isAttachment ? 2 : isFinancial ? 1 : 0, index: links.length });
  }
  const selected: { text: string; url: string }[] = [];
  let characters = 0;
  for (const { text, url } of links.sort((a, b) => b.priority - a.priority || a.index - b.index)) {
    if (selected.length >= 20 || characters + text.length + url.length > 8000) continue;
    selected.push({ text, url }); characters += text.length + url.length;
  }
  return { links: selected, limited: selected.length < links.length };
}

function boundLines(lines: ParsedLine[], maximum: number): { lines: ParsedLine[]; truncated: boolean } {
  const result: ParsedLine[] = [];
  let characters = 0;
  for (const line of lines) {
    for (let offset = 0; offset < line.text.length;) {
      const remaining = maximum - characters;
      if (remaining <= 0) return { lines: result, truncated: true };
      let length = Math.min(MAX_LINE_CHARS, line.text.length - offset, remaining);
      // Preserve surrogate pairs at deterministic chunk boundaries.
      const end = line.text.charCodeAt(offset + length - 1);
      if (length > 1 && end >= 0xd800 && end <= 0xdbff && offset + length < line.text.length) length--;
      result.push({ ...line, text: line.text.slice(offset, offset + length) });
      characters += length + 1;
      offset += length;
      if (offset < line.text.length && characters >= maximum) return { lines: result, truncated: true };
    }
  }
  return { lines: result, truncated: false };
}

async function htmlDocument(input: ParserInput): Promise<ParsedDocument> {
  const [{ JSDOM }, { Readability }] = await Promise.all([import("jsdom"), import("@mozilla/readability")]);
  const dom = new JSDOM(decodeText(input.bytes, input.contentType), { url: input.url });
  try {
    const document = dom.window.document;
    const meta = (selectors: string[]) => selectors.map((selector) => document.querySelector(selector)?.getAttribute("content")).find((value) => !!parseAbsoluteWebDate(value ?? undefined)) ?? undefined;
    let publicationDate = meta(['meta[property="article:published_time"]', 'meta[name="datePublished"]', 'meta[itemprop="datePublished"]', 'meta[name="pubdate"]']);
    let modifiedDate = meta(['meta[property="article:modified_time"]', 'meta[name="dateModified"]', 'meta[itemprop="dateModified"]']);
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const objects: unknown[] = [JSON.parse(script.textContent ?? "")];
        let count = 0;
        while (objects.length && count++ < 1000) {
          const entry = objects.shift();
          if (Array.isArray(entry)) { objects.push(...entry); continue; }
          if (!entry || typeof entry !== "object") continue;
          const value = entry as Record<string, unknown>;
          const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
          if (type.some((kind) => typeof kind === "string" && /^(Article|NewsArticle|Report|BlogPosting|TechArticle|ScholarlyArticle)$/.test(kind))) {
            if (!publicationDate && typeof value.datePublished === "string" && parseAbsoluteWebDate(value.datePublished)) publicationDate = value.datePublished;
            if (!modifiedDate && typeof value.dateModified === "string" && parseAbsoluteWebDate(value.dateModified)) modifiedDate = value.dateModified;
          }
          if (value["@graph"]) objects.push(value["@graph"]);
          if (value.mainEntity) objects.push(value.mainEntity);
        }
      } catch { /* Malformed site metadata is not evidence of a date. */ }
    }
    const originalTitle = document.title.trim();
    // Respect local CSS while styles still exist; jsdom never runs scripts or loads resources.
    for (const element of document.querySelectorAll("body *")) {
      if (["SCRIPT", "STYLE", "LINK", "META"].includes(element.tagName)) continue;
      const style = dom.window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") element.remove();
    }
    for (const element of document.querySelectorAll('script,style,noscript,template,nav,header,footer,aside,[hidden],[aria-hidden="true"],input,select,button')) element.remove();
    for (const element of document.querySelectorAll('[style]')) {
      if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.getAttribute("style") ?? "")) element.remove();
    }
    let content: Element;
    let title = originalTitle;
    const limitations: string[] = [];
    const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 0 }).parse();
    if (article?.content && article.textContent?.trim()) {
      title = article.title?.trim() || title;
      const extracted = new JSDOM(article.content);
      content = extracted.window.document.body;
    } else {
      content = document.querySelector("article,main,[role='main']") ?? document.body;
      limitations.push("正文识别未成功，返回已移除导航、脚本与显式隐藏元素的页面文本；可能仍含非正文内容。");
    }
    const { links, limited: linksLimited } = bodyLinks(content, input.url);
    if (linksLimited) limitations.push("正文链接最多返回 20 条且文本与地址合计不超过 8000 字符，优先返回 PDF 和财务附件。");
    // DOM textContent joins table cells and paragraphs. Preserve explicit block and row boundaries.
    for (const node of content.querySelectorAll("br")) node.replaceWith("\n");
    for (const row of content.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll(":scope > th,:scope > td")].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim());
      if (cells.length) row.textContent = cells.join(" | ");
    }
    for (const element of content.querySelectorAll("p,div,section,article,h1,h2,h3,h4,h5,h6,li,tr,pre,blockquote,table")) {
      element.prepend("\n"); element.append("\n");
    }
    const bounded = boundLines(normalizeLines(content.textContent ?? "").map((text) => ({ text })), input.maxTextChars);
    if (!bounded.lines.length) throw new Error("读取网页没有可提取正文；页面可能需要 JavaScript 验证、登录或由图片组成");
    if (bounded.lines.some((line) => /\bloading\s+(?:component|content|data|chart|table)\b(?:\s*[.…])?|(?:正在加载(?:组件|内容|数据|图表|表格)|加载中)[.…]/i.test(line.text)))
      limitations.push(`当前静态正文含客户端加载占位，相关内容未加载，无法据此核定缺失数据；${links.length ? "可继续读取返回的报告或附件链接" : "需另查可读取的报告正文或附件"}。`);
    if (bounded.truncated) limitations.push(`正文超过 ${input.maxTextChars} 字符，已截断；后续行不包含在本次结果中。`);
    return { title: title || new URL(input.url).hostname, format: "html", ...bounded, publicationDate, modifiedDate, limitations, ...(links.length ? { links } : {}) };
  } finally { dom.window.close(); }
}

async function pdfDocument(input: ParserInput, signal: AbortSignal): Promise<ParsedDocument> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: input.bytes, disableFontFace: true, useSystemFonts: true, useWorkerFetch: false });
  const abort = () => { void loading.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const document = await loading.promise;
    signal.throwIfAborted();
    if (input.page !== undefined && input.page > document.numPages) throw new Error(`读取 page 超过 PDF 总页数 ${document.numPages}`);
    const pages = input.page === undefined ? Array.from({ length: Math.min(document.numPages, input.maxPdfPages) }, (_, index) => index + 1) : [input.page];
    const lines: ParsedLine[] = [];
    let characters = 0;
    let readPages = 0;
    let emptyPages = 0;
    let truncated = document.numPages > input.maxPdfPages && input.page === undefined;
    for (const pageNumber of pages) {
      signal.throwIfAborted();
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const rows: { y: number; x: number; text: string; width: number }[][] = [];
      const items = text.items.filter((item): item is import("pdfjs-dist/types/src/display/api.js").TextItem => "str" in item)
        .map((item) => ({ y: item.transform[5], x: item.transform[4], text: item.str, width: item.width }))
        .filter((item) => item.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
      for (const item of items) {
        const last = rows.at(-1);
        if (last && Math.abs(last[0].y - item.y) <= 2) last.push(item); else rows.push([item]);
      }
      for (const row of rows) {
        row.sort((a, b) => a.x - b.x);
        const rowText = row.map((item, index) => {
          const previous = row[index - 1];
          const gap = previous ? item.x - previous.x - previous.width : 0;
          return `${index ? gap > 15 ? " | " : " " : ""}${item.text}`;
        }).join("").replace(/\s+/g, " ").trim();
        if (rowText) { lines.push({ text: rowText, page: pageNumber }); characters += rowText.length + 1; }
      }
      readPages++;
      if (!items.length) emptyPages++;
      page.cleanup();
      if (characters >= input.maxTextChars) { truncated = true; break; }
    }
    if (!lines.length) throw new Error("读取 PDF 没有可提取文本；扫描件或图片 PDF 需要 OCR，本工具不执行 OCR");
    const bounded = boundLines(lines, input.maxTextChars);
    truncated ||= bounded.truncated;
    let title = new URL(input.url).pathname.split("/").at(-1) ?? "PDF";
    try { title = decodeURIComponent(title); } catch { /* Preserve a usable URL filename when malformed escapes occur. */ }
    try {
      const metadata = await document.getMetadata();
      const info = metadata.info as Record<string, unknown>;
      if (typeof info.Title === "string" && info.Title.trim()) title = info.Title.trim();
    } catch { /* PDF metadata is optional and creation dates are not publication dates. */ }
    const limitations = ["PDF 文本提取可能丢失列关系、脚注与阅读顺序；核对数值时需结合页码、币种和表头。", "PDF CreationDate/ModDate 不作为公开发布日期，未确认历史可用性。"];
    if (input.page !== undefined) limitations.push(`仅提取 PDF 第 ${input.page} 页，行号从该页第 1 行开始。`);
    if (emptyPages) limitations.push(`${emptyPages} 个已读取页面没有文本层，可能是扫描页。`);
    if (truncated) limitations.push(`PDF 提取受 ${input.maxPdfPages} 页和 ${input.maxTextChars} 字符上限约束；尚有内容未返回。`);
    return { title: title || "PDF", format: "pdf", lines: bounded.lines, totalPages: document.numPages, readPages, truncated, limitations };
  } finally {
    signal.removeEventListener("abort", abort);
    await loading.destroy();
  }
}

async function parseDocument(input: ParserInput, signal: AbortSignal): Promise<ParsedDocument> {
  const beginning = Buffer.from(input.bytes.subarray(0, 512)).toString("ascii");
  if (beginning.startsWith("%PDF-") || /application\/pdf/i.test(input.contentType)) return pdfDocument(input, signal);
  if (input.page !== undefined) throw new Error("读取 page 只适用于 PDF");
  if (/text\/html|application\/xhtml\+xml/i.test(input.contentType) || /^\s*(<!doctype\s+html|<html\b)/i.test(beginning)) return htmlDocument(input);
  if (!/^text\/plain(?:\s*;|$)/i.test(input.contentType)) throw new Error("读取只支持 HTML、PDF 和 text/plain，响应格式不受支持");
  const bounded = boundLines(normalizeLines(decodeText(input.bytes, input.contentType)).map((text) => ({ text })), input.maxTextChars);
  if (!bounded.lines.length) throw new Error("读取响应没有可提取正文；该地址不是可解析的正文页，改用 PDF 或另一域名原文");
  return { title: new URL(input.url).hostname, format: "text", ...bounded, limitations: bounded.truncated ? [`正文超过 ${input.maxTextChars} 字符，已截断。`] : [] };
}

async function parseInWorker(input: ParserInput, signal: AbortSignal): Promise<ParsedDocument> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: input, transferList: [input.bytes.buffer as ArrayBuffer],
      // File workers cannot inherit --input-type from CLI probes or duplicate inspector listeners.
      execArgv: [],
    });
    let settled = false;
    const finish = (error?: Error, result?: ParsedDocument) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { worker.postMessage({ cancel: true }); finish(new Error("读取已取消")); };
    signal.addEventListener("abort", abort, { once: true });
    worker.once("message", (value: { result?: ParsedDocument; error?: string }) => {
      if (value.error) finish(new Error(value.error)); else finish(undefined, value.result);
    });
    worker.once("error", () => finish(new Error("读取正文解析失败")));
    worker.once("exit", () => { if (!settled) finish(new Error("读取正文解析意外中止")); });
  });
}

// Keep parsing in a cancellable worker: synchronous DOM work must obey the same deadline as networking.
if (!isMainThread && workerData?.purpose === "web-reader-parse") {
  const controller = new AbortController();
  parentPort!.on("message", (value: { cancel?: boolean }) => { if (value.cancel) controller.abort(); });
  try { parentPort!.postMessage({ result: await parseDocument(workerData as ParserInput, controller.signal) }); }
  catch (error) {
    const message = error instanceof Error && error.message.startsWith("读取") ? error.message : "读取正文解析失败；文档可能加密、损坏或格式不受支持";
    parentPort!.postMessage({ error: message });
  }
}

export function createWebReader(options: WebReaderOptions = {}): WebReader {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxTextChars = options.maxTextChars ?? 500_000;
  const maxPdfPages = options.maxPdfPages ?? 200;
  for (const [key, value, maximum] of [["timeoutMs", timeoutMs, 30_000], ["maxBytes", maxBytes, MAX_BYTES], ["maxTextChars", maxTextChars, 500_000], ["maxPdfPages", maxPdfPages, 200]] as const)
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`读取 ${key} 必须为 1—${maximum} 的整数`);
  const lookup = options.lookup ?? ((hostname: string) => lookupDns(hostname, { all: true, verbatim: true }));
  const download = options.download ?? defaultDownload;
  const publicLookup = options.publicLookup ?? (options.lookup ? undefined : (hostname:string,signal:AbortSignal)=>defaultPublicLookup(hostname,signal,download));
  return {
    async read(request, callerSignal) {
      const parameters = readParameters(request);
      callerSignal.throwIfAborted();
      const started = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      callerSignal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let abortListener: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error(timedOut ? "读取超时，请缩小到指定 PDF 页或更精确的资料" : "读取已取消"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      try {
        return await Promise.race([cancelled, (async () => {
          let url = publicUrl(parameters.url);
          for (let hop = 0; hop <= 4; hop++) {
            controller.signal.throwIfAborted();
            const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
            let addresses: ResolvedAddress[];
            try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname); }
            catch (error) { throw new Error(`读取公共地址 DNS 解析失败（${hostname}，${networkErrorCode(error)}）`); }
            controller.signal.throwIfAborted();
            if (publicLookup && !isIP(hostname) && addresses.some((address) => !publicAddress(address.address))) {
              try { addresses = await publicLookup(hostname, controller.signal); }
              catch { throw new Error(`读取本机 DNS 返回非公网地址，公共 DNS 核验失败（${hostname}）`); }
              controller.signal.throwIfAborted();
            }
            if (!addresses.length || addresses.some((address) => !publicAddress(address.address) || isIP(address.address) !== address.family))
              throw new Error("读取 DNS 不能指向私有、保留或本机网络");
            let response: WebDownload | undefined;
            const errors = new Set<string>();
            for (const address of addresses) {
              controller.signal.throwIfAborted();
              try { options.beforeRequest?.(url.toString()); response = await download(url, address, controller.signal); break; }
              catch (error) { controller.signal.throwIfAborted(); errors.add(networkErrorCode(error)); }
            }
            if (!response) throw new Error(`读取公共网页网络请求失败（${hostname}，${[...errors].join("、")}）`);
            if (controller.signal.aborted) { response.destroy?.(); controller.signal.throwIfAborted(); }
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
              response.destroy?.();
              if (hop === 4) throw new Error("读取重定向超过 4 次限制");
              const location = header(response.headers, "location");
              if (!location) throw new Error("读取重定向缺少目标地址");
              url = publicUrl(new URL(location, url).href);
              continue;
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
              response.destroy?.(); throw new Error(`读取失败（HTTP ${response.statusCode}），网页可能限制访问或已失效`);
            }
            const contentType = header(response.headers, "content-type");
            const bytes = await collectBody(response, maxBytes, controller.signal);
            if (!bytes.length) throw new Error("读取响应没有正文");
            const parsed = await parseInWorker({ purpose: "web-reader-parse", bytes: new Uint8Array(bytes), contentType, url: url.href, page: parameters.page, maxTextChars, maxPdfPages }, controller.signal);
            controller.signal.throwIfAborted();
            const allLines = parsed.lines.map((line, index) => ({ number: index + 1, ...line }));
            const matches = parameters.find ? allLines.filter((line) => line.text.toLocaleLowerCase().includes(parameters.find!.toLocaleLowerCase())).slice(0, 20).map((line) => {
              const start = Math.max(0, line.text.toLocaleLowerCase().indexOf(parameters.find!.toLocaleLowerCase()) - 80);
              return { line: line.number, ...(line.page !== undefined ? { page: line.page } : {}), preview: line.text.slice(start, start + 250) };
            }) : [];
            // Financial PDF values need their page's units and column headers, often more than five lines away.
            const firstMatch = matches[0];
            const matchPageStart = firstMatch?.page === undefined ? undefined : allLines.find((line) => line.page === firstMatch.page)?.number;
            const startLine = parameters.startLine ?? (matchPageStart ?? (firstMatch ? Math.max(1, firstMatch.line - 5) : 1));
            if (startLine > allLines.length) throw new Error(`读取 startLine 超过本次可提取的 ${allLines.length} 行`);
            const lines: WebReadResult["lines"] = [];
            let outputChars = 0;
            for (const line of allLines.slice(startLine - 1, startLine - 1 + parameters.lineCount)) {
              if (outputChars + line.text.length > MAX_OUTPUT_CHARS) break;
              lines.push(line); outputChars += line.text.length;
            }
            const end = lines.at(-1)!.number;
            const limitations = [...parsed.limitations];
            if (firstMatch && !lines.some((line) => line.number === firstMatch.line))
              limitations.push(`匹配行 ${firstMatch.line} 未包含在本次窗口；请使用 startLine=${Math.max(1, firstMatch.line - 5)} 读取匹配上下文，并结合当前页首单位与表头核对。`);
            if (parsed.title.length > 500) limitations.push("标题超过 500 字符，标题字段已截断。");
            if (lines.length < Math.min(parameters.lineCount, allLines.length - startLine + 1))
              limitations.push(`本次正文窗口最多 ${MAX_OUTPUT_CHARS} 字符，使用 nextStartLine 继续读取；每行最多 ${MAX_LINE_CHARS} 字符。`);
            return {
              requestedUrl: parameters.url, url: url.href, title: parsed.title.slice(0, 500), format: parsed.format,
              retrievedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
              ...(parsed.publicationDate ? { publicationDate: parseAbsoluteWebDate(parsed.publicationDate) } : {}),
              ...(parsed.modifiedDate ? { modifiedDate: parseAbsoluteWebDate(parsed.modifiedDate) } : {}),
              dateAssessment: assessWebDate(parsed.publicationDate, "page_metadata", parameters.dateFrom, parameters.dateTo),
              lines, matches, totalLines: allLines.length,
              ...(parsed.totalPages !== undefined ? { totalPages: parsed.totalPages, readPages: parsed.readPages } : {}),
              ...(end < allLines.length ? { nextStartLine: end + 1 } : {}),
              truncated: parsed.truncated || end < allLines.length || startLine > 1,
              limitations,
              ...(parsed.links ? { links: parsed.links } : {}),
            } satisfies WebReadResult;
          }
          throw new Error("读取重定向失败");
        })()]);
      } catch (error) {
        if (callerSignal.aborted) throw new Error("读取已取消");
        if (timedOut) throw new Error("读取超时，请缩小到指定 PDF 页或更精确的资料");
        if (error instanceof Error && error.message.startsWith("读取")) throw error;
        throw new Error("读取公共网页失败");
      } finally {
        clearTimeout(timeout);
        callerSignal.removeEventListener("abort", abort);
        if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      }
    },
  };
}
