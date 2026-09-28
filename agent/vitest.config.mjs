import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const vendor = path.join(root, "vendor/deepseek");
const sources = JSON.parse(readFileSync(path.join(vendor, "sources.json"), "utf8"));
export default defineConfig({
  root: vendor,
  resolve: { alias: Object.entries(sources.aliases).sort(([a], [b]) => b.length - a.length).map(([find, file]) => ({ find, replacement: path.join(vendor, file) })) },
  esbuild: { jsx: "automatic", tsconfigRaw: { compilerOptions: { experimentalDecorators: false } } },
  test: { environment: "node", include: [
    "packages/api/gateway/tests/{stream-protocol.host,stream-server.host,journal-stream.client,control-retry.client}.spec.ts",
    "packages/api/session-controller/tests/{assistant-stream.client,notifier.client,history-records.client}.spec.ts",
    "packages/client/ui-conversation/tests/{conversation-assembler.client,conversation-store.client}.spec.ts",
    "packages/client/ui-primitives/tests/markdown-{plain-text,incremental,render-units,dom-parity}.client.spec.{ts,tsx}",
    "packages/llm/llm/tests/{assistant-stream,assembler,message}.spec.ts",
    "packages/client/store/tests/store.client.spec.ts",
    "packages/client/ui-attachment/tests/message-image.client.spec.tsx",
    "packages/client/ui-model-selection/tests/{catalog.client,model-select.client}.spec.{ts,tsx}",
    "packages/llm/token-meter/tests/token-usage-projection.spec.ts",
    "packages/session/session-stats/tests/projection.spec.ts",
  ] },
});
