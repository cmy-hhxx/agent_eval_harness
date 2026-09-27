import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, type AssistantEvent, type AssistantPrompt, type AssistantRecord, type AssistantScope, type AssistantSessionState } from "@eval/contracts";
import { exists, readJson, runLock, writeJson } from "./files.js";

export function assistantUser(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error("Invalid user identifier");
  return value;
}
export function assistantId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid session or operation identifier");
  return value;
}
export function assistantDirectory(root: string, scope: AssistantScope): string {
  return path.join(root, "users", assistantUser(scope.userId), "sessions", assistantId(scope.sessionId));
}
export interface AssistantOwner { pid: number; instanceId: string; url: string; lockToken?: string }
export async function assistantOwner(root: string, scope: AssistantScope): Promise<AssistantOwner | undefined> {
  const directory = assistantDirectory(root, scope);
  if (!(await exists(path.join(directory, ".run-lock")))) return;
  const owner = await readJson<AssistantOwner>(path.join(directory, "owner.json")).catch(() => undefined);
  if (!owner) return;
  const lock = await readJson<{ pid: number; token: string }>(path.join(directory, ".run-lock")).catch(() => undefined);
  if (!lock || lock.pid !== owner.pid || lock.token !== owner.lockToken) return;
  try { process.kill(owner.pid, 0); return owner; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
export async function ownAssistantSession(root: string, scope: AssistantScope, owner: AssistantOwner): Promise<() => Promise<void>> {
  const directory = assistantDirectory(root, scope);
  const release = await runLock(directory);
  try {
    const lock = await readJson<{ token: string }>(path.join(directory, ".run-lock"));
    await writeJson(path.join(directory, "owner.json"), { ...owner, lockToken: lock.token });
  }
  catch (error) { await release(); throw error; }
  return release;
}

/** One authoritative journal. Callers must hold the Session ownership lock. */
export class AssistantJournal {
  readonly records: AssistantRecord[] = [];
  readonly events: AssistantEvent[] = [];
  readonly commands = new Map<string, AssistantPrompt>();
  readonly inbox: Record<"next-turn" | "next-step", Record<string, unknown>[]> = { "next-turn": [], "next-step": [] };
  private pending = Promise.resolve();
  private constructor(readonly directory: string, readonly state: AssistantSessionState) {}
  static async create(root: string, userId: string, sessionId: string = randomUUID()): Promise<AssistantJournal> {
    const scope = { userId: assistantUser(userId), sessionId: assistantId(sessionId) };
    const directory = assistantDirectory(root, scope);
    await mkdir(path.dirname(directory), { recursive: true });
    await mkdir(directory);
    const now = Date.now();
    const state: AssistantSessionState = { ...scope, title: "新对话", createdAt: now, updatedAt: now, status: "idle", lastSeq: -1, archived: false, pinned: false, requests: {} };
    await writeJson(path.join(directory, "state.json"), state);
    return new AssistantJournal(directory, state);
  }
  static async load(root: string, scope: AssistantScope): Promise<AssistantJournal> {
    const directory = assistantDirectory(root, scope);
    const state = await readJson<AssistantSessionState>(path.join(directory, "state.json"));
    if (state.userId !== scope.userId || state.sessionId !== scope.sessionId) throw new Error("Session ownership mismatch");
    const journal = new AssistantJournal(directory, state);
    const file = path.join(directory, "events.jsonl");
    if (await exists(file)) {
      const text = await readFile(file, "utf8");
      const end = text.lastIndexOf("\n") + 1;
      // Only an uncommitted final write may be repaired; earlier malformed rows fail.
      if (end !== text.length) {
        const handle = await open(file, "r+");
        try { await handle.truncate(Buffer.byteLength(text.slice(0, end))); await handle.sync(); }
        finally { await handle.close(); }
      }
      for (const line of text.slice(0, end).split("\n").filter(Boolean)) journal.accept(JSON.parse(line) as AssistantRecord);
    }
    state.lastSeq = journal.events.at(-1)?.seq ?? -1;
    return journal;
  }
  private accept(record: AssistantRecord) {
    if (record.kind === "event") {
      if (record.event.seq !== this.events.length) throw new Error("Session event sequence gap");
      this.events.push(record.event);
      const { type, data } = record.event;
      if (type === "assistant/request") this.state.requests[String(data.requestId)] = data.status as AssistantSessionState["requests"][string];
      if (type === "agent/inbox/spliced") this.inbox[data.target as "next-turn" | "next-step"].splice(Number(data.start), Number(data.removedCount ?? 0), ...data.inserted as Record<string, unknown>[]);
      if (type === "session/title") this.state.title = String(data.title);
      if (type === "assistant/model-selection") this.state.modelSelection = data.selection as AssistantSessionState["modelSelection"];
      if (type === "assistant/model-used") this.state.modelUsed = data.selection as AssistantSessionState["modelUsed"];
      if (type === "assistant/metadata") {
        if (typeof data.archived === "boolean") this.state.archived = data.archived;
        if (typeof data.pinned === "boolean") this.state.pinned = data.pinned;
      }
      if (type === "turn/start") this.state.status = "running";
      if (type === "turn/end") this.state.status = "idle";
    } else if (record.kind === "command") {
      const old = this.commands.get(record.prompt.requestId);
      if (old && canonical(old) !== canonical(record.prompt)) throw new Error("Conflicting request identity");
      this.commands.set(record.prompt.requestId, record.prompt);
      this.state.requests[record.prompt.requestId] ??= "queued";
    }
    this.records.push(record);
  }
  async append(record: AssistantRecord): Promise<void> {
    const next = this.pending.then(async () => {
      const handle = await open(path.join(this.directory, "events.jsonl"), "a");
      try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      this.accept(record);
      if (record.kind === "event") this.state.lastSeq = record.event.seq;
      this.state.updatedAt = Date.now();
      await this.save();
    });
    this.pending = next;
    return next;
  }
  async command(prompt: AssistantPrompt): Promise<boolean> {
    const previous = this.commands.get(prompt.requestId);
    if (previous) {
      if (canonical(previous) !== canonical(prompt)) throw new Error("Request ID already used with different content");
      return false;
    }
    await this.append({ kind: "command", prompt });
    return true;
  }
  async save(): Promise<void> { await writeJson(path.join(this.directory, "state.json"), this.state); }
  async flush(): Promise<void> { await this.pending; }
}

export async function listAssistantSessions(root: string, userId: string): Promise<AssistantSessionState[]> {
  const directory = path.join(root, "users", assistantUser(userId), "sessions");
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const states = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const file = path.join(directory, entry.name, "state.json");
    if (!(await exists(file))) return undefined;
    const state = await readJson<AssistantSessionState>(file);
    if (state.userId !== userId || state.sessionId !== entry.name) throw new Error("Session ownership mismatch");
    return state;
  }));
  return states.filter((state): state is AssistantSessionState => !!state).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function writeAssistantArtifact(root: string, scope: AssistantScope, text: string): Promise<{ id: string; name: string; bytes: number }> {
  const id = randomUUID(), name = `${id}.md`;
  const directory = path.join(assistantDirectory(root, scope), "artifacts");
  await mkdir(directory, { recursive: true });
  const handle = await open(path.join(directory, name), "wx");
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  return { id, name, bytes: (await stat(path.join(directory, name))).size };
}
export async function readAssistantArtifact(root: string, scope: AssistantScope, id: string): Promise<Buffer> {
  const directory = assistantDirectory(root, scope);
  const state = await readJson<AssistantSessionState>(path.join(directory, "state.json"));
  if (state.userId !== scope.userId || state.sessionId !== scope.sessionId) throw new Error("Session ownership mismatch");
  return readFile(path.join(directory, "artifacts", `${assistantId(id)}.md`));
}

export async function readAssistantFavorites(root: string, userId: string): Promise<string[] | undefined> {
  const file = path.join(root, "users", assistantUser(userId), "preferences", "models.json");
  if (!(await exists(file))) return undefined;
  const value = await readJson<{favorites: string[]}>(file);
  if (!Array.isArray(value.favorites) || value.favorites.some(id => typeof id !== "string")) throw new Error("Invalid model preferences");
  return value.favorites;
}
export async function writeAssistantFavorites(root: string, userId: string, favorites: string[]): Promise<void> {
  const directory = path.join(root, "users", assistantUser(userId), "preferences");
  await mkdir(directory, {recursive: true});
  const release = await runLock(directory);
  try { await writeJson(path.join(directory, "models.json"), {favorites}); } finally { await release(); }
}
