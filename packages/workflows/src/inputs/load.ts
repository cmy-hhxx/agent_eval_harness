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
  // Consecutive atomic tasks share one immutable record. A new input replaces it;
  // the run never accumulates the parsed bodies of its entire input catalog.
  let last: { id: string; value: unknown } | undefined;
  const config = manifest.config as EvaluationConfig;
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
          if (last?.id !== candidate.input_id) last = { id: candidate.input_id,
            value: projectInput(JSON.parse(fileSourceReader.record(source, byteOffset, byteLength, revision))) };
          return last.value;
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
