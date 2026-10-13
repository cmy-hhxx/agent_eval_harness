import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import type { WebReadRequest } from "@eval/contracts";
import { createWebReader, type WebReaderOptions } from "./web-reader.js";

const signal = () => new AbortController().signal;
const address = { address: "93.184.216.34", family: 4 };
type Download = NonNullable<WebReaderOptions["download"]>;
function body(bytes: string | Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield typeof bytes === "string" ? Buffer.from(bytes) : bytes; })();
}
function reader(bytes: string | Uint8Array, type = "text/html", options: WebReaderOptions = {}) {
  return createWebReader({ lookup: async () => [address], download: async () => ({ statusCode: 200, headers: { "content-type": type }, body: body(bytes) }), ...options });
}
const html = `<!doctype html><html><head><title>Financial announcement</title>
  <meta property="article:published_time" content="2024-07-12T10:00:00+08:00">
  <meta property="article:modified_time" content="2026-01-01T11:00:00Z"><style>.secret {display:none}</style></head><body>
  <nav>DO NOT USE NAVIGATION AS EVIDENCE</nav><script>throw new Error('NEVER EXECUTE SCRIPT')</script>
  <main><h1>Half-year financial statistics</h1><p>广义货币 M2 余额 305.02 万亿元，同比 6.2%。</p>
  <p hidden>FAKE HIDDEN NUMBER 9999</p><p style="display:none">FAKE INLINE HIDDEN NUMBER 8888</p>
  <p aria-hidden="true">FAKE ARIA HIDDEN NUMBER 7777</p>
  <p class="secret">FAKE CSS HIDDEN NUMBER 6666</p>
  <p>Reporting period: June 2024. All figures at period end.</p>
  <table><thead><tr><th>Period</th><th>USD million</th></tr></thead><tbody><tr><td>FY2024</td><td>391035</td></tr></tbody></table>
  <p>Financial ratios require their denominator and reporting period.</p></main><footer>FOOTER NAV</footer></body></html>`;

test("web reader extracts real HTML text, tables and distinct publication metadata", async () => {
  const result = await reader(html).read({ url: "https://example.com/reports/2024", dateTo: "2024-12-31" }, signal());
  assert.equal(result.format, "html");
  assert.equal(result.publicationDate, "2024-07-12");
  assert.equal(result.modifiedDate, "2026-01-01");
  assert.deepEqual(result.dateAssessment, { status: "within_range", basis: "page_metadata", date: "2024-07-12" });
  const text = result.lines.map((line) => line.text).join("\n");
  assert.match(text, /305\.02/);
  assert.match(text, /Period \| USD million/);
  assert.match(text, /FY2024 \| 391035/);
  assert.doesNotMatch(text, /FAKE|NAVIGATION|NEVER EXECUTE|FOOTER/);
  assert.deepEqual(result.lines.map((line) => line.number), result.lines.map((_, index) => index + 1));
  assert.equal(result.totalLines, result.lines.length);
  assert.equal(result.truncated, false);
  assert.equal(new Date(result.retrievedAt).toISOString(), result.retrievedAt);
});

test("web reader never infers publication date from reporting year, URL or Last-Modified", async () => {
  const source = `<html><head><title>2024 financial report</title></head><body><article><h1>2024 financial report</h1><p>Profit for 2024 was 18 million. January 2025 revision.</p></article></body></html>`;
  const result = await reader(source, "text/html", {
    download: async () => ({ statusCode: 200, headers: { "content-type": "text/html", "last-modified": "Fri, 12 Jul 2024 10:00:00 GMT" }, body: body(source) }),
  }).read({ url: "https://example.com/2024/07/12/report", dateTo: "2024-12-31" }, signal());
  assert.equal(result.publicationDate, undefined);
  assert.equal(result.modifiedDate, undefined);
  assert.deepEqual(result.dateAssessment, { status: "unknown", basis: "none" });
});

