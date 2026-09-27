import { type AgentBinding, type PlannedTask } from "@eval/contracts";
import { runEvaluation, type RunOptions } from "./runner.js";

export type SingleTaskOptions = Omit<RunOptions, "plan" | "taskSource" | "concurrency" | "report"> & {
  task: PlannedTask;
  binding: AgentBinding;
  catalog?: unknown[];
};

/** An independently admitted task uses the same Worker, validation, commit and
 * recovery lifecycle as a scheduled task. It does not construct a Workflow. */
export async function runAgentTask(options: SingleTaskOptions) {
  if (Object.keys(options.task.dependencies).length) throw new Error("Resolve accepted dependencies before admitting a standalone task");
  const { task, binding, catalog, ...execution } = options;
  const inputs = Object.fromEntries(Object.values(binding.request.sources).map((source) => [source.id, source.value]));
  return runEvaluation({ ...execution, concurrency: 1,
    plan: { tasks: [task], inputs, catalog, summary: { tasks: 1 } },
    taskSource: { id: binding.agent, bind: (candidate) => {
      if (candidate.id !== task.id) throw new Error("Unexpected standalone task");
      return binding;
    } },
  });
}
