import test from "node:test";
import assert from "node:assert/strict";
import type { WebSearchRequest } from "@eval/contracts";
import { createSerperSearch } from "./serper.js";
import { assessWebDate, parseAbsoluteWebDate, shiftWebDate, validateDateRange } from "./web-date.js";

const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const item = { title: "人民银行金融统计", link: "https://www.pbc.gov.cn/statistics", snippet: "统计口径", position: 1 };
const request = (query = "金融统计"): WebSearchRequest => ({ queries: [{ query }] });
function stub(handler: (url: string, options: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, options: RequestInit) => handler(String(url), options)) as typeof fetch;
}

// Individual assertion helpers use only stable result fields; timings are measured, never fixed fixtures.
test("Serper sends ten candidates per query and exposes audited defaults without synthesizing publication dates", async () => {
  let calls = 0;
  const search = createSerperSearch({ apiKey: " secret-key ", fetch: stub((url, options) => {
    calls++;
    assert.equal(url, "https://google.serper.dev/search");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { "X-API-KEY": "secret-key", "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(options.body as string), { q: "金融统计", gl: "cn", hl: "zh-cn", num: 10, page: 1 });
    assert(options.signal instanceof AbortSignal);
    return json({ organic: [item], answerBox: { answer: "not an organic citation" }, credits: 1 });
  }) });
  const result = await search.search(request(" 金融统计 "), signal());
  assert.equal(calls, 1);
  assert.equal(result.provider, "serper");
  assert.equal(result.category, "web");
  assert.equal(result.totalUnique, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.credits, 1);
  assert.equal(result.creditsComplete, true);
  assert.equal(new Date(result.searchedAt).toISOString(), result.searchedAt);
  assert(result.elapsedMs >= 0);
  assert.deepEqual(result.attempts, [{ query: "金融统计", searchQuery: "金融统计", queryIndex: 0, country: "cn", language: "zh-cn", page: 1,
    state: "succeeded", resultCount: 1, elapsedMs: result.attempts[0].elapsedMs, credits: 1 }]);
  assert.deepEqual(result.results, [{ title: item.title, url: item.link, domain: "www.pbc.gov.cn", snippet: item.snippet, rank: 1,
    matches: [{ queryIndex: 0, position: 1, page: 1 }], dateAssessment: { status: "not_requested", basis: "none" } }]);
  assert.deepEqual(result.excludedResults, []);
  assert(!JSON.stringify(result).includes("secret-key"));
  assert(!Object.hasOwn(result.results[0], "date"));
});

test("Serper news preserves untrusted relative dates, locale, domains and pagination in audit", async () => {
  const search = createSerperSearch({ apiKey: "key", fetch: stub((url, options) => {
    assert.equal(url, "https://google.serper.dev/news");
    assert.deepEqual(JSON.parse(options.body as string), { q: "央行降息 (site:pbc.gov.cn OR site:reuters.com)", gl: "us", hl: "en", num: 10, page: 2, tbs: "qdr:w" });
    return json({ news: [{ ...item, date: "2 hours ago", source: "人民银行", imageUrl: "https://unneeded.example/image" },
      { title: "Second release", link: "https://reuters.com/release", date: "Oct 1, 2026", position: 2 }], credits: 2 });
  }) });
  const result = await search.search({ queries: [{ query: "央行降息", domains: ["PBC.GOV.CN", "reuters.com"], country: "us", language: "en", page: 2 }], category: "news", limit: 1, timeRange: "week" }, signal());
  assert.equal(result.results.length, 1);
  assert.equal(result.hasMore, true);
  assert.equal(result.totalUnique, 2);
  assert.equal(result.timeRange, "week");
  assert.equal(result.results[0].date, "2 hours ago");
  assert.equal(result.results[0].source, "人民银行");
  assert.equal(result.results[0].matches[0].page, 2);
  assert(!Object.hasOwn(result.results[0], "imageUrl"));
});

test("Serper maps supported relative time ranges without fabricating credit costs", async () => {
  for (const [timeRange, tbs] of [["day", "qdr:d"], ["week", "qdr:w"], ["month", "qdr:m"], ["year", "qdr:y"]] as const) {
    const search = createSerperSearch({ apiKey: "key", fetch: stub((_, options) => {
      const body = JSON.parse(options.body as string);
      assert.equal(body.tbs, tbs);
      assert.equal(body.q, "年报 (site:cninfo.com.cn)");
      return json({ organic: [] });
    }) });
    const result = await search.search({ queries: [{ query: "年报", domains: ["cninfo.com.cn"] }], timeRange }, signal());
    assert.deepEqual(result.results, []);
    assert.equal(result.creditsComplete, false);
    assert(!Object.hasOwn(result, "credits"));
  }
});

test("Serper validates the current batch contract, calendar dates and normalized duplicates before HTTP", async () => {
  let calls = 0;
  const search = createSerperSearch({ apiKey: "key", fetch: stub(() => { calls++; return json({ organic: [] }); }) });
  const invalidQueryValues: unknown[] = [null, [], {}, { query: "" }, { query: " \n " }, { query: "a".repeat(501) }, { query: " ".repeat(500) + "a" },
    { query: "x", country: "china" }, { query: "x", country: "US" }, { query: "x", language: "中文" }, { query: "x", language: "EN" },
    { query: "x", language: "eng" }, { query: "x", language: "zh-hans-cn" }, { query: "x", page: 0 }, { query: "x", page: 4 }, { query: "x", page: 1.5 }, { query: "x", page: null },
    { query: "x", domains: [] }, { query: "x", domains: Array(6).fill("sec.gov") }, { query: "x", domains: ["sec.gov", "SEC.GOV"] },
    ...["https://sec.gov", "sec.gov/path", "sec.gov:443", "sec.gov OR site:bad.com", " sec.gov", "sec.gov.", "local", "_sec.gov", "-sec.gov", "sec-.gov", `${"a".repeat(64)}.gov`].map((domain) => ({ query: "x", domains: [domain] })),
    { query: "x", endpoint: "https://bad.example" }];
  const invalid: unknown[] = [null, [], {}, { queries: [] }, { queries: Array(5).fill({ query: "x" }) },
    ...invalidQueryValues.map((query) => ({ queries: [query] })),
    ...["finance", null].map((category) => ({ ...request(), category })),
    ...[0, 21, 1.5, null].map((limit) => ({ ...request(), limit })),
    ...["hour", {}].map((timeRange) => ({ ...request(), timeRange })),
    ...["2024-02-30", "2023-02-29", "2024-13-01", "2024-01-00", "0000-01-01", "2024-1-01", null, 20241001].map((dateFrom) => ({ ...request(), dateFrom })),
    { ...request(), dateFrom: "2024-02-02", dateTo: "2024-02-01" }, { ...request(), dateTo: "2024-02-30" },
    { ...request(), dateTo: "2024-02-01", timeRange: "day" }, { ...request(), query: "x" },
    { queries: [{ query: " x ", domains: ["SEC.GOV", "pbc.gov.cn"] }, { query: "x", domains: ["pbc.gov.cn", "sec.gov"], country: "cn", language: "zh-cn", page: 1 }] }];
  for (const value of invalid) await assert.rejects(search.search(value as WebSearchRequest, signal()), /搜索|dateFrom|dateTo/);
  assert.equal(calls, 0);
});

test("Serper domain restrictions match actual hostnames and reject suffix spoofing", async () => {
  const search = createSerperSearch({ apiKey: "key", fetch: stub(() => json({ organic: [
    { ...item, link: "https://sec.gov/first" }, { ...item, link: "https://www.sec.gov/second" },
    { ...item, link: "https://evilsec.gov/spoof" }, { ...item, link: "https://sec.gov.evil.example/spoof" },
    { ...item, link: "https://evil.example/redirect?target=sec.gov" },
  ] })) });
  const result = await search.search({ queries: [{ query: "财报", domains: ["sec.gov"] }] }, signal());
  assert.equal(result.attempts[0].resultCount, 5);
  assert.deepEqual(result.results.map((row) => row.domain), ["sec.gov", "www.sec.gov"]);
  assert.equal(result.totalUnique, 2);
});

test("Serper accepts DNS labels supported by the schema", async () => {
  const search = createSerperSearch({ apiKey: "key", fetch: stub((_, options) => {
    assert.equal(JSON.parse(options.body as string).q, "金融 (site:reports.2026 OR site:example.2nd)");
    return json({ organic: [] });
  }) });
  await search.search({ queries: [{ query: "金融", domains: ["reports.2026", "example.2nd"] }] }, signal());
});

test("Serper deduplicates tracking links and fragments, preserves business parameters and ranks shared hits with RRF", async () => {
  const search = createSerperSearch({ apiKey: "key", fetch: stub((_, options) => {
    const q = JSON.parse(options.body as string).q;
    return q === "A" ? json({ organic: [
      { ...item, title: "First single", link: "https://example.com/first", position: 1 },
      { ...item, title: "Common", link: "https://EXAMPLE.com/shared?id=24&utm_source=x#table", position: 5 },
      { ...item, title: "Same request duplicate", link: "https://example.com/shared?id=24&fbclid=y", position: 6 },
      { ...item, title: "Different report", link: "https://example.com/shared?id=25&ref=annual", position: 7 },
    ], credits: 1 }) : json({ organic: [
      { ...item, title: "Second single", link: "https://example.com/second", position: 1 },
      { ...item, title: "Common again", link: "https://example.com/shared?id=24&gclid=x#page2", position: 4 },
    ], credits: 1 });
  }) });
  const result = await search.search({ queries: [{ query: "A" }, { query: "B" }] }, signal());
  assert.deepEqual(result.results.map((row) => row.url), ["https://example.com/shared?id=24", "https://example.com/first", "https://example.com/second", "https://example.com/shared?id=25&ref=annual"]);
  assert.deepEqual(result.results[0].matches, [{ queryIndex: 0, position: 5, page: 1 }, { queryIndex: 1, position: 4, page: 1 }]);
  assert.equal(result.results[0].title, "Common");
  assert.deepEqual(result.results.map((row) => row.rank), [1, 2, 3, 4]);
  assert.equal(result.credits, 2);
});

test("Serper executes at most two subrequests concurrently and keeps audit order despite out-of-order responses", async () => {
  let active = 0;
  let peak = 0;
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  const search = createSerperSearch({ apiKey: "key", fetch: stub(async (_, options) => {
    const q = JSON.parse(options.body as string).q;
    starts.push(q); active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.set(q, resolve));
    active--;
    return json({ organic: [{ ...item, link: `https://example.com/${q}` }], credits: 1 });
  }) });
  const resultPromise = search.search({ queries: ["A", "B", "C", "D"].map((query) => ({ query })) }, signal());
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  await tick();
  assert.deepEqual(starts, ["A", "B"]);
  releases.get("B")!(); await tick();
  assert.deepEqual(starts, ["A", "B", "C"]);
  releases.get("C")!(); await tick();
  assert.deepEqual(starts, ["A", "B", "C", "D"]);
  releases.get("D")!(); releases.get("A")!();
  const result = await resultPromise;
  assert.equal(peak, 2);
  assert.deepEqual(result.attempts.map((attempt) => attempt.query), ["A", "B", "C", "D"]);
  assert.deepEqual(result.results.map((row) => row.url), ["https://example.com/A", "https://example.com/B", "https://example.com/C", "https://example.com/D"]);
  assert.equal(result.credits, 4);
});

