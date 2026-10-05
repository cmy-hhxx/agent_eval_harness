/** Serializable, trusted display rules; original source coordinates and bytes stay unchanged. */
export interface SourcePresentation {
  redactions: { text: string; replacement: string }[];
  omitMessageKeys: string[];
}
const protectedKeys = new Set(["evidence_id", "evidence_index", "input_id", "source_input_id", "message_index", "path", "start", "end", "offset", "end_offset", "total_chars", "next_offset"]);

export function presentSource<T>(value: T, presentation: SourcePresentation): T {
  const rules = [...presentation.redactions].sort((a, b) => b.text.length - a.text.length);
  const replacements = new Map(rules.map(rule => [rule.text, rule.replacement]));
  const matcher = rules.length ? new RegExp(rules.map(({ text }) => {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.length < 3 ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped;
  }).join("|"), "gu") : null;
  const redact = (text: string) => matcher ? text.replace(matcher, text => replacements.get(text)!) : text;
  const visit = (value: unknown, key?: string): unknown => {
    if (key && protectedKeys.has(key)) return value;
    if (typeof value === "string") {
      if (value.startsWith("data:image/")) return value;
      // Tool evidence pages carry complete serialized messages as strings. Apply the
      // same provenance omission to their display without touching registered bytes.
      if (presentation.omitMessageKeys.length && /^\s*[\[{]/u.test(value)) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (parsed && typeof parsed === "object") return JSON.stringify(visit(parsed));
        } catch { /* Partial pages remain text and use the registered identity redactions. */ }
      }
      return redact(value);
    }
    if (Array.isArray(value)) return value.map(item => visit(item));
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (node.type === "image" && typeof node.data === "string") return structuredClone(node);
    const message = key === "input_messages" || typeof node.role === "string" ||
      ["llm_turn", "final_answer", "user_question", "message", "function_call", "function_call_output", "tool_call", "tool_result"].includes(String(node.type));
    return Object.fromEntries(Object.entries(node)
      .filter(([key]) => !message || !presentation.omitMessageKeys.includes(key))
      .map(([key, child]) => [protectedKeys.has(key) ? key : redact(key), visit(child, key)]));
  };
  return visit(value) as T;
}
