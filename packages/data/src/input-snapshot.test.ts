import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InputDownload } from "@eval/contracts";
import { replaceInputSnapshot } from "./input-snapshot.js";

async function* files(texts: string[], rows = 1, wrongSize = false): AsyncGenerator<InputDownload> {
  for (const [index, text] of texts.entries()) {
    const bytes = Buffer.from(text);
    yield { name: ["a_fast.jsonl", "b_fast.jsonl"][index], rows, size: bytes.length + Number(wrongSize),
      chunks: (async function* () { for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3); })(), close: async () => {} };
  }
}

test("snapshots validate UTF-8, row counts and length before replacing any committed source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-source-")), signal = AbortSignal.timeout(3000);
  try {
    const original = '{"answer":"中文🙂"}\n';
    let replacements = 0;
    const beforeReplace = async () => { replacements++; };
    assert.equal((await replaceInputSnapshot(directory, files([original, original]), signal, beforeReplace)).changed, true);
    const before = await stat(path.join(directory, "a_fast.jsonl"));
    assert.equal((await replaceInputSnapshot(directory, files([original, original]), signal, beforeReplace)).changed, false);
    assert.equal(replacements, 1, "unchanged downloads do not invalidate installed inputs");
    assert.equal((await stat(path.join(directory, "a_fast.jsonl"))).mtimeMs, before.mtimeMs);
    for (const invalid of [files(['{"answer":"new"}\n', '{"broken":']), files([original], 2), files([original], 1, true)]) {
      await assert.rejects(replaceInputSnapshot(directory, invalid, signal, beforeReplace));
      assert.equal(await readFile(path.join(directory, "a_fast.jsonl"), "utf8"), original);
    }
    async function* changedRemotely() { yield* files(['{"answer":"new"}\n']); throw new Error("Remote changed"); }
    await assert.rejects(replaceInputSnapshot(directory, changedRemotely(), signal, beforeReplace), /Remote changed/);
    assert.equal(await readFile(path.join(directory, "a_fast.jsonl"), "utf8"), original);
    await assert.rejects(replaceInputSnapshot(directory, files(['{"answer":"修改🙂"}\n', original]), signal,
      async () => { throw new Error("Readiness journal unavailable"); }), /Readiness journal unavailable/);
    assert.equal(await readFile(path.join(directory, "a_fast.jsonl"), "utf8"), original);
    assert.equal((await replaceInputSnapshot(directory, files(['{"answer":"修改🙂"}\n', original]), signal, beforeReplace)).changed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("aborted transfer retains the previous source and closes the response", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-abort-")), controller = new AbortController();
  let closed = false;
  try {
    await replaceInputSnapshot(directory, files(['{"old":true}\n']), controller.signal, async () => {});
    async function* interrupted() {
      yield { name: "a_fast.jsonl", rows: 1, size: 10,
        chunks: (async function* () { yield Buffer.from('{"new":'); controller.abort(); yield Buffer.from('1}\n'); })(),
        close: async () => { closed = true; } };
    }
    await assert.rejects(replaceInputSnapshot(directory, interrupted(), controller.signal, async () => assert.fail("aborted downloads cannot begin replacement")));
    assert.equal(closed, true);
    assert.equal(await readFile(path.join(directory, "a_fast.jsonl"), "utf8"), '{"old":true}\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
