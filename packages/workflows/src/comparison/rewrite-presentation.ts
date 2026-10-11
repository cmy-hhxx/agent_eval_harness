/** Display angle characters without seeding ASCII markup in Rewrite model material. */
export function rewritePresentation(text: string): string {
  return text.replaceAll("<", "＜").replaceAll(">", "＞");
}
import { ValidationError, type AgentBinding, type JsonObject } from "@eval/contracts";
import type { RewriteItem } from "@eval/agents/rewrite";


/** Both evaluation and independent clustering bind the same ordered text-only submission. */
export function bindRewriteItems(input: JsonObject & { items: RewriteItem[] }): AgentBinding {
  return {
    agent: "rewrite", profile: "default", request: { input, sources: {} },
    resolveSubmission(value) {
      const texts = (value as { texts: string[] }).texts;
      if (texts.length !== input.items.length) throw new ValidationError([{ category: "structure", code: "rewrite_slot_count", path: "/texts",
        actual: texts.length, expected: input.items.length, message: "按请求顺序返回全部文本，数量必须与槽位一致。" }]);
      return { rewrites: input.items.map((item, index) => ({ id: item.id, text: texts[index] })) };
    },
    modelInput: { ...input, items: input.items.map(({ id: _id, ...item }) => ({
      ...item, label: rewritePresentation(item.label), text: rewritePresentation(item.text),
      ...(item.context !== undefined ? { context: rewritePresentation(item.context) } : {}),
    })) },
  };
}
