import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssistantJournal, assistantDirectory, assistantUser } from "./assistant-store.js";

test("assistant journal repairs only an uncommitted tail and derives request completion from durable events", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-journal-"));
  try {
    const journal = await AssistantJournal.create(directory, "alice");
    await journal.command({ requestId: "request", sessionId: journal.state.sessionId, mode: "queue", content: [{ type: "text", text: "read" }] });
    await journal.append({ kind: "event", event: { seq: 0, time: 1, type: "assistant/request", data: { requestId: "request", status: "completed" }, ignorable: true } });
    const file = path.join(journal.directory, "events.jsonl");
    await appendFile(file, '{"kind":');
    const recovered = await AssistantJournal.load(directory, journal.state);
    assert.equal(recovered.state.requests.request, "completed");
    assert((await readFile(file, "utf8")).endsWith("\n"));
    await appendFile(file, "malformed\n");
    await assert.rejects(AssistantJournal.load(directory, journal.state), SyntaxError);
    assert.throws(() => assistantUser("../bob"));
    assert.throws(() => assistantDirectory(directory, { userId: "alice", sessionId: "../../bob" }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
