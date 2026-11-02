import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { canonical, errorText, HttpError, object } from "@eval/contracts";
import { completedCaseKey, fileSourceReader, readCompletedCases, runLayout } from "@eval/data";
import { adapt, type Candidate, type VersionConfig } from "@eval/workflows/inputs";
import { expandComparisonPairs, type EvalConfig } from "@eval/workflows/comparison";
import type { HostConfig } from "@eval/host-app/config";
import { consolePath } from "./files.js";

export interface DataCheck {
  status: "checking" | "ready" | "failed";
  files: number; bytes: number; checkedFiles: number; readRecords: number;
  validRecords: number; invalidRecords: number; total: number; skipped: number; pending: number; unavailable: number;
  unit: "条回答" | "场对比";
  models: { name: string; files: number; records: number }[];
  destinations: string[];
  issues: { file: string; line?: number; reason: string }[];
  elapsedMs: number; checkedAt?: string; error?: string;
}

export function commonInputDirectory(versions: VersionConfig[]) {
  const directories = versions.flatMap(v => v.sources.map(s => s.kind === "file" ? path.dirname(s.path) : s.path));
  let root = directories[0];
  while (directories.some(dir => dir !== root && !dir.startsWith(root + path.sep)) && path.dirname(root) !== root) root = path.dirname(root);
  return root;
}

/** Match declared model names, never infer a model from arbitrary source content. */
export async function parentInputs(directory: unknown, versions: VersionConfig[], roots: string[]) {
  const root = await consolePath(directory, roots, true);
  if (root.kind !== "directory") throw new HttpError(400, "评测输入请填写父目录");
  const inputs: Record<string, string[]> = Object.fromEntries(versions.map(v => [v.id, []]));
  let ignored = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || /^(?:\d+[_-])?(?:archive|7z_data|eval_output)$/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const names = new Set([...path.relative(root.path, file).split(path.sep).slice(0, -1), path.basename(root.path), path.basename(file, ".jsonl")].map(s => s.toLowerCase()));
      const matches = versions.filter(v => [v.id, v.name, v.display_name].some(name => name && names.has(name.toLowerCase())));
      if (matches.length > 1) throw new HttpError(400, "输入文件对应多个模型，请调整目录: " + file);
      if (matches.length) inputs[matches[0].id].push(file); else ignored++;
    }
  };
  await walk(root.path);
  for (const version of versions) {
    inputs[version.id].sort();
    if (!inputs[version.id].length) throw new HttpError(400, "目录中未找到 " + version.name + " 的 JSONL 文件");
  }
  return { directory: root.path, inputs, ignored };
}

export function emptyDataCheck(workflow: string): DataCheck {
  return { status: "checking", files: 0, bytes: 0, checkedFiles: 0, readRecords: 0, validRecords: 0, invalidRecords: 0,
    total: 0, skipped: 0, pending: 0, unavailable: 0, unit: workflow === "comparison" ? "场对比" : "条回答",
    models: [], destinations: [], issues: [], elapsedMs: 0 };
}