test("Serper includes visible partial failures and incomplete known credits without retry", async () => {
  let calls = 0;
  const search = createSerperSearch({ apiKey: "private-key", fetch: stub((_, options) => {
    calls++;
    const q = JSON.parse(options.body as string).q;
    if (q === "bad") return json({ message: "private-key" }, 429);
    return json({ organic: [item], ...(q === "known" ? { credits: 1 } : {}) });
  }) });
  const result = await search.search({ queries: [{ query: "bad" }, { query: "known" }, { query: "unknown" }] }, signal());
  assert.equal(calls, 3);
  assert.deepEqual(result.attempts.map((attempt) => attempt.state), ["failed", "succeeded", "succeeded"]);
  assert.match(result.attempts[0].error!, /HTTP 429/);
  assert.equal(result.credits, 1);
  assert.equal(result.creditsComplete, false);
  assert.equal(result.results.length, 1);
  assert(!JSON.stringify(result).includes("private-key"));
});

test("Serper absolute dates use inclusive boundaries but keep date-unknown candidates and quarantine dated revisions", async () => {
  const search = createSerperSearch({ apiKey: "key", fetch: stub((_, options) => {
    const body = JSON.parse(options.body as string);
    assert.equal(body.q, "2024年度GDP after:2024-02-28 before:2024-03-02");
    assert(!Object.hasOwn(body, "tbs"));
    return json({ organic: [
      { ...item, title: "At start", link: "https://example.com/start", date: "2024-02-29" },
      { ...item, title: "At end", link: "https://example.com/end", date: "Mar 1, 2024" },
      { ...item, title: "Later revision", link: "https://example.com/revised", date: "2025-01-01" },
      { ...item, title: "Reporting period alone", link: "https://example.com/period", date: "2024年" },
      { ...item, title: "Relative date", link: "https://example.com/relative", date: "2 days ago" },
      { ...item, title: "No date", link: "https://example.com/no-date" },
    ] });
  }) });
  const result = await search.search({ queries: [{ query: "2024年度GDP" }], dateFrom: "2024-02-29", dateTo: "2024-03-01" }, signal());
  assert.equal(result.totalUnique, 6);
  assert.deepEqual(result.results.map((row) => row.dateAssessment.status), ["within_range", "within_range", "unknown", "unknown", "unknown"]);
  assert.deepEqual(result.excludedResults.map((row) => row.title), ["Later revision"]);
  assert.deepEqual(result.excludedResults[0].dateAssessment, { status: "outside_range", basis: "search_metadata", date: "2025-01-01" });
});

