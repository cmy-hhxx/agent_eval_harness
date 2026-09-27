import { readdir } from "node:fs/promises";
import path from "node:path";
import { root, run } from "./lib.mjs";

const roots = ["dist/packages", "dist/agent/tests", "dist/tests/architecture", "dist/tests/integration/host"];
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
await run("node", ["--test", ...files]);