/** One streaming pass, no task graph, evidence expansion, Worker, model call or copied input. */
export async function checkData(host: HostConfig, check: DataCheck, signal: AbortSignal, issue: (value: DataCheck["issues"][number]) => Promise<void>, runId = "preview") {
  const started = Date.now(), config = host.evaluation;
  const pairs = host.workflow === "comparison" ? expandComparisonPairs((config as EvalConfig).comparisons) : [];
  const files = await Promise.all(config.inputs.versions.map(async version => ({ version, files: await fileSourceReader.files(version.sources) })));
  for (const item of files) {
    check.files += item.files.length;
    check.models.push({ name: item.version.display_name || item.version.name, files: item.files.length, records: 0 });
    for (const file of item.files) check.bytes += (await stat(file)).size;
  }
  const completed = config.output.layout === "business" ? await readCompletedCases(config.output.path, config.inputs.versions.map(v => v.id), pairs) : new Set<string>();
  type Row = Pick<Candidate, "batch_id" | "case_id" | "session_id" | "version" | "question" | "reference">;
  const cases = new Map<string, Map<string, Row>>(), seen = new Map<string, { file: string; line: number }>();
  const destinations = new Set<string>();
  const selection = config.inputs.records && new Map(config.inputs.records.map(r => [canonical([r.model, r.input_file, r.input_index + 1]), r]));
  const found = new Set<string>();
  const report = async (file: string, line: number | undefined, reason: string) => {
    const value = { file, line, reason };
    if (check.issues.length < 20) check.issues.push(value);
    await issue(value);
  };
  for (const [modelIndex, item] of files.entries()) for (const file of item.files) {
    signal.throwIfAborted();
    const before = await stat(file);
    const stream = createReadStream(file, { highWaterMark: 1024 * 1024, signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let index = 0;
    try {
      for await (let line of lines) {
        index++; signal.throwIfAborted();
        if (index === 1) line = line.replace(/^\uFEFF/, "");
        if (!line.trim()) continue;
        const coordinate = canonical([item.version.id, file, index]);
        if (selection && !selection.has(coordinate)) continue;
        let key: string | undefined, group: Map<string, Row> | undefined, counted = false;
        try {
          const raw = object(JSON.parse(line)), meta = object(raw.meta ?? {});
          const batch = raw.batch_id || meta.batch_id || config.inputs.default_batch_id, id = raw.case_id || meta.case_id;
          if (config.inputs.batches?.length && !config.inputs.batches.includes(String(batch)) ||
              config.inputs.case_ids?.length && !config.inputs.case_ids.includes(String(id))) continue;
          check.readRecords++; check.models[modelIndex].records++; counted = true;
          if (selection) {
            const selected = selection.get(coordinate)!;
            if (selected.batch_id !== batch || selected.case_id !== id) throw new Error("输入范围与 case 身份不一致");
            found.add(coordinate);
          }
          if (typeof batch === "string" && typeof id === "string") {
            const caseKey = canonical([batch, id]);
            group = cases.get(caseKey) ?? new Map(); cases.set(caseKey, group);
            key = canonical([batch, id, item.version.id]);
            const prior = seen.get(key);
            if (prior) throw new Error("重复 case，首次位于 " + prior.file + ":" + prior.line);
          }
          const c = adapt(raw, item.version, file, index, config.inputs.default_batch_id);
          seen.set(key!, { file, line: index });
          group!.set(c.version, { batch_id: c.batch_id, case_id: c.case_id, session_id: c.session_id,
            version: c.version, question: c.question.replace(/\s+/gu, ""), reference: c.reference });
        } catch (error) {
          if (!counted) { check.readRecords++; check.models[modelIndex].records++; }
          check.invalidRecords++;
          await report(file, index, errorText(error));
        }
        check.elapsedMs = Date.now() - started;
      }
    } finally { lines.close(); stream.destroy(); }
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("统计期间文件发生变化，请重新 Check data: " + file);
    check.checkedFiles++;
  }
  if (selection && found.size !== selection.size) throw new Error("输入范围存在缺失记录，请重新选择输入目录");
  const selectedCases = [...cases.values()].slice(0, selection ? undefined : config.inputs.limit);
  const done = (stage: string, rows: Row[]) => rows.every(row => [row.case_id, row.session_id].some(id => id &&
    completed.has(completedCaseKey(stage, rows.map(r => r.version), row.batch_id, id))));
  for (const group of selectedCases) {
    const rows = [...group.values()]; check.validRecords += rows.length;
    if (host.workflow !== "comparison") {
      for (const row of rows) {
        check.total++; if (done("attribution-session", [row])) check.skipped++;
        destinations.add(path.join(config.output.path, row.version, row.version + "_attribution-" + row.batch_id + ".jsonl"));
      }
    } else for (const pair of pairs) {
      const values = pair.map(model => group.get(model)), present = values.filter((row): row is Row => !!row);
      const reference = (row: Row) => {
        const references = new Set(rows.filter(r => r.question === row.question && r.reference !== null).map(r => canonical(r.reference)));
        return references.size === 1 ? [...references][0] : canonical(row.reference);
      };
      if (present.length !== pair.length || new Set(present.map(r => r.question)).size > 1 || new Set(present.map(reference)).size > 1) {
        check.unavailable++; continue;
      }
      check.total++; if (done("comparison", present)) check.skipped++;
      const name = [...pair].sort().join("_vs_");
      destinations.add(path.join(config.output.path, "comparison", name, name + "-" + present[0].batch_id + ".jsonl"));
    }
  }
  check.pending = check.total - check.skipped;
  check.destinations = [...destinations].sort();
  if (config.output.layout !== "business") check.destinations = [path.join(runLayout(config.output, runId).directory, "results",
    host.workflow === "comparison" ? "comparison.jsonl" : "attribution.jsonl")];
  check.elapsedMs = Date.now() - started; check.checkedAt = new Date().toISOString(); check.status = "ready";
}