test("Serper contradictory publication metadata becomes unknown rather than false historical eligibility", async () => {
  const search = createSerperSearch({ apiKey: "key", fetch: stub((_, options) => json({ organic: [{ ...item,
    date: JSON.parse(options.body as string).q.startsWith("A") ? "2024-01-01" : "2025-01-01" }] })) });
  const result = await search.search({ queries: [{ query: "A" }, { query: "B" }], dateTo: "2024-12-31" }, signal());
  assert.equal(result.excludedResults.length, 0);
  assert.deepEqual(result.results[0].dateAssessment, { status: "unknown", basis: "none" });
});

test("Serper allows missing configuration at creation and fails explicitly when invoked", async () => {
  let calls = 0;
  const search = createSerperSearch({ fetch: stub(() => { calls++; return json({ organic: [] }); }) });
  await assert.rejects(search.search(request(), signal()), /尚未配置 SEARCH_API_KEY/);
  assert.equal(calls, 0);
  assert.throws(() => createSerperSearch({ timeoutMs: 0 }), /timeoutMs/);
});

test("Serper reports all HTTP failures without raw provider bodies or retries", async () => {
  for (const [status, hint] of [[401, /SEARCH_API_KEY/], [403, /SEARCH_API_KEY/], [402, /账户余额/], [429, /额度/], [500, /HTTP 500/], [302, /HTTP 302/]] as const) {
    let calls = 0;
    const search = createSerperSearch({ apiKey: "private-key", fetch: stub(() => { calls++; return json({ message: "private-key" }, status); }) });
    await assert.rejects(search.search(request(), signal()), (error: Error) => {
      assert.match(error.message, /全部搜索失败/); assert.match(error.message, hint);
      assert(!error.message.includes("private-key")); return true;
    });
    assert.equal(calls, 1);
  }
});

