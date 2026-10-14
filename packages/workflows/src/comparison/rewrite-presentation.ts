/** Display angle characters without seeding ASCII markup in Rewrite model material. */
export function rewritePresentation(text: string): string {
  return text.replaceAll("<", "＜").replaceAll(">", "＞");
}
import type { AgentBinding, JsonObject } from "@eval/contracts";
import type { RewriteItem } from "@eval/agents/rewrite";


/** Both workflows expose semantic slot identities; the model owns only their text. */
export function bindRewriteItems(input: JsonObject & { items: RewriteItem[] }): AgentBinding {
  return {
    agent: "rewrite", profile: "default", request: { input, sources: {} },
    modelInput: { ...input, items: input.items.map((item) => ({
      ...item, label: rewritePresentation(item.label), text: rewritePresentation(item.text),
      ...(item.context !== undefined ? { context: rewritePresentation(item.context) } : {}),
    })) },
  };
}
