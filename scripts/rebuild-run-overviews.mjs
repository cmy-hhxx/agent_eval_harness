import path from "node:path";
import { rebuildRunOverviews } from "../dist/packages/data/src/index.js";
import { analysisRunOverview } from "../dist/packages/workflows/src/comparison/index.js";

if (!process.argv[2]) throw new Error("Specify the run directory under the source's eval_output");
const directory = path.resolve(process.argv[2]);
const updated = await rebuildRunOverviews(directory, analysisRunOverview);
console.log(JSON.stringify({ directory, updated }));
