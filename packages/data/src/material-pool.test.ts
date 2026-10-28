import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MaterialPool } from "./material-pool.js";

test("concurrent sessions share one load and serialization but retain independent writable files", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "material-pool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = new MaterialPool(path.join(root, "shared")), signal = new AbortController().signal;
  let loads = 0, serializations = 0;
  const value = { messages: [{ content: "same source" }] };
  const load = async () => { loads++; return { value, display: { toJSON() { serializations++; return value; } } }; };
  const [one, two] = await Promise.all([pool.acquire("material", load, signal), pool.acquire("material", load, signal)]);
  assert.equal(loads, 1); assert.equal(serializations, 1); assert.equal(one.value, two.value);
  await Promise.all([one.copyTo(path.join(root, "one.json")), two.copyTo(path.join(root, "two.json"))]);
  const original = await readFile(path.join(root, "two.json"), "utf8");
  await writeFile(path.join(root, "one.json"), "modified by this session");
  assert.equal(await readFile(path.join(root, "two.json"), "utf8"), original);
  await one.release();
  const three = await pool.acquire("material", load, signal);
  await three.copyTo(path.join(root, "three.json"));
  assert.equal(await readFile(path.join(root, "three.json"), "utf8"), original);
  assert.equal(loads, 1);
  await Promise.all([two.release(), three.release()]);
  assert.deepEqual(await readdir(path.join(root, "shared")), []);
  const fresh = await pool.acquire("material", load, signal);
  assert.equal(loads, 2, "unused data is evicted instead of accumulating across sessions");
  await fresh.release();
});

test("one cancelled reader does not cancel another reader and failed loads do not poison the pool", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "material-pool-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = new MaterialPool(root), first = new AbortController(), second = new AbortController();
  let resolve!: (value: { value: unknown; display: unknown }) => void, sharedSignal!: AbortSignal;
  const load = (signal: AbortSignal) => { sharedSignal = signal; return new Promise<{ value: unknown; display: unknown }>(done => { resolve = done; }); };
  const cancelled = pool.acquire("shared", load, first.signal), surviving = pool.acquire("shared", load, second.signal);
  const rejected = assert.rejects(cancelled, /reader cancelled/);
  first.abort(new Error("reader cancelled"));
  await rejected;
  assert.equal(sharedSignal.aborted, false);
  resolve({ value: "source", display: "visible" });
  const lease = await surviving;
  await lease.release();
  await assert.rejects(pool.acquire("failed", async () => { throw new Error("download failed"); }, second.signal), /download failed/);
  const recovered = await pool.acquire("failed", async () => ({ value: "restored", display: "restored" }), second.signal);
  assert.equal(recovered.value, "restored");
  await recovered.release();
  assert.deepEqual(await readdir(root), []);
});

test("cancelling the last waiting session aborts its download and permits a fresh acquisition", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "material-pool-last-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = new MaterialPool(root), controller = new AbortController();
  let aborted = false;
  const pending = pool.acquire("shared", signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  }), controller.signal);
  const rejected = assert.rejects(pending, /cancel last session/);
  controller.abort(new Error("cancel last session"));
  await rejected;
  assert.equal(aborted, true);
  const fresh = await pool.acquire("shared", async () => ({ value: "fresh", display: "fresh" }), new AbortController().signal);
  assert.equal(fresh.value, "fresh");
  await fresh.release();
  assert.deepEqual(await readdir(root), []);
});
