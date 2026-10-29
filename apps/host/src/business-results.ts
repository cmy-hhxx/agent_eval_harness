import type { JsonObject, PlannedTask } from "@eval/contracts";
import { runCheckpointPrefix } from "@eval/data";
import { attributionRepository } from "@eval/workflows/attribution";
import { comparisonRepository, resultEvaluation, type TaskData } from "@eval/workflows/comparison";
import { businessResultRepository } from "@eval/workflows/review";

const adapters = {
  async readSource(run: string, ids: string[]) {
    const attribution = /^\s*\{\s*"workflow"\s*:\s*"attribution"/.test(await runCheckpointPrefix(run));
    return (attribution ? attributionRepository : comparisonRepository).readTasks(run, ids);
  },
  evaluation: (task: PlannedTask, row: JsonObject) => resultEvaluation(task.data as TaskData, row),
};
export const businessAttributionRepository = businessResultRepository(attributionRepository, adapters);
export const businessComparisonRepository = businessResultRepository(comparisonRepository, adapters);
