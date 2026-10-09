import path from "node:path";
import type { AssistantTool } from "@eval/contracts";
import { ArtifactStore, assistantDirectory } from "@eval/data";
import { executeCode } from "@eval/tools";

/** Code and its outputs belong to this conversation, independently of evaluation runs. */
export class LocalAnalysisCode {
  constructor(readonly directory: string, readonly python: string) {}
  execute: AssistantTool["execute"] = async (args, context) => {
    const workdir = path.join(assistantDirectory(this.directory, context.scope), "code");
    const result = await executeCode({ workdir, execution: { python: this.python },
      artifacts: new ArtifactStore(path.join(workdir, "artifacts")), audit: { artifacts: [] },
      policy: { codeTimeoutSeconds: 60, maxOutputChars: 4000 },
    }, args, context.signal);
    // Keep one copy of the receipt; full stdout/stderr remain readable by artifact ID.
    return { content: result.content, isError: result.isError };
  };
  read: AssistantTool["execute"] = async (value, context) => {
    const { id, offset = 0, limit = 8000 } = value as { id: string; offset?: number; limit?: number };
    const store = new ArtifactStore(path.join(assistantDirectory(this.directory, context.scope), "code/artifacts"));
    const text = Buffer.from(await store.get(id)).toString("utf8");
    context.signal.throwIfAborted();
    const end = Math.min(text.length, offset + limit);
    return { content: [{ type: "text", text: JSON.stringify({ id, text: text.slice(offset, end),
      total: text.length, offset, limit, unit: "characters", hasMore: end < text.length, nextOffset: end < text.length ? end : null }) }] };
  };
}