test("web reader marks documents published after a historical cutoff as outside_range", async () => {
  const result = await reader(html).read({ url: "https://example.com/report", dateTo: "2024-06-30" }, signal());
  assert.equal(result.dateAssessment.status, "outside_range");
  assert(result.lines.some((line) => line.text.includes("305.02")), "dates must remain an assessment, not silently hide readable evidence");
});

test("web reader accepts Article JSON-LD publication dates while ignoring unrelated WebPage dates", async () => {
  const source = `<html><head><script type="application/ld+json">{"@graph":[{"@type":"WebPage","datePublished":"2020-01-01"},{"@type":"NewsArticle","datePublished":"2025-02-28","dateModified":"2026-01-02"}]}</script></head><body><article><p>Verified factual text, values 10 and 20.</p></article></body></html>`;
  const result = await reader(source).read({ url: "https://example.com/report", dateFrom: "2025-01-01" }, signal());
  assert.equal(result.publicationDate, "2025-02-28");
  assert.equal(result.modifiedDate, "2026-01-02");
});

test("web reader exposes real body attachment links and reports unloaded client components", async () => {
  const source = `<html><head><title>Forecast landing page</title></head><body><nav><a href="/navigation.pdf">Navigation file</a></nav><article>
    <h1>World Economic Outlook</h1><p>Global growth forecasts require the forecast table and its reporting date. Loading component...</p>
    <p>The full underlying report and its appendices are available from the following publication links.</p>
    <p><a href="../files/forecast.pdf">Forecast report PDF</a> <a href="https://reports.example.com/data.xlsx">Forecast data</a></p>
    <p><a href="javascript:alert(1)">Bad script</a> <a href="https://user:password@example.com/private.pdf">Bad credentials</a>
    <a href="http://127.0.0.1/secrets.pdf">Bad local</a> <a href="https://example.com:8443/private.pdf">Bad port</a>
    <a href="https://example.com/${"a".repeat(2100)}.pdf">Too long</a> <a href="mailto:reports@example.com">Email</a></p>
    <script>const invented = '<a href="https://example.com/invented.pdf">Invented report</a>';</script>
  </article></body></html>`;
  const result = await reader(source).read({ url: "https://example.com/publications/landing" }, signal());
  assert.deepEqual(result.links, [
    { text: "Forecast report PDF", url: "https://example.com/files/forecast.pdf" },
    { text: "Forecast data", url: "https://reports.example.com/data.xlsx" },
  ]);
  assert.match(result.limitations.join(""), /客户端加载占位.*无法据此核定缺失数据/);
  assert(result.lines.some((line) => line.text.includes("Loading component")));
});

test("web reader caps body links and favors financial attachments over generic links", async () => {
  const generic = Array.from({ length: 25 }, (_, index) => `<p>Additional source context for this publication. <a href="/topic-${index}">Topic ${index}</a></p>`).join("");
  const source = `<html><body><article><h1>Financial release</h1><p>Read the attached statements to verify annual revenue and reporting period.</p>${generic}
    <p>The authoritative financial report: <a href="/reports/fy2024.pdf">${"Financial statements ".repeat(30)}</a></p>
    <p>The data appendix: <a href="/data.xlsx">Financial data workbook</a></p><p><a href="/reports/fy2024.pdf">Duplicate file</a></p>
  </article></body></html>`;
  const result = await reader(source).read({ url: "https://example.com/release" }, signal());
  assert.equal(result.links?.length, 20);
  assert.equal(result.links![0].url, "https://example.com/reports/fy2024.pdf");
  assert(result.links![0].text.length <= 200);
  assert.equal(result.links![1].url, "https://example.com/data.xlsx");
  assert.equal(new Set(result.links!.map((link) => link.url)).size, 20);
});

