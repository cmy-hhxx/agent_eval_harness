import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixturePath = path.join(root, "tests/fixtures/search-audit.json");
const usage = `Financial search audit (explicit paid network run)

  node scripts/search-audit.mjs --live --output .artifacts/search-audit-<run>
  node scripts/search-audit.mjs --live --case apple-annual-sales --output .artifacts/search-audit-<rerun>

Requires current npm run build:app output and SEARCH_API_KEY in the root config.ini [environment].
Without --live and --output the script makes no requests. --case may be repeated.
Full run: 36 Serper HTTP requests (normally 36 credits), each asking for ten results;
at most twelve direct source reads, only of returned planned candidates matching gold.
The twelve fixtures and read windows are declared in advance; this is known-document
Hit@k and literal-anchor coverage, not autonomous search, open-web recall, or final judgment accuracy.`;

function normalize(value) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
function matchesGold(item, specification) {
  const url = new URL(item.url);
  const host = url.hostname.toLowerCase();
  if (host !== specification.domain && !host.endsWith(`.${specification.domain}`)) return false;
  if (specification.pathIncludes) return specification.pathIncludes.some((part) => url.pathname.toLowerCase().includes(part.toLowerCase()));
  return normalize(item.title).replaceAll(" ", "") === normalize(specification.titleExact).replaceAll(" ", "");
}
function validateFixture(fixture) {
  if (fixture.preregisteredQueries !== true || !Array.isArray(fixture.cases) || fixture.cases.length !== 12)
    throw new Error("Expected the fixed twelve-case preregistered search fixture");
  const identities = new Set();
  for (const entry of fixture.cases) {
    if (!/^[a-z][a-z0-9-]+$/.test(entry.id) || identities.has(entry.id)) throw new Error("Invalid or duplicate fixture case id");
    identities.add(entry.id);
    if (!entry.match?.domain || !entry.goldTitle || !entry.goldUrl || !entry.readProbe) throw new Error(`Incomplete fixture: ${entry.id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.dateTo) || new Date(`${entry.dateTo}T00:00:00Z`).toISOString().slice(0, 10) !== entry.dateTo)
      throw new Error(`Invalid historical cutoff: ${entry.id}`);
    for (const query of [entry.natural, entry.semantic]) {
      if (typeof query?.query !== "string" || !query.query.trim()) throw new Error(`Missing declared query: ${entry.id}`);
      if (query.query.includes(entry.goldUrl) || normalize(query.query).includes(normalize(entry.goldTitle)))
        throw new Error(`Query contains a gold URL or exact title: ${entry.id}`);
    }
    for (const group of ["value", "period", "unit"])
      if (!Array.isArray(entry.anchors?.[group]) || !entry.anchors[group].length || entry.anchors[group].some((literal) => typeof literal !== "string" || !literal))
        throw new Error(`Invalid ${group} anchors: ${entry.id}`);
  }
}
function coverage(readResult, anchors) {
  const result = {};
  for (const [group, alternatives] of Object.entries(anchors)) {
    const matches = alternatives.flatMap((literal) => readResult.lines
      .filter((line) => normalize(line.text).includes(normalize(literal)))
      .map((line) => ({ literal, line: line.number, ...(line.page === undefined ? {} : { page: line.page }), text: line.text })));
    result[group] = { covered: matches.length > 0, matches };
  }
  return { ...result, allAnchors: Object.values(result).every((group) => group.covered) };
}
function latency(values) {
  const sorted = values.toSorted((a, b) => a - b);
  if (!sorted.length) return { count: 0, medianMs: null, p95Ms: null, minMs: null, maxMs: null };
  const midpoint = Math.floor(sorted.length / 2);
  return { count: sorted.length, medianMs: sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], minMs: sorted[0], maxMs: sorted.at(-1) };
}
function summarize(rows) {
  const arms = {};
  for (const arm of ["baseline", "planned"]) {
    const searches = rows.map((row) => row[arm]);
    const outcomes = searches.flatMap((search) => search.result?.attempts ?? []);
    const returned = searches.flatMap((search) => search.result?.results ?? []);
    const observedCredits = searches.filter((search) => typeof search.result?.credits === "number");
    arms[arm] = {
      caseCount: rows.length,
      hitAt: Object.fromEntries([1, 3, 5, 10].map((k) => [String(k), { hits: searches.filter((search) => search.hitRank !== null && search.hitRank <= k).length, denominator: rows.length }])),
      states: Object.fromEntries(["not_started", "succeeded", "partial_failure", "failed"].map((state) => [state, searches.filter((search) => search.state === state).length])),
      emptyCandidateCases: searches.filter((search) => search.result && !search.result.results.length).length,
      noUsableCandidateCases: searches.filter((search) => !search.result?.results.length).length,
      expectedQueryRequests: searches.reduce((sum, search) => sum + search.request.queries.length, 0),
      observedHttpRequests: searches.reduce((sum, search) => sum + search.httpRequests.length, 0),
      knownQueryFailures: outcomes.filter((attempt) => attempt.state === "failed").length,
      knownCredits: observedCredits.reduce((sum, search) => sum + search.result.credits, 0),
      creditsComplete: searches.every((search) => search.result?.creditsComplete === true),
      creditsCompleteCases: searches.filter((search) => search.result?.creditsComplete === true).length,
      elapsed: latency(searches.flatMap((search) => search.elapsedMs === undefined ? [] : [search.elapsedMs])),
      successfulElapsed: latency(searches.filter((search) => search.state === "succeeded" || search.state === "partial_failure").map((search) => search.elapsedMs)),
      queryElapsed: latency(outcomes.map((attempt) => attempt.elapsedMs)),
      candidateDateAssessments: Object.fromEntries(["not_requested", "unknown", "within_range", "outside_range"].map((state) => [state, returned.filter((item) => item.dateAssessment.status === state).length])),
      excludedCandidates: searches.reduce((sum, search) => sum + (search.result?.excludedResults.length ?? 0), 0),
    };
  }
  const reads = rows.map((row) => row.read);
  const groups = Object.fromEntries(["value", "period", "unit", "allAnchors"].map((group) => [group, {
    covered: reads.filter((read) => group === "allAnchors" ? read.coverage?.allAnchors === true : read.coverage?.[group]?.covered === true).length,
    denominator: rows.length,
  }]));
  return { overall: {
    expectedQueryRequests: arms.baseline.expectedQueryRequests + arms.planned.expectedQueryRequests,
    observedHttpRequests: arms.baseline.observedHttpRequests + arms.planned.observedHttpRequests,
    knownCredits: arms.baseline.knownCredits + arms.planned.knownCredits,
    creditsComplete: arms.baseline.creditsComplete && arms.planned.creditsComplete,
    searchElapsed: latency(rows.flatMap((row) => [row.baseline.elapsedMs, row.planned.elapsedMs].filter((elapsed) => elapsed !== undefined))),
  }, arms, read: { caseCount: rows.length, attempted: reads.filter((read) => ["succeeded", "failed"].includes(read.state)).length,
    succeeded: reads.filter((read) => read.state === "succeeded").length, failed: reads.filter((read) => read.state === "failed").length,
    skippedNoRetrievedGold: reads.filter((read) => read.state === "not_retrieved").length,
    historicalDatesVerifiedByArchive: 0, anchorCoverage: groups,
    elapsed: latency(reads.flatMap((read) => read.elapsedMs === undefined ? [] : [read.elapsedMs])) } };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    live: { type: "boolean", default: false }, output: { type: "string" }, case: { type: "string", multiple: true }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(usage); return; }
  if (!values.live || !values.output || positionals.length) { console.error(usage); process.exitCode = 2; return; }
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  validateFixture(fixture);
  const selected = values.case ?? fixture.cases.map((entry) => entry.id);
  if (new Set(selected).size !== selected.length || selected.some((id) => !fixture.cases.some((entry) => entry.id === id)))
    throw new Error("--case must name unique ids in the fixed fixture");
  const cases = fixture.cases.filter((entry) => selected.includes(entry.id));
  const { readSettings, applySettings } = await import("@eval/host-app/settings");
  const settings = await readSettings();
  applySettings(settings);
  const apiKey = settings.environment.SEARCH_API_KEY?.trim();
  if (!apiKey) throw new Error("SEARCH_API_KEY is required for --live");
  const { createSerperSearch, createWebReader } = await import("@eval/tools");
  const output = path.resolve(root, values.output);
  await mkdir(output, { recursive: true });
  const reportPath = path.join(output, "results.json");
  const summaryPath = path.join(output, "summary.json");
  // Reserve outputs before spending credits. Never overwrite an earlier audit run.
  await writeFile(reportPath, "{}\n", { flag: "wx" });
  await writeFile(summaryPath, "{}\n", { flag: "wx" });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  const safeError = (error) => String(error instanceof Error ? error.message : "Unexpected audit failure").replaceAll(apiKey, "[redacted]");
  const rows = cases.map((entry) => {
    const boundaries = { ...(entry.dateFrom ? { dateFrom: entry.dateFrom } : {}), dateTo: entry.dateTo };
    const search = (queries) => ({ state: "not_started", hitRank: null, httpRequests: [], request: { queries, category: "web", limit: 20, ...boundaries } });
    return { fixture: entry, baseline: search([entry.natural]), planned: search([entry.natural, entry.semantic]), read: { state: "not_started" } };
  });
  const report = { startedAt: new Date().toISOString(), status: "running", selectedCases: selected, fixturePath: path.relative(root, fixturePath),
    methodology: fixture.limitations, budget: { serperHttpRequests: cases.length * 3, sourceReadsMaximum: cases.length, resultsPerQuery: 10, mergedLimit: 20 }, cases: rows };
  async function save() {
    report.summary = summarize(rows);
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    await writeFile(summaryPath, JSON.stringify({ startedAt: report.startedAt, finishedAt: report.finishedAt, status: report.status, selectedCases: selected,
      methodology: report.methodology, budget: report.budget, summary: report.summary }, null, 2) + "\n");
  }
  await save();
  console.log(JSON.stringify({ status: "starting", cases: cases.length, ...report.budget, output }));
  try {
    const reader = createWebReader();
    for (const [index, row] of rows.entries()) {
      if (controller.signal.aborted) break;
      // Alternate arms to reduce a systematic first-request timing advantage.
      for (const arm of index % 2 ? ["planned", "baseline"] : ["baseline", "planned"]) {
        if (controller.signal.aborted) break;
        const search = row[arm];
        const provider = createSerperSearch({ apiKey, fetch: async (...args) => {
          const call = { state: "started", startedAt: new Date().toISOString() }; search.httpRequests.push(call);
          const start = performance.now();
          try { const response = await fetch(...args); call.state = "http_response"; call.status = response.status; return response; }
          catch (error) { call.state = "network_failed"; throw error; }
          finally { call.elapsedMs = Math.round(performance.now() - start); }
        } });
        const started = performance.now();
        try {
          search.result = await provider.search(search.request, controller.signal);
          search.state = search.result.attempts.some((attempt) => attempt.state === "failed") ? "partial_failure" : "succeeded";
          const hitIndex = search.result.results.findIndex((item) => matchesGold(item, row.fixture.match));
          search.hitRank = hitIndex < 0 ? null : hitIndex + 1;
          search.excludedGold = search.result.excludedResults.filter((item) => matchesGold(item, row.fixture.match));
        } catch (error) { search.state = "failed"; search.error = safeError(error); }
        finally { search.elapsedMs = Math.round(performance.now() - started); }
        await save();
      }
      if (controller.signal.aborted) break;
      const match = row.planned.result?.results.find((item) => matchesGold(item, row.fixture.match));
      if (!match) row.read = { state: "not_retrieved", reason: "No designated primary document returned by planned retrieval; no gold-URL fallback was fetched" };
      else {
        // Use the actual returned URL, not fixture.goldUrl. Read windows are disclosed fixture inputs.
        row.read = { state: "started", request: { url: match.url, ...row.fixture.readProbe,
          ...(row.fixture.dateFrom ? { dateFrom: row.fixture.dateFrom } : {}), dateTo: row.fixture.dateTo } };
        const started = performance.now();
        try {
          row.read.result = await reader.read(row.read.request, controller.signal);
          row.read.state = "succeeded";
          row.read.coverage = coverage(row.read.result, row.fixture.anchors);
        } catch (error) { row.read.state = "failed"; row.read.error = safeError(error); }
        finally { row.read.elapsedMs = Math.round(performance.now() - started); }
      }
      await save();
      console.log(JSON.stringify({ case: row.fixture.id, baselineRank: row.baseline.hitRank, plannedRank: row.planned.hitRank,
        read: row.read.state, allAnchors: row.read.coverage?.allAnchors ?? false }));
    }
    report.status = controller.signal.aborted ? "cancelled" : "completed";
  } catch (error) { report.status = "failed"; report.error = safeError(error); process.exitCode = 1; }
  finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    report.finishedAt = new Date().toISOString(); await save();
  }
  if (report.status === "cancelled") process.exitCode = 130;
  console.log(JSON.stringify({ status: report.status, reportPath, summary: report.summary }, null, 2));
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : "Search audit failed"); process.exitCode = 1; }
