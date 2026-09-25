import path from "node:path";
import { createFileLogger } from "@eval/data";
const [directory, worker] = process.argv.slice(2);
const logger = createFileLogger({
  directory: path.join(directory, "log"),
  lockDirectory: path.join(directory, "locks"),
});
for (let i = 0; i < 10; i++) {
  const id = i === 0 ? "shared" : `${worker}-${i}`;
  if (
    !(await logger.evaluation({
      time: new Date().toISOString(),
      workflow: "test",
      run_id: "run",
      task_id: id,
      attempt_id: id,
      submission_id: id,
      stage: "test",
      result: { text: "中文🙂\n".repeat(20_000) },
    }))
  )
    throw new Error("Log write failed");
}
await logger.error("shared failure", { component: "test", event: "failed", run_id: "run", task_id: worker });
