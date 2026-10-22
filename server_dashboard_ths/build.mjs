import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("records.js", import.meta.url))],
  outfile: fileURLToPath(new URL("records.bundle.js", import.meta.url)),
  bundle: true, minify: true, format: "iife", globalName: "DataRecords", platform: "browser", target: "es2022", legalComments: "inline",
});
