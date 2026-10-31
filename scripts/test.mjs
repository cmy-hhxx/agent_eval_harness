import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { root, run } from "./lib.mjs";

const full = process.argv.includes("--full");
const fast = process.argv.includes("--fast");
const workerPattern = [
  "Host .*preserves the draft without spending content repairs",
  "Host validator programming error",
  "Host fault refunds only its reservation",
  "transient submission delivery retries",
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
  "token budget aborts at the model response boundary",
  "Host .*acknowledgement waits",
  "stuck session cleanup",
  "timeouts distinguish",
].join("|");
const fastFiles = [
  "dist/agent/tests/eris.test.js",
  "dist/agent/tests/assets.test.js",
  "dist/packages/host/src/channel-requests.test.js",
  "dist/packages/host/src/batch.test.js",
  "dist/packages/host/src/worker-supervisor.test.js",
  "dist/packages/host/src/checkpoint.test.js",
  "dist/packages/host/src/model-requests.test.js",
  "dist/packages/host/src/progress.test.js",
  "dist/packages/data/src/files.test.js",
  "dist/packages/agents/src/attribution/responsibility.test.js",
  "dist/packages/agents/src/comparison/current-contract.test.js",
  "dist/packages/agents/src/clustering/profile.test.js",
  "dist/packages/contracts/src/evidence-selection.test.js",
  "dist/packages/data/src/repository.test.js",
  "dist/packages/data/src/material-pool.test.js",
  "dist/packages/data/src/evaluation-collections.test.js",
  "dist/packages/data/src/run-journal.test.js",
  "dist/packages/host/src/scheduling.test.js",
  "dist/packages/host/src/failure-guard.test.js",
  "dist/packages/host/src/store-concurrency.test.js",
  "dist/packages/runtime/src/sdk-utils.test.js",
  "dist/packages/tools/src/evidence.test.js",
  "dist/packages/tools/src/required-reading.test.js",
  "dist/packages/workflows/src/comparison/attribution-contract.test.js",
  "dist/packages/workflows/src/attribution/workflow.test.js",
  "dist/packages/workflows/src/attribution/atomic.test.js",
  "dist/packages/workflows/src/attribution/component-groups.test.js",
  "dist/packages/workflows/src/attribution/session.test.js",
  "dist/packages/workflows/src/attribution/resume.test.js",
  "dist/packages/workflows/src/inputs/normalize.test.js",
  "dist/packages/workflows/src/comparison/instruction-review.test.js",
  "dist/packages/workflows/src/comparison/optional-verification.test.js",
  "dist/packages/workflows/src/comparison/relative-preference.test.js",
  "dist/packages/workflows/src/comparison/simple-flow.test.js",
  "dist/packages/workflows/src/comparison/standalone-resumption.test.js",
  "dist/packages/workflows/src/review/public-trace.test.js",
  "dist/tests/architecture/dependencies.test.js",
  "scripts/attribution-review-view.test.mjs",
  "scripts/compact-progress.test.mjs",
];
if (fast) {
  await Promise.all([
    run("node", ["--test", "--test-concurrency=2", ...fastFiles]),
    run("node", ["--test", "--test-name-pattern=" + workerPattern, "dist/packages/runtime/src/worker.test.js"]),
  ]);
  process.exit(0);
}
async function testFiles(roots) {
  return (await Promise.all(roots.map(async (directory) =>
    (await readdir(path.join(root, directory), { recursive: true }))
      .filter((file) => file.endsWith(".test.js"))
      .map((file) => path.join(directory, file)),
  ))).flat().sort();
}
const coreFiles = await testFiles(["dist/packages", "dist/tests/architecture", ...(full ? ["dist/agent/tests"] : [])]);
const hostFiles = full ? await testFiles(["dist/tests/integration/host"]) : [];
// Worker tests spawn their own processes; cap file concurrency to avoid starving
// their existing deadlines without extending timeouts or retrying failed tests.
const concurrency = Math.min(2, availableParallelism());
const repositoryTests = [
  "scripts/attribution-review-view.test.mjs",
  "scripts/compact-progress.test.mjs",
  "scripts/publish.test.mjs",
  "scripts/apply-agent-dependency-patches.test.mjs",
  "scripts/deploy-eris.test.mjs",
];
await Promise.all([
  run("node", ["--test", `--test-concurrency=${concurrency}`, ...coreFiles, ...repositoryTests]),
  ...(hostFiles.length ? [run("node", ["--test", `--test-concurrency=${concurrency}`, ...hostFiles])] : []),
]);
