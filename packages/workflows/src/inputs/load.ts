import { errorText, ValidationError, type RunManifest, type ValidationIssue } from "@eval/contracts";
import { assertSourceRevision, fileSourceReader } from "@eval/data";
import { adapt, candidateKey, inputSources, locateRecordStream } from "./records.js";
import { normalizeInput } from "./normalize.js";
import type { Candidate, EvaluationConfig } from "./types.js";

export async function loadRunInputs(
  manifest: RunManifest,
  issues?: ValidationIssue[],
  taskIds?: ReadonlySet<string>,
  records?: Map<string, Candidate>,
  projectInput: (source: unknown) => unknown = normalizeInput,
): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {},
    errors: ValidationIssue[] = [];
  const config = manifest.config as EvaluationConfig;
  // Interleaved tasks share immutable records within the admitted session window.
  // Bound retained bodies by the window and the widest task's input set, never the catalog.
  const cacheLimit = config.execution.sessionWindow * manifest.tasks.reduce((max, task) => Math.max(max, Object.keys(task.inputIds).length), 1);
  if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 1) throw new Error("输入读取需要有效的 sessionWindow");
  const cache = new Map<string, unknown>();
  const inputIds = taskIds && new Set(manifest.tasks.filter((task) => taskIds.has(task.id)).flatMap((task) => Object.values(task.inputIds)));
  const sources = inputSources((manifest.inputCatalog as Candidate[]).filter((candidate) => !inputIds || inputIds.has(candidate.input_id)));
  for (const [source, candidates] of sources) {
    const found: Record<string, unknown> = {};
    let revision: string;
    const register = (candidate: Candidate, record: Candidate, byteOffset: number, byteLength: number) => {
      records?.set(candidate.input_id, record);
      Object.defineProperty(found, candidate.input_id, {
        enumerable: true,
        configurable: true,
        get: () => {
          assertSourceRevision(source, revision);
          const value = cache.has(candidate.input_id) ? cache.get(candidate.input_id)
            : projectInput(JSON.parse(fileSourceReader.record(source, byteOffset, byteLength, revision)));
          cache.delete(candidate.input_id);
          cache.set(candidate.input_id, value);
          if (cache.size > cacheLimit) cache.delete(cache.keys().next().value!);
          return value;
        },
      });
    };
    try {
      revision = await fileSourceReader.revision(source);
      const byLine = new Map<number, Candidate[]>();
      for (const candidate of candidates)
        byLine.set(candidate.line, [...(byLine.get(candidate.line) || []), candidate]);
      for await (const { line, index, byteOffset, byteLength } of fileSourceReader.lines(source, revision)) {
        const registered = byLine.get(index);
        if (!registered) continue;
        for (const candidate of registered) {
          try {
            const version = config.inputs.versions.find((item) => item.id === candidate.version);
            if (!version) throw new Error("Input version is not registered");
            const raw = JSON.parse(line);
            const record = adapt(raw, version, source, index, config.inputs.default_batch_id);
            if (candidateKey(record) === candidateKey(candidate)) register(candidate, record, byteOffset, byteLength);
          } catch { /* Reordered or missing records are resolved by business identity below. */ }
        }
        byLine.delete(index);
        if (!byLine.size) break;
      }
      if (await fileSourceReader.revision(source) !== revision)
        throw new Error("读取期间输入文件发生变化，请重试：" + source);
    } catch (error) {
      errors.push({
        category: "file",
        code: "input_source_unavailable",
        path: source,
        expected: "可读取的原始输入文件",
        actual: null,
        message: errorText(error),
      });
      continue;
    }
    for (const candidate of candidates) {
      try {
        const version = config.inputs.versions.find((version) => version.id === candidate.version);
        if (!version) throw new Error("Input version is not registered");
        if (!Object.hasOwn(found, candidate.input_id)) {
          const { record, byteOffset, byteLength } = await locateRecordStream(source, candidate, version, config.inputs.default_batch_id);
          register(candidate, record, byteOffset, byteLength);
        }
      } catch (error) {
        errors.push({
          category: "file",
          code: "input_source_unavailable",
          path: source,
          expected: candidate.input_id,
          actual: null,
          message: errorText(error),
        });
      }
    }
    if (await fileSourceReader.revision(source).catch(() => null) !== revision) {
      errors.push({ category: "file", code: "input_source_changed", path: source,
        message: "读取期间输入文件发生变化，请重试：" + source });
    } else Object.defineProperties(inputs, Object.getOwnPropertyDescriptors(found));
  }
  if (issues) issues.push(...errors);
  else if (errors.length) throw new ValidationError(errors);
  return inputs;
}
