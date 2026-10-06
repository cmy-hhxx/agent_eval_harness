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
// Test files are I/O-bound; two files per core shortens the wall clock without
// starving the timing-sensitive Worker waits.
const concurrency = Math.min(24, Math.max(4, availableParallelism() * 2));
await run("node", [
  "--test",
  `--test-concurrency=${concurrency}`,
  ...files,
  "scripts/benchmark.test.mjs",
  "scripts/publish.test.mjs",
]);