test("Serper rejects malformed results and invalid JSON without silently claiming an empty success", async () => {
  const invalid = [json(null), json([]), json({}), json({ organic: null }), json({ organic: [null] }),
    json({ organic: [{ title: "", link: item.link }] }), json({ organic: [{ title: "x", link: "javascript:alert(1)" }] }),
    json({ organic: [{ title: "x", link: "https://user:password@example.com" }] }), json({ organic: [{ ...item, snippet: 12 }] }),
    json({ organic: [{ ...item, date: 12 }] }), json({ organic: [{ ...item, source: {} }] }), json({ organic: [{ ...item, position: 0 }] }),
    json({ organic: [item], credits: "1" }), json({ organic: [item], credits: -1 }), json({ organic: [], error: "private-key" }),
    json({ organic: [], message: "private-key" }), new Response("not JSON private-key", { status: 200 })];
  for (const response of invalid) {
    const search = createSerperSearch({ apiKey: "private-key", fetch: stub(() => response) });
    await assert.rejects(search.search(request(), signal()), (error: Error) => { assert.match(error.message, /Serper (?:响应|返回)/); assert(!error.message.includes("private-key")); return true; });
  }
  const search = createSerperSearch({ apiKey: "key", fetch: stub(() => json({ organic: [] })) });
  await assert.rejects(search.search({ ...request(), category: "news" }, signal()), /news 必须为数组/);
  const throwingBody = new Response(new ReadableStream({ start(controller) { controller.error(new Error("private-key body error")); } }));
  await assert.rejects(createSerperSearch({ apiKey: "private-key", fetch: stub(() => throwingBody) }).search(request(), signal()), (error: Error) => {
    assert.match(error.message, /响应不是有效 JSON/); assert(!error.message.includes("private-key")); return true;
  });
});