test("web reader independently bounds the combined URL and label budget of returned links", async () => {
  const links = Array.from({ length: 6 }, (_, index) => `<p>Independent financial attachment for the reporting period. <a href="/files/${index}-${"a".repeat(1600)}.pdf">Financial report ${index}</a></p>`).join("");
  const source = `<html><body><article><h1>Annual financial release</h1><p>The following files contain financial statements and detailed reporting data.</p>${links}</article></body></html>`;
  const result = await reader(source).read({ url: "https://example.com/release" }, signal());
  assert(result.links && result.links.length > 0 && result.links.length < 6);
  assert(result.links.reduce((total, link) => total + link.url.length + link.text.length, 0) <= 8000);
  assert(result.links.every((link) => link.url.length <= 2048 && link.text.length <= 200));
  assert.match(result.limitations.join(""), /8000 字符/);
});

test("web reader provides stable line windows and literal case-insensitive find with context", async () => {
  const source = Array.from({ length: 50 }, (_, index) => `Line ${index + 1}${index === 29 ? " TOTAL NET SALES [a+b]" : ""}`).join("\n");
  const result = await reader(source, "text/plain").read({ url: "https://example.com/file", find: "[A+B]", lineCount: 10 }, signal());
  assert.equal(result.totalLines, 50);
  assert.deepEqual(result.matches.map(({ line }) => ({ line })), [{ line: 30 }]);
  assert(result.matches[0].preview?.toLowerCase().includes("[a+b]"));
  assert.equal(result.lines[0].number, 25);
  assert.equal(result.lines.at(-1)!.number, 34);
  assert.equal(result.nextStartLine, 35);
  assert.equal(result.truncated, true);
  const tail = await reader(source, "text/plain").read({ url: "https://example.com/file", startLine: result.nextStartLine, lineCount: 20 }, signal());
  assert.equal(tail.lines[0].number, 35);
  assert.equal(tail.lines.at(-1)!.number, 50);
  assert.equal(tail.nextStartLine, undefined);
});

test("web reader reports zero find matches and bounds matches to 20 without regex execution", async () => {
  const source = "abc abc\n".repeat(30);
  const result = await reader(source, "text/plain").read({ url: "https://example.com/file", find: "abc" }, signal());
  assert.equal(result.matches.length, 20);
  const missing = await reader(source, "text/plain").read({ url: "https://example.com/file", find: "(a+)+$" }, signal());
  assert.deepEqual(missing.matches, []);
});

test("web reader bounds text and exposes extraction truncation", async () => {
  const result = await reader("1234567890\nabcdefghij\nlast", "text/plain", { maxTextChars: 16 }).read({ url: "https://example.com/file" }, signal());
  assert.equal(result.lines.map((line) => line.text).join("\n"), "1234567890\nabcde");
  assert.equal(result.truncated, true);
  assert.match(result.limitations.join(""), /16.*截断/);
});

test("web reader splits huge paragraphs into stable lines and bounds every returned window", async () => {
  const source = "a".repeat(35_000);
  const tool = reader(source, "text/plain");
  const result = await tool.read({ url: "https://example.com/file", lineCount: 80 }, signal());
  assert.equal(result.totalLines, 35);
  assert.equal(result.lines.length, 20);
  assert.equal(result.lines.reduce((sum, line) => sum + line.text.length, 0), 20_000);
  assert(result.lines.every((line) => line.text.length <= 1000));
  assert.equal(result.nextStartLine, 21);
  assert.match(result.limitations.join(""), /20000.*1000/);
  const remainder = await tool.read({ url: "https://example.com/file", startLine: result.nextStartLine }, signal());
  assert.equal(remainder.lines.length, 15);
  assert.equal(remainder.lines[0].number, 21);
  assert.equal([...result.lines, ...remainder.lines].map((line) => line.text).join(""), source);
});

test("web reader rejects invalid parameters before DNS or downloading", async () => {
  let calls = 0;
  const tool = reader("text", "text/plain", { lookup: async () => { calls++; return [address]; } });
  const invalid: unknown[] = [null, [], {}, { url: "" }, { url: "file:///tmp/secrets" }, { url: "https://u:p@example.com/" }, { url: "https://example.com:8443" },
    { url: "https://example.com", extra: "field" }, { url: "https://example.com", find: " " }, { url: "https://example.com", find: "x".repeat(201) },
    ...[0, -1, 201, 2.5, "10", null].map((lineCount) => ({ url: "https://example.com", lineCount })),
    { url: "https://example.com", startLine: 0 }, { url: "https://example.com", page: 0 }, { url: "https://example.com", dateTo: "2025-02-29" },
    { url: "https://example.com", dateFrom: "2025-02-28", dateTo: "2024-02-29" }];
  for (const request of invalid) await assert.rejects(tool.read(request as WebReadRequest, signal()));
  assert.equal(calls, 0);
});

