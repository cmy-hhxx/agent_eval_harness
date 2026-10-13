import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuildRunOverviews } from "../dist/packages/data/src/index.js";
import { analysisRunOverview } from "../dist/packages/workflows/src/comparison/index.js";

const directory = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../data/runs/comparison", import.meta.url)));
const updated = await rebuildRunOverviews(directory, analysisRunOverview);
console.log(JSON.stringify({ directory, updated }));