test("Serper network errors redact synchronous and asynchronous transport secrets", async () => {
  for (const fetcher of [stub(() => { throw new Error("private-key sync error"); }), stub(() => Promise.reject(new Error("private-key network error")))]) {
    const search = createSerperSearch({ apiKey: "private-key", fetch: fetcher });
    await assert.rejects(search.search(request(), signal()), (error: Error) => {
      assert.match(error.message, /Serper 搜索网络请求失败/); assert(!error.stack?.includes("private-key")); return true;
    });
  }
});

test("Serper rejects already cancelled work without issuing requests", async () => {
  let calls = 0;
  const controller = new AbortController(); controller.abort(new Error("private-key reason"));
  const search = createSerperSearch({ apiKey: "private-key", fetch: stub(() => { calls++; return json({ organic: [] }); }) });
  await assert.rejects(search.search(request(), controller.signal), /搜索已取消/);
  assert.equal(calls, 0);
});

test("Serper user cancellation rejects the entire batch and never starts queued requests", async () => {
  const controller = new AbortController();
  const requestSignals: AbortSignal[] = [];
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  const search = createSerperSearch({ apiKey: "key", fetch: stub((_, options) => {
    requestSignals.push(options.signal as AbortSignal);
    if (requestSignals.length === 2) started();
    return new Promise<Response>(() => {});
  }) });
  const result = search.search({ queries: ["A", "B", "C", "D"].map((query) => ({ query })) }, controller.signal);
  await requested; controller.abort(new Error("key must not escape"));
  await assert.rejects(result, /搜索已取消/);
  assert.equal(requestSignals.length, 2);
  assert(requestSignals.every((requestSignal) => requestSignal.aborted));
});

test("Serper user cancellation after partial success still rejects all results", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const requested = new Promise<void>((resolve) => { started = resolve; });
  const search = createSerperSearch({ apiKey: "key", fetch: stub((_, options) => {
    if (JSON.parse(options.body as string).q === "A") return json({ organic: [item], credits: 1 });
    started(); return new Promise<Response>(() => {});
  }) });
  const result = search.search({ queries: [{ query: "A" }, { query: "B" }] }, controller.signal);
  await requested; controller.abort();
  await assert.rejects(result, /搜索已取消/);
});