test("web reader blocks literal private, loopback, link-local, reserved, multicast and encoded IP URLs", async () => {
  let calls = 0;
  const tool = reader("text", "text/plain", { download: async () => { calls++; throw new Error("unexpected download"); } });
  const targets = ["localhost", "a.localhost", "a.local", "a.internal", "a.home.arpa", "internal", "0.0.0.0", "10.1.2.3", "127.1", "2130706433", "0x7f000001", "100.64.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "[::]", "[::1]", "[::ffff:127.0.0.1]", "[64:ff9b::7f00:1]", "[fc00::1]", "[fe80::1]", "[ff02::1]", "[2001:db8::1]", "[2002:7f00:1::1]", "[2001::1]", "[3fff::1]"];
  for (const host of targets) await assert.rejects(tool.read({ url: `http://${host}/` }, signal()), /读取/);
  assert.equal(calls, 0);
});

test("web reader validates every DNS address and rejects mixed public/private answers", async () => {
  for (const addresses of [[], [{ address: "127.0.0.1", family: 4 }], [address, { address: "10.0.0.1", family: 4 }], [{ address: "::ffff:93.184.216.34", family: 6 }], [{ address: "93.184.216.34", family: 6 }]]) {
    let calls = 0;
    const tool = reader("text", "text/plain", { lookup: async () => addresses, download: async () => { calls++; throw new Error("unexpected"); } });
    await assert.rejects(tool.read({ url: "https://example.com/file" }, signal()), /DNS/);
    assert.equal(calls, 0);
  }
});

for (const localAddresses of [
  [{ address: "198.18.0.31", family: 4 }, { address: "2001:2::21", family: 6 }],
  [{ address: "192.168.0.133", family: 4 }, { address: "192.168.205.22", family: 4 }],
  [address, { address: "198.18.0.31", family: 4 }],
]) test(`web reader verifies non-public DNS answers independently before connecting: ${localAddresses[0].address}`, async () => {
  let publicQueries = 0;
  let connections = 0;
  const tool = reader("safe text", "text/plain", {
    lookup: async () => localAddresses,
    publicLookup: async (hostname, requestSignal) => { publicQueries++; assert.equal(hostname, "example.com"); assert.equal(requestSignal.aborted, false); return [address]; },
    download: async (_url, validated) => { connections++; assert.deepEqual(validated, address); return { statusCode: 200, headers: { "content-type": "text/plain" }, body: body("safe text") }; },
  });
  const result = await tool.read({ url: "https://example.com/file" }, signal());
  assert.equal(publicQueries, 1);
  assert.equal(connections, 1);
  assert.equal(result.lines[0].text, "safe text");
  assert.equal(result.limitations.length, 0, "a successful DNS route is not a content limitation");
  for (const bad of ["127.0.0.1", "10.0.0.1", "2001:2:1::1"]) {
    const privateAddress = { address: bad, family: bad.includes(":") ? 6 : 4 };
    const rejected = reader("unused", "text/plain", { lookup: async () => localAddresses, publicLookup: async () => [privateAddress],
      download: async () => { assert.fail("must not connect to a private address"); } });
    await assert.rejects(rejected.read({ url: "https://example.com/file" }, signal()), /DNS 不能/);
  }
});

test("web reader tries another validated address when a connection fails and preserves error codes", async () => {
  const second = { address: "93.184.216.35", family: 4 };
  const attempts: string[] = [];
  const tool = reader("safe", "text/plain", { lookup: async () => [address, second], download: async (_url, target) => {
    attempts.push(target.address);
    if (target === address) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return { statusCode: 200, headers: { "content-type": "text/plain" }, body: body("safe") };
  } });
  assert.equal((await tool.read({ url: "https://example.com/file" }, signal())).lines[0].text, "safe");
  assert.deepEqual(attempts, [address.address, second.address]);
  const failed = reader("", "text/plain", { download: async () => { throw Object.assign(new Error("sensitive details"), { code: "ECONNRESET" }); } });
  await assert.rejects(failed.read({ url: "https://example.com/file" }, signal()), (error: Error) =>
    /网络请求失败.*example.com.*ECONNRESET/.test(error.message) && !error.message.includes("sensitive details"));
});

test("web reader bounds page titles separately from the body text budget", async () => {
  const source = `<html><head><title>${"x".repeat(20_000)}</title></head><body><article><p>Financial evidence 42 USD.</p></article></body></html>`;
  const result = await reader(source).read({ url: "https://example.com/file" }, signal());
  assert.equal(result.title.length, 500);
  assert.match(result.limitations.join(""), /标题超过 500/);
});

test("web reader passes the validated address to transport exactly once, preventing DNS rebinding", async () => {
  let lookups = 0;
  const tool = reader("safe evidence", "text/plain", {
    lookup: async () => { lookups++; return lookups === 1 ? [address] : [{ address: "127.0.0.1", family: 4 }]; },
    download: async (url, resolved, requestSignal) => {
      assert.equal(url.hostname, "example.com");
      assert.deepEqual(resolved, address);
      assert.equal(requestSignal.aborted, false);
      return { statusCode: 200, headers: { "content-type": "text/plain" }, body: body("safe evidence") };
    },
  });
  await tool.read({ url: "https://example.com/file" }, signal());
  assert.equal(lookups, 1);
});

test("web reader accepts public IPv6 and rejects private redirects before another connection", async () => {
  const ipv6 = { address: "2606:4700:4700::1111", family: 6 };
  const result = await reader("safe", "text/plain", { lookup: async () => [ipv6] }).read({ url: "https://example.com/file" }, signal());
  assert.equal(result.lines[0].text, "safe");
  let calls = 0;
  const tool = reader("unused", "text/plain", { download: async () => { calls++; return { statusCode: 302, headers: { location: "http://169.254.169.254/latest" }, body: body("") }; } });
  await assert.rejects(tool.read({ url: "https://example.com/start" }, signal()), /私有|保留/);
  assert.equal(calls, 1);
});

test("web reader checks each redirect DNS, exposes final URL and caps redirect loops", async () => {
  let calls = 0;
  const download: Download = async (url) => {
    calls++;
    return url.pathname === "/start" ? { statusCode: 301, headers: { location: "/final" }, body: body("") }
      : { statusCode: 200, headers: { "content-type": "text/plain" }, body: body("final evidence") };
  };
  const result = await reader("", "text/plain", { download }).read({ url: "https://example.com/start#fragment" }, signal());
  assert.equal(result.requestedUrl, "https://example.com/start#fragment");
  assert.equal(result.url, "https://example.com/final");
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(reader("", "text/plain", { download: async () => { calls++; return { statusCode: 302, headers: { location: "/loop" }, body: body("") }; } }).read({ url: "https://example.com/start" }, signal()), /重定向超过 4/);
  assert.equal(calls, 5);
  calls = 0;
  await assert.rejects(reader("", "text/plain", { lookup: async (hostname) => hostname === "private.example.com" ? [{ address: "127.0.0.1", family: 4 }] : [address], download: async () => { calls++; return { statusCode: 302, headers: { location: "https://private.example.com/" }, body: body("") }; } }).read({ url: "https://example.com/start" }, signal()), /DNS/);
  assert.equal(calls, 1);
});

test("web reader limits encoded and decompressed response sizes and closes transport", async () => {
  let destroyed = 0;
  const make = (bytes: Uint8Array, headers: Record<string, string> = {}) => reader("", "text/plain", {
    maxBytes: 100,
    download: async () => ({ statusCode: 200, headers: { "content-type": "text/plain", ...headers }, body: body(bytes), destroy: () => { destroyed++; } }),
  });
  await assert.rejects(make(Buffer.alloc(101)).read({ url: "https://example.com/file" }, signal()), /大小限制/);
  await assert.rejects(make(gzipSync("x".repeat(1000)), { "content-encoding": "gzip" }).read({ url: "https://example.com/file" }, signal()), /解压.*大小限制/);
  await assert.rejects(make(Buffer.from("short"), { "content-length": "1000" }).read({ url: "https://example.com/file" }, signal()), /大小限制/);
  assert.equal(destroyed, 3);
});

test("web reader handles gzip correctly and rejects unknown compression or unsupported content", async () => {
  const result = await reader("", "text/plain", { download: async () => ({ statusCode: 200, headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: body(gzipSync("USD million\n2024 revenue 391035")) }) }).read({ url: "https://example.com/file" }, signal());
  assert.equal(result.lines[1].text, "2024 revenue 391035");
  await assert.rejects(reader("text", "text/plain", { download: async () => ({ statusCode: 200, headers: { "content-type": "text/plain", "content-encoding": "secret" }, body: body("secret body") }) }).read({ url: "https://example.com/file" }, signal()), /压缩编码/);
  await assert.rejects(reader("PRIVATE RESPONSE CONTENT", "application/json").read({ url: "https://example.com/file" }, signal()), (error: Error) => /格式不受支持/.test(error.message) && !error.message.includes("PRIVATE"));
  await assert.rejects(reader("PRIVATE SERVER MESSAGE", "text/plain", { download: async () => ({ statusCode: 403, headers: {}, body: body("PRIVATE SERVER MESSAGE") }) }).read({ url: "https://example.com/file" }, signal()), (error: Error) => /HTTP 403/.test(error.message) && !error.message.includes("PRIVATE"));
});

test("web reader cancellation and deadline cover hung DNS, network and response bodies", async () => {
  for (const options of [
    { lookup: async () => new Promise<never>(() => {}) },
    { download: async () => new Promise<never>(() => {}) },
    { download: async () => ({ statusCode: 200, headers: { "content-type": "text/plain" }, body: (async function* () { await new Promise<never>(() => {}); yield Buffer.from("never"); })() }) },
  ]) {
    const started = Date.now();
    await assert.rejects(reader("", "text/plain", { ...options, timeoutMs: 15 }).read({ url: "https://example.com/file" }, signal()), /超时/);
    assert(Date.now() - started < 1000);
  }
  const controller = new AbortController();
  const pending = reader("", "text/plain", { lookup: async () => new Promise<never>(() => {}) }).read({ url: "https://example.com/file" }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /取消/);
});

test("web reader fails explicitly on an empty body or page without useful text", async () => {
  await assert.rejects(reader("", "text/plain").read({ url: "https://example.com/file" }, signal()), /没有正文/);
  await assert.rejects(reader("<html><body><script>document.write('rendered only')</script><nav>links</nav></body></html>").read({ url: "https://example.com/file" }, signal()), /没有可提取正文/);
  await assert.rejects(reader("one line", "text/plain").read({ url: "https://example.com/file", startLine: 2 }, signal()), /startLine/);
  await assert.rejects(reader("one line", "text/plain").read({ url: "https://example.com/file", page: 1 }, signal()), /只适用于 PDF/);
});

/** Small, valid PDF fixture with a genuine text layer, page tree and xref offsets. */
function pdf(pages: string[][]): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Title (Financial Statements) /CreationDate (D:20240928000000Z) /ModDate (D:20261001000000Z) >>"];
  const kids: number[] = [];
  for (const rows of pages) {
    const pageId = objects.length + 1;
    const contentId = pageId + 1;
    kids.push(pageId);
    const text = rows.map((line, index) => `1 0 0 1 30 ${750 - index * 20} Tm (${line.replace(/[\\()]/g, "\\$&")}) Tj`).join("\n");
    const stream = `BT /F1 12 Tf\n${text}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(source)); source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

test("web reader extracts actual PDF financial text, page coordinates and headers without asserting publication date", async () => {
  const source = pdf([["USD million", "FY2024 total net sales 391035", "FY2023 total net sales 383285"], ["Balance sheet", "Cash and cash equivalents 29943"]]);
  const result = await reader(source, "application/pdf").read({ url: "https://example.com/FY24.pdf", find: "total net sales", dateTo: "2024-12-31" }, signal());
  assert.equal(result.format, "pdf");
  assert.equal(result.title, "Financial Statements");
  assert.equal(result.totalPages, 2);
  assert.equal(result.readPages, 2);
  assert.equal(result.publicationDate, undefined);
  assert.equal(result.modifiedDate, undefined);
  assert.deepEqual(result.dateAssessment, { status: "unknown", basis: "none" });
  assert.deepEqual(result.matches.map(({ line, page }) => ({ line, page })), [{ line: 2, page: 1 }, { line: 3, page: 1 }]);
  assert.equal(result.lines[0].text, "USD million");
  assert.equal(result.lines[1].text, "FY2024 total net sales 391035");
  assert.equal(result.lines[4].page, 2);
  assert.match(result.limitations.join(""), /CreationDate.*不作为/);
});

test("web reader reads a chosen PDF page with explicit local line coordinates and bounds pages", async () => {
  const source = pdf([["First page header"], ["Second page USD million", "Revenue 42"]]);
  const result = await reader(source, "application/pdf").read({ url: "https://example.com/report.pdf", page: 2 }, signal());
  assert.equal(result.totalPages, 2);
  assert.equal(result.readPages, 1);
  assert.deepEqual(result.lines, [{ number: 1, text: "Second page USD million", page: 2 }, { number: 2, text: "Revenue 42", page: 2 }]);
  assert.match(result.limitations.join(""), /仅提取 PDF 第 2 页/);
  const capped = await reader(source, "application/pdf", { maxPdfPages: 1 }).read({ url: "https://example.com/report.pdf" }, signal());
  assert.equal(capped.readPages, 1);
  assert.equal(capped.truncated, true);
  await assert.rejects(reader(source, "application/pdf").read({ url: "https://example.com/report.pdf", page: 3 }, signal()), /超过 PDF 总页数/);
});

test("web reader PDF find keeps remote column headers and unit rows with matched financial values", async () => {
  const rows = ["Amounts in USD million", "Three months ended 2024 2023", "Twelve months ended 2024 2023",
    ...Array.from({ length: 12 }, (_, index) => `Financial statement row ${index + 1}`), "Total net sales 94930 89498 391035 383285"];
  const result = await reader(pdf([rows]), "application/pdf").read({ url: "https://example.com/report.pdf", find: "total net sales" }, signal());
  assert.equal(result.lines[0].text, "Amounts in USD million");
  assert(result.lines.some((line) => line.text === "Twelve months ended 2024 2023"));
  assert(result.lines.some((line) => line.text === "Total net sales 94930 89498 391035 383285"));
  const narrow = await reader(pdf([rows]), "application/pdf").read({ url: "https://example.com/report.pdf", find: "total net sales", lineCount: 5 }, signal());
  assert.match(narrow.limitations.join(""), /匹配行 16 未包含.*startLine=11/);
});

test("web reader reports scanned PDFs without pretending an empty text layer is evidence", async () => {
  await assert.rejects(reader(pdf([[]]), "application/pdf").read({ url: "https://example.com/scan.pdf" }, signal()), /没有可提取文本.*OCR/);
});

test("web reader previews distinguish actual financial lines from a table of contents", async () => {
  const tool = reader("<html><title>Financial report</title><main><p>Operating earnings — contents page 7</p><p>Year ended 2024 (USD millions)</p><p>Operating earnings 47,437</p></main></html>");
  const result = await tool.read({ url: "https://issuer.example/report", find: "Operating earnings" }, signal());
  assert.equal(result.matches.length, 2);
  assert(result.matches[0].preview?.includes("contents"));
  assert(result.matches[1].preview?.includes("47,437"));
});
