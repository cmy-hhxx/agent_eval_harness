import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { errorText, redact, type JsonObject } from "@eval/contracts";
import { readJson, writeJson } from "@eval/data";
import { assertStatisticsLog } from "@eval/workflows/comparison";
import { uploadStatisticsReport } from "./report-upload.js";

interface CachedRelayRecord {
  traceId: string;
  logUrl: string;
  record: JsonObject;
  status: "sending" | "uploaded" | "pending" | "uncertain";
  claimedAt: number;
  updatedAt: number;
  requestId?: string;
  error?: string;
}
interface RelayState { records: Record<string, CachedRelayRecord> }

const args = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
  once: { type: "boolean" }, server: { type: "string" }, state: { type: "string" },
  resolve: { type: "string" }, outcome: { type: "string" }, "request-id": { type: "string" },
  help: { type: "boolean" },
} });
if (args.values.help) {
  console.log(`report:relay --once [--server URL] [--state FILE]
report:relay --resolve TRACE_ID --outcome written --request-id ID
report:relay --resolve TRACE_ID --outcome retry
Environment: WORKBENCH_SERVER_URL, WORKBENCH_RELAY_TOKEN, WORKBENCH_RELAY_STATE`);
  process.exit(0);
}
const server = (args.values.server || process.env.WORKBENCH_SERVER_URL || "").replace(/\/$/, "");
const token = process.env.WORKBENCH_RELAY_TOKEN || "";
const stateFile = path.resolve(args.values.state || process.env.WORKBENCH_RELAY_STATE ||
  path.join(os.homedir(), ".agent-eval-workbench", "report-relay.json"));
if (!server || !/^https?:\/\//.test(server)) throw new Error("Missing or invalid --server/WORKBENCH_SERVER_URL");
if (!token) throw new Error("Missing WORKBENCH_RELAY_TOKEN");

function endpoint(suffix: string) { return `${server}/runtime/api/relay/records${suffix}`; }
function headers(json = false) { return { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : {}) }; }
async function serverJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...headers(Boolean(init?.body)), ...(init?.headers || {}) },
    redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const value = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(`Workbench relay API HTTP ${response.status}: ${String(value.error || response.statusText)}`);
  return value as T;
}
async function loadState(): Promise<RelayState> {
  try {
    const value = await readJson<RelayState>(stateFile);
    if (!value || typeof value !== "object" || !value.records || typeof value.records !== "object" || Array.isArray(value.records))
      throw new Error("Invalid relay state: " + stateFile);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: {} };
    throw error;
  }
}
const state = await loadState();
const save = () => writeJson(stateFile, state);

async function resolveServer(traceId: string, outcome: "written" | "retry", requestId?: string) {
  return serverJson(endpoint(`/${encodeURIComponent(traceId)}/resolve`), { method: "POST",
    body: JSON.stringify(outcome === "written" ? { outcome, requestId } : { outcome }) });
}

async function cachedReceipts() {
  for (const item of Object.values(state.records)) {
    if (item.status === "uploaded" && item.requestId) {
      try {
        await serverJson(endpoint(`/${encodeURIComponent(item.traceId)}/receipt`), { method: "POST",
          body: JSON.stringify({ status: "uploaded", requestId: item.requestId }) });
        item.status = "uploaded"; item.updatedAt = Date.now(); await save();
      } catch (error) { console.error(`回执回写失败 ${item.traceId}: ${redact(errorText(error), [token])}`); return false; }
    } else if (item.status === "sending") {
      item.status = "uncertain"; item.error = "relay stopped after claiming the record; verify whether the external POST was accepted";
      item.updatedAt = Date.now();
      try {
        await serverJson(endpoint(`/${encodeURIComponent(item.traceId)}/receipt`), { method: "POST",
          body: JSON.stringify({ status: "uncertain", error: item.error }) });
      } catch { /* The local state keeps the uncertain receipt for the next run. */ }
      await save();
    }
  }
  return true;
}

if (args.values.resolve) {
  if (!args.values.outcome || !["written", "retry"].includes(args.values.outcome)) throw new Error("--outcome must be written or retry");
  if (args.values.outcome === "written" && !args.values["request-id"]) throw new Error("written requires --request-id");
  await resolveServer(args.values.resolve, args.values.outcome as "written" | "retry", args.values["request-id"]);
  console.log("统计记录状态已更新");
  process.exit(0);
}
if (!args.values.once) throw new Error("Only --once is supported; schedule this command externally");

if (!await cachedReceipts()) process.exitCode = 2;
else {
  const pending = await serverJson<Array<{ traceId: string; logUrl: string; record: JsonObject }>>(endpoint(""));
  for (const item of pending) {
    assertStatisticsLog(item.record);
    const claimed = await serverJson<CachedRelayRecord>(endpoint(`/${encodeURIComponent(item.traceId)}/claim`), { method: "POST" });
    const cached: CachedRelayRecord = { traceId: item.traceId, logUrl: claimed.logUrl || item.logUrl, record: item.record,
      status: "sending", claimedAt: Date.now(), updatedAt: Date.now() };
    state.records[item.traceId] = cached;
    await save();
    const result = await uploadStatisticsReport(cached.logUrl, cached.record);
    if (result.status === "uploaded") {
      cached.status = "uploaded"; cached.requestId = result.requestId; cached.updatedAt = Date.now(); await save();
      try {
        await serverJson(endpoint(`/${encodeURIComponent(item.traceId)}/receipt`), { method: "POST",
          body: JSON.stringify({ status: "uploaded", requestId: result.requestId }) });
      } catch (error) { console.error(`回执待补写 ${item.traceId}: ${redact(errorText(error), [token])}`); process.exitCode = 2; break; }
      console.log(`已上传 ${item.traceId}`);
      continue;
    }
    cached.status = result.status; cached.error = result.error; cached.updatedAt = Date.now(); await save();
    try {
      await serverJson(endpoint(`/${encodeURIComponent(item.traceId)}/receipt`), { method: "POST",
        body: JSON.stringify({ status: result.status, error: result.error }) });
    } catch (error) { console.error(`失败状态待补写 ${item.traceId}: ${redact(errorText(error), [token])}`); process.exitCode = 2; break; }
    console.error(`${result.status === "uncertain" ? "结果不确定，已停止自动重发" : "目标明确拒绝，等待稍后重试"} ${item.traceId}: ${redact(result.error, [token])}`);
    process.exitCode = 2;
    break;
  }
}