test("Serper timeout aborts transport and covers stalled body parsing", async () => {
  for (const bodyPending of [false, true]) {
    let requestSignal: AbortSignal | undefined;
    const search = createSerperSearch({ apiKey: "key", timeoutMs: 10, fetch: stub((_, options) => {
      requestSignal = options.signal as AbortSignal;
      if (!bodyPending) return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }));
    }) });
    await assert.rejects(search.search(request(), signal()), /搜索超时（10 ms）/);
    assert(requestSignal?.aborted);
  }
});

test("Serper subrequest timeout preserves other success and remains visible", async () => {
  const search = createSerperSearch({ apiKey: "key", timeoutMs: 10, fetch: stub((_, options) => JSON.parse(options.body as string).q === "A" ? json({ organic: [item], credits: 1 }) : new Promise<Response>(() => {})) });
  const result = await search.search({ queries: [{ query: "A" }, { query: "B" }] }, signal());
  assert.equal(result.results.length, 1);
  assert.equal(result.attempts[1].state, "failed");
  assert.match(result.attempts[1].error!, /超时/);
  assert.equal(result.creditsComplete, false);
});

test("Web date assessment validates real Gregorian days and refuses ambiguous or relative labels", () => {
  for (const [raw, date] of [["2024-02-29", "2024-02-29"], ["2024-02-29T18:30:00+08:00", "2024-02-29"], ["2024年2月29日", "2024-02-29"], ["2024/2/29", "2024-02-29"], ["Feb 29, 2024", "2024-02-29"], ["29 February 2024", "2024-02-29"]]) assert.equal(parseAbsoluteWebDate(raw), date);
  for (const raw of ["2023-02-29", "2024-02-30", "2024-02-29T26:00:00Z", "2024-02-29T24:00:00Z", "2024-02-29t99:00:00z", "2 days ago", "2024-02", "02/03/2024", "发布日期见正文", "2024年度GDP", undefined]) assert.equal(parseAbsoluteWebDate(raw), undefined);
  assert.doesNotThrow(() => validateDateRange("2000-02-29", "2000-03-01"));
  assert.throws(() => validateDateRange("1900-02-29"), /有效日历/);
  assert.equal(shiftWebDate("2024-03-01", -1), "2024-02-29");
  assert.equal(shiftWebDate("2024-12-31", 1), "2025-01-01");
  assert.deepEqual(assessWebDate("2024-02-29", "page_metadata", undefined, "2024-02-29"), { status: "within_range", basis: "page_metadata", date: "2024-02-29" });
  assert.deepEqual(assessWebDate("2 days ago", "search_metadata", undefined, "2024-02-29"), { status: "unknown", basis: "none" });
  assert.deepEqual(assessWebDate("2024-02-29", "search_metadata"), { status: "not_requested", basis: "none" });
});

test("Serper bounds provider bodies and metadata and exposes truncated fields", async () => {
  const search = createSerperSearch({ apiKey: "key", fetch: stub(() => json({ organic: [{ ...item, title: "t".repeat(1000), snippet: "s".repeat(3000), source: "r".repeat(300), date: "d".repeat(200) }] })) });
  const result = await search.search(request(), signal());
  assert.equal(result.results[0].title.length, 500);
  assert.equal(result.results[0].snippet?.length, 2000);
  assert.equal(result.results[0].source?.length, 200);
  assert.equal(result.results[0].date?.length, 100);
  assert.deepEqual(result.results[0].truncatedFields, ["title", "snippet", "date", "source"]);
  const huge = createSerperSearch({ apiKey: "key", fetch: stub(() => new Response("x".repeat(1024 * 1024 + 1))) });
  await assert.rejects(huge.search(request(), signal()), /1 MiB/);
});
