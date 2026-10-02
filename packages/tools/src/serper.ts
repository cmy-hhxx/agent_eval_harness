import type { WebSearchAttempt, WebSearchItem, WebSearchProvider, WebSearchQuery, WebSearchRequest, WebSearchResult } from "@eval/contracts";
import { assessWebDate, parseAbsoluteWebDate, shiftWebDate, validateDateRange } from "./web-date.js";

export interface SerperSearchOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const timeFilters = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
const requestFields = new Set(["queries", "category", "timeRange", "dateFrom", "dateTo", "limit"]);
const queryFields = new Set(["query", "domains", "country", "language", "page"]);
const domainPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const trackingParameters = new Set(["gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "igshid"]);
interface QueryParameters extends WebSearchQuery { searchQuery: string; country: string; language: string; page: number }
interface ResponseItem { title: string; url: string; domain: string; snippet?: string; position: number; date?: string; source?: string; truncatedFields?: string[] }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requestParameters(request: WebSearchRequest) {
  if (!record(request) || Object.keys(request).some((key) => !requestFields.has(key)))
    throw new Error("搜索参数必须使用 WebSearchRequest 的字段");
  if (!Array.isArray(request.queries) || request.queries.length < 1 || request.queries.length > 4)
    throw new Error("搜索 queries 必须包含 1—4 条查询");
  const category = request.category ?? "web";
  if (request.category !== undefined && request.category !== "web" && request.category !== "news") throw new Error("搜索 category 必须为 web 或 news");
  const limit = request.limit === undefined ? 10 : request.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("搜索 limit 必须为 1—20 的整数");
  if (request.timeRange !== undefined && (typeof request.timeRange !== "string" || !Object.hasOwn(timeFilters, request.timeRange)))
    throw new Error("搜索 timeRange 必须为 day、week、month 或 year");
  validateDateRange(request.dateFrom, request.dateTo);
  if (request.timeRange !== undefined && (request.dateFrom !== undefined || request.dateTo !== undefined))
    throw new Error("搜索 timeRange 与 dateFrom/dateTo 不能同时使用");
  const unique = new Set<string>();
  const queries = request.queries.map((value, index): QueryParameters => {
    if (!record(value) || Object.keys(value).some((key) => !queryFields.has(key))) throw new Error(`搜索 queries[${index}] 字段无效`);
    if (typeof value.query !== "string" || !value.query.trim() || value.query.length > 500) throw new Error("搜索 query 必须为 1—500 个字符");
    if (value.country !== undefined && (typeof value.country !== "string" || !/^[a-z]{2}$/.test(value.country))) throw new Error("搜索 country 必须为两位国家代码");
    if (value.language !== undefined && (typeof value.language !== "string" || !/^[a-z]{2}(-[a-z]{2})?$/.test(value.language))) throw new Error("搜索 language 必须为语言代码，例如 zh-cn 或 en");
    const page = value.page === undefined ? 1 : value.page;
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > 3) throw new Error("搜索 page 必须为 1—3 的整数");
    let domains: string[] | undefined;
    if (value.domains !== undefined) {
      if (!Array.isArray(value.domains) || value.domains.length < 1 || value.domains.length > 5 || value.domains.some((domain) => typeof domain !== "string" || domain.length > 253 || !domainPattern.test(domain)))
        throw new Error("搜索 domains 必须为 1—5 个主机名，不能含协议、端口或路径");
      domains = value.domains.map((domain) => domain.toLowerCase());
      if (new Set(domains).size !== domains.length) throw new Error("搜索 domains 不能重复");
    }
    const query = value.query.trim();
    const country = value.country as string | undefined ?? "cn";
    const language = value.language as string | undefined ?? "zh-cn";
    const identity = JSON.stringify([query, [...(domains ?? [])].sort(), country, language, page]);
    if (unique.has(identity)) throw new Error("搜索 queries 不能包含规范化后重复的请求");
    unique.add(identity);
    let searchQuery = query;
    if (domains) searchQuery += ` (${domains.map((domain) => `site:${domain}`).join(" OR ")})`;
    if (request.dateFrom) searchQuery += ` after:${shiftWebDate(request.dateFrom, -1)}`;
    if (request.dateTo) searchQuery += ` before:${shiftWebDate(request.dateTo, 1)}`;
    return { query, searchQuery, ...(domains ? { domains } : {}), country, language, page: page as number };
  });
  return { queries, category, limit, timeRange: request.timeRange, dateFrom: request.dateFrom, dateTo: request.dateTo };
}

function responseItem(value: unknown, path: string, index: number): ResponseItem {
  if (!record(value) || typeof value.title !== "string" || !value.title.trim() || typeof value.link !== "string")
    throw new Error(`Serper 响应结构无效：${path} 缺少有效 title 或 link`);
  let url: URL;
  try { url = new URL(value.link); }
  catch { throw new Error(`Serper 响应结构无效：${path}.link 必须为 HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error(`Serper 响应结构无效：${path}.link 必须为 HTTP(S) URL`);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || trackingParameters.has(key.toLowerCase())) url.searchParams.delete(key);
  if (url.href.length > 4096) throw new Error(`Serper 响应结构无效：${path}.link 过长`);
  const result: ResponseItem = { title: value.title.slice(0, 500), url: url.toString(), domain: url.hostname.toLowerCase(), position: index + 1 };
  const truncatedFields: string[] = value.title.length > 500 ? ["title"] : [];
  for (const field of ["snippet", "date", "source"] as const) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== "string") throw new Error(`Serper 响应结构无效：${path}.${field} 必须为字符串`);
      const maximum = { snippet: 2000, date: 100, source: 200 }[field];
      result[field] = value[field].slice(0, maximum);
      if (value[field].length > maximum) truncatedFields.push(field);
    }
  }
  if (value.position !== undefined) {
    if (!Number.isInteger(value.position) || (value.position as number) < 1) throw new Error(`Serper 响应结构无效：${path}.position 必须为正整数`);
    result.position = value.position as number;
  }
  if (truncatedFields.length) result.truncatedFields = truncatedFields;
  return result;
}

async function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Serper 响应不是有效 JSON");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Serper 搜索已取消");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) throw new Error("Serper 响应超过 1 MiB 大小限制");
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Serper 响应不是有效 JSON"); }
  } catch (error) {
    if (error instanceof Error && error.message === "Serper 响应超过 1 MiB 大小限制") throw error;
    throw new Error("Serper 响应不是有效 JSON");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function responseResults(value: unknown, category: "web" | "news") {
  if (!record(value)) throw new Error("Serper 响应结构无效：需要 JSON 对象");
  if (value.error !== undefined || value.message !== undefined) throw new Error("Serper 返回搜索错误；请检查 SEARCH_API_KEY、账户余额和请求参数");
  const field = category === "web" ? "organic" : "news";
  if (!Array.isArray(value[field])) throw new Error(`Serper 响应结构无效：${field} 必须为数组`);
  const results = value[field].map((item, index) => responseItem(item, `${field}[${index}]`, index)).slice(0, 10);
  if (value.credits !== undefined && (typeof value.credits !== "number" || !Number.isFinite(value.credits) || value.credits < 0)) throw new Error("Serper 响应结构无效：credits 必须为非负数");
  return { results, ...(value.credits !== undefined ? { credits: value.credits as number } : {}) };
}

function httpError(status: number): Error {
  const hint = status === 401 || status === 403 ? "；请检查 SEARCH_API_KEY" : status === 402 ? "；请检查 Serper 账户余额" : status === 429 ? "；请求频率或账户额度受限" : "";
  return new Error(`Serper 搜索失败（HTTP ${status}）${hint}`);
}

export function createSerperSearch(options: SerperSearchOptions = {}): WebSearchProvider {
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiKey = options.apiKey?.trim();
  const timeoutMs = options.timeoutMs ?? 25_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Serper timeoutMs 必须为正数");
  return {
    async search(request, signal): Promise<WebSearchResult> {
      const parameters = requestParameters(request);
      if (!apiKey) throw new Error("尚未配置 SEARCH_API_KEY，无法使用 Serper 搜索");
      if (signal.aborted) throw new Error("Serper 搜索已取消");
      const startedAt = Date.now();
      const attempts: WebSearchAttempt[] = new Array(parameters.queries.length);
      const responses: ResponseItem[][] = new Array(parameters.queries.length);
      async function runQuery(queryIndex: number): Promise<void> {
        const query = parameters.queries[queryIndex];
        const start = Date.now();
        const controller = new AbortController();
        let timedOut = false;
        let rejectAbort!: (reason: Error) => void;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const cancel = () => {
          controller.abort();
          rejectAbort(new Error(timedOut ? `Serper 搜索超时（${timeoutMs} ms）` : "Serper 搜索已取消"));
        };
        signal.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
        try {
          if (signal.aborted) cancel();
          const response = await Promise.race([Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new Error("Serper 搜索已取消");
            return fetcher(`https://google.serper.dev/${parameters.category === "web" ? "search" : "news"}`, {
              method: "POST", redirect: "error", headers: { "X-API-KEY": apiKey!, "Content-Type": "application/json" },
              body: JSON.stringify({ q: query.searchQuery, gl: query.country, hl: query.language, num: 10, page: query.page,
                ...(parameters.timeRange ? { tbs: timeFilters[parameters.timeRange] } : {}) }), signal: controller.signal,
            });
          }).catch(() => {
            if (controller.signal.aborted) throw new Error(timedOut ? `Serper 搜索超时（${timeoutMs} ms）` : "Serper 搜索已取消");
            throw new Error("Serper 搜索网络请求失败");
          }), aborted]);
          if (!response.ok) throw httpError(response.status);
          const body = await Promise.race([readResponseJson(response, controller.signal), aborted]);
          const normalized = responseResults(body, parameters.category);
          attempts[queryIndex] = { ...query, queryIndex, state: "succeeded", resultCount: normalized.results.length, elapsedMs: Date.now() - start,
            ...(normalized.credits !== undefined ? { credits: normalized.credits } : {}) };
          responses[queryIndex] = normalized.results.filter((item) => !query.domains || query.domains.some((domain) => item.domain === domain || item.domain.endsWith(`.${domain}`)));
        } catch (error) {
          if (signal.aborted) throw new Error("Serper 搜索已取消");
          attempts[queryIndex] = { ...query, queryIndex, state: "failed", resultCount: 0, elapsedMs: Date.now() - start,
            error: error instanceof Error ? error.message : "Serper 搜索失败" };
          responses[queryIndex] = [];
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
        }
      }
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(2, parameters.queries.length) }, async () => {
        while (next < parameters.queries.length) {
          if (signal.aborted) throw new Error("Serper 搜索已取消");
          await runQuery(next++);
        }
      }));
      if (signal.aborted) throw new Error("Serper 搜索已取消");
      if (attempts.every((attempt) => attempt.state === "failed"))
        throw new Error(`Serper 全部搜索失败：${attempts.map((attempt) => `查询 ${attempt.queryIndex + 1}：${attempt.error}`).join("；")}`);
      const merged = new Map<string, { item: WebSearchItem; score: number; order: number; dates: Set<string> }>();
      for (const [queryIndex, rows] of responses.entries()) {
        const uniqueRows = new Map<string, ResponseItem>();
        for (const row of rows) {
          const prior = uniqueRows.get(row.url);
          if (!prior || row.position < prior.position) uniqueRows.set(row.url, row);
        }
        for (const row of uniqueRows.values()) {
          let entry = merged.get(row.url);
          if (!entry) {
            const { position: _position, ...fields } = row;
            entry = { item: { ...fields, rank: 0, matches: [], dateAssessment: { status: "not_requested", basis: "none" } }, score: 0, order: merged.size, dates: new Set() };
            merged.set(row.url, entry);
          }
          entry.item.matches.push({ queryIndex, position: row.position, page: attempts[queryIndex].page });
          entry.score += 1 / (60 + row.position);
          const date = parseAbsoluteWebDate(row.date);
          if (date) entry.dates.add(date);
        }
      }
      const sorted = [...merged.values()].sort((a, b) => b.score - a.score || a.order - b.order);
      const results: WebSearchItem[] = [];
      const excludedResults: WebSearchItem[] = [];
      for (const [index, entry] of sorted.entries()) {
        entry.item.rank = index + 1;
        entry.item.dateAssessment = assessWebDate(entry.dates.size === 1 ? [...entry.dates][0] : undefined, "search_metadata", parameters.dateFrom, parameters.dateTo);
        (entry.item.dateAssessment.status === "outside_range" ? excludedResults : results).push(entry.item);
      }
      const knownCredits = attempts.flatMap((attempt) => attempt.credits === undefined ? [] : [attempt.credits]);
      return { provider: "serper", category: parameters.category, searchedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt,
        ...(parameters.timeRange ? { timeRange: parameters.timeRange } : {}), ...(parameters.dateFrom ? { dateFrom: parameters.dateFrom } : {}),
        ...(parameters.dateTo ? { dateTo: parameters.dateTo } : {}), attempts, results: results.slice(0, parameters.limit), excludedResults,
        totalUnique: merged.size, hasMore: results.length > parameters.limit,
        ...(knownCredits.length ? { credits: knownCredits.reduce((sum, credit) => sum + credit, 0) } : {}),
        creditsComplete: attempts.every((attempt) => attempt.state === "succeeded" && attempt.credits !== undefined) };
    },
  };
}
