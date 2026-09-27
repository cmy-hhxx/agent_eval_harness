import { object, type JsonObject } from "@eval/contracts";

/** Only a leading provider envelope is reasoning; quoted tags in an answer stay text. */
export function assistantContent(blocks: JsonObject[]): JsonObject[] {
  return blocks.flatMap((block) => {
    if (block.type !== "text") return [block];
    const text = String(block.text ?? ""), opening = /^\s*<think>/.exec(text);
    if (!opening) return [block];
    const end = text.indexOf("</think>", opening[0].length);
    return [{ type: "reasoning", text: text.slice(opening[0].length, end < 0 ? undefined : end) },
      ...(end < 0 || end + 8 === text.length ? [] : [{ type: "text", text: text.slice(end + 8) }])];
  });
}

class TaggedText {
  private mode: "opening" | "reasoning" | "text" = "opening";
  private pending = "";
  private active?: { index: number; type: "reasoning" | "text"; text: string };
  private closed = false;
  constructor(private allocate: () => number) {}
  push(text: string, final = false): JsonObject[] {
    if (this.closed) return [];
    const chunks: JsonObject[] = [];
    const emit = (type: "reasoning" | "text", value: string) => {
      if (!this.active) {
        this.active = { index: this.allocate(), type, text: "" };
        chunks.push({ type: "block-start", index: this.active.index, blockType: type });
      }
      if (!value) return;
      this.active.text += value;
      chunks.push({ type: type === "text" ? "text-delta" : "reasoning-delta", index: this.active.index, text: value });
    };
    const close = () => { if (this.active) { chunks.push({ type: "block-end", index: this.active.index, block: { type: this.active.type, text: this.active.text } }); this.active = undefined; } };
    this.pending += text;
    if (this.mode === "opening") {
      const trimmed = this.pending.trimStart();
      if (trimmed.startsWith("<think>")) { this.pending = trimmed.slice(7); this.mode = "reasoning"; emit("reasoning", ""); }
      else if (!final && "<think>".startsWith(trimmed)) return [];
      else this.mode = "text";
    }
    if (this.mode === "reasoning") {
      const end = this.pending.indexOf("</think>");
      if (end >= 0) { emit("reasoning", this.pending.slice(0, end)); close(); this.pending = this.pending.slice(end + 8); this.mode = "text"; }
      else {
        let held = 0;
        if (!final) for (let n = 1; n < 8 && n <= this.pending.length; n++) if ("</think>".startsWith(this.pending.slice(-n))) held = n;
        emit("reasoning", this.pending.slice(0, this.pending.length - held));
        this.pending = held ? this.pending.slice(-held) : "";
      }
    }
    if (this.mode === "text") { if (this.pending) emit("text", this.pending); this.pending = ""; }
    if (final) { close(); this.closed = true; }
    return chunks;
  }
}

/** Pi content indices become stable upstream indices even when a text envelope splits. */
export class AssistantContentStream {
  private nextIndex = 0;
  private indices = new Map<number, number>();
  private text = new Map<number, TaggedText>();
  push(update: JsonObject): JsonObject[] {
    const source = Number(update.contentIndex ?? 0);
    if (["text_start", "text_delta", "text_end"].includes(String(update.type))) {
      let parser = this.text.get(source);
      if (!parser) { parser = new TaggedText(() => this.nextIndex++); this.text.set(source, parser); }
      return parser.push(update.type === "text_delta" ? String(update.delta ?? "") : "", update.type === "text_end");
    }
    if (!["thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"].includes(String(update.type))) return [];
    let index = this.indices.get(source);
    if (index === undefined) { index = this.nextIndex++; this.indices.set(source, index); }
    switch (update.type) {
      case "thinking_start": return [{ type: "block-start", index, blockType: "reasoning" }];
      case "thinking_delta": return [{ type: "reasoning-delta", index, text: update.delta }];
      case "thinking_end": return [{ type: "block-end", index, block: { type: "reasoning", text: update.content } }];
      case "toolcall_start": return [{ type: "block-start", index, blockType: "tool-call" }];
      case "toolcall_delta": { const block = object((object(update.partial).content as unknown[])[source]); return [{ type: "tool-call-delta", index, id: block.id, name: block.name, argumentsDelta: update.delta }]; }
      case "toolcall_end": { const call = object(update.toolCall); return [{ type: "block-end", index, block: { type: "tool-call", id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) } }]; }
      default: return [];
    }
  }
  finish(): JsonObject[] { return [...this.text.values()].flatMap((parser) => parser.push("", true)); }
}
