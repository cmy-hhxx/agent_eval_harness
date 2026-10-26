import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { root, run } from "./lib.mjs";

const full = process.argv.includes("--full");
const fast = process.argv.includes("--fast");
const workerPattern = [
  "exhausted exploration budget still permits submission",
  "file loading feedback cannot renew exhausted protected writers",
  "SDK malformed submission",
  "three malformed SDK submissions",
  "SDK argument repair rejects",
  "same-run recovery counts a malformed final",
  "inspection and preservation",
  "inspection and final submission preserve one content queue",
  "inspection preserves original JSON fields",
  "a session that stops before submitting",
  "a session that ignores the nudge",
  "a session stopping after rejected submission",
  "a session resumes after automatic material delivery",
  "unsubmitted no-submission recovery",
  "unsubmitted idle recovery",
].join("|");
const fastFiles = [
  "dist/packages/agents/src/attribution/contract.test.js",
  "dist/packages/agents/src/comparison/current-contract.test.js",
  "dist/packages/agents/src/clustering/profile.test.js",
  "dist/packages/contracts/src/evidence-selection.test.js",
  "dist/packages/data/src/repository.test.js",
  "dist/packages/data/src/run-journal.test.js",
  "dist/packages/data/src/statistics-log.test.js",
  "dist/packages/host/src/scheduling.test.js",
  "dist/packages/host/src/store-concurrency.test.js",
  "dist/packages/runtime/src/sdk-utils.test.js",
  "dist/packages/tools/src/evidence.test.js",
  "dist/packages/tools/src/required-reading.test.js",
  "dist/packages/workflows/src/answer-review/resume.test.js",
  "dist/packages/workflows/src/comparison/attribution-contract.test.js",
  "dist/packages/workflows/src/comparison/optional-verification.test.js",
  "dist/packages/workflows/src/comparison/relative-preference.test.js",
  "dist/packages/workflows/src/comparison/simple-flow.test.js",
  "dist/packages/workflows/src/comparison/standalone-resumption.test.js",
  "dist/packages/workflows/src/review/public-trace.test.js",
  "dist/tests/architecture/dependencies.test.js",
  "scripts/attribution-review-tree.test.mjs",
  "scripts/attribution-review-view.test.mjs",
  "scripts/benchmark.test.mjs",
  "data_service/dashboard.test.mjs",
];
if (fast) {
  await Promise.all([
    run("node", ["--test", "--test-concurrency=2", ...fastFiles]),
    run("node", ["--test", "--test-name-pattern=" + workerPattern, "dist/packages/runtime/src/worker.test.js"]),
  ]);
  process.exit(0);
}
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
await Promise.all([
  run("python3", ["-m", "unittest", "discover", "-s", "data_service", "-p", "test_*.py"]),
  run("node", [
    "--test",
    `--test-concurrency=${concurrency}`,
    ...files,
    "scripts/attribution-review-tree.test.mjs",
    "scripts/attribution-review-view.test.mjs",
    "scripts/attribution-review.test.mjs",
    "scripts/mongo-contracts.test.mjs",
    "scripts/benchmark.test.mjs",
    "scripts/publish.test.mjs",
    "scripts/apply-agent-dependency-patches.test.mjs",
    "scripts/deploy-workbench.test.mjs",
    "scripts/workbench.test.mjs",
    "scripts/configure-daily-workbench.test.mjs",
    "scripts/deploy-eris.test.mjs",
    "data_service/dashboard.test.mjs",
  ]),
]);
