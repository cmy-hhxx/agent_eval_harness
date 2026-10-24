import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { root, run } from "./lib.mjs";

const full = process.argv.includes("--full");
const roots = [
  "dist/packages",
  "dist/tests/architecture",
  ...(full ? ["dist/agent/tests", "dist/tests/integration/host"] : []),
];
const files = (
  await Promise.all(
    roots.map(async (directory) =>
      (
        await readdir(path.join(root, directory), { recursive: true })
      )
        .filter((file) => file.endsWith(".test.js"))
        .map((file) => path.join(directory, file)),
    ),
  )
)
  .flat()
  .sort();
// Worker tests spawn their own processes; cap file concurrency to avoid starving
// their existing deadlines without extending timeouts or retrying failed tests.
const concurrency = Math.min(2, availableParallelism());
await run("python3", ["-m", "unittest", "discover", "-s", "server_dashboard_ths", "-p", "test_*.py"]);
await run("node", [
  "--test",
  `--test-concurrency=${concurrency}`,
  ...files,
  "scripts/attribution-review-tree.test.mjs",
  "scripts/attribution-review-view.test.mjs",
  "scripts/attribution-review.test.mjs",
  "scripts/attribution-tree-document.test.mjs",
  "scripts/topic-problem-documents.test.mjs",
  "scripts/topic-clustering-scope.test.mjs",
  "scripts/benchmark.test.mjs",
  "scripts/publish.test.mjs",
  "scripts/deploy-workbench.test.mjs",
  "scripts/configure-daily-workbench.test.mjs",
  "server_dashboard_ths/dashboard.test.mjs",
]);
