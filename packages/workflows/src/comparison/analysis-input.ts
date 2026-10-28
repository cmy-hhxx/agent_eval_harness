import { readJson, locateRun } from "@eval/data";
import { locateRecordStream } from "../inputs/records.js";
import type { Checkpoint } from "./checkpoint.js";
import type { EvalConfig } from "./types.js";

/** Read the authoritative run index without copying source bodies. */
async function checkpoint(run: string): Promise<Checkpoint> {
  const value = await readJson<Checkpoint>(locateRun(run).stateFile);
  if (value.format !== "evaluation-run") throw new Error("无效的运行状态");
  return value;
}

/** Business ID -> locator -> source body; no raw input is copied into a run. */
export async function locateAnalysisInput(run: string, inputId: string) {
  const saved = await checkpoint(run);
  const candidate = saved.inputs[inputId];
  if (!candidate) throw new Error("输入未登记：" + inputId);
  return { run, inputId, candidate: { ...candidate, input_id: inputId }, config: saved.config as EvalConfig };
}

export async function readAnalysisInput(locator: Awaited<ReturnType<typeof locateAnalysisInput>>) {
  const { candidate, config } = locator;
  const version = config.inputs.versions.find((entry) => entry.id === candidate.version);
  if (!version) throw new Error("输入版本未登记：" + candidate.version);
  return (await locateRecordStream(candidate.source, candidate, version, config.inputs.default_batch_id)).raw;
}
