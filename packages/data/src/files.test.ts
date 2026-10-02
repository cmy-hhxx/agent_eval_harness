import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists, hasLiveRunOwner, runLock, writeJson } from "./files.js";

const deadOwner = { pid: 2147483647, token: "dead-owner" };

test("run lock excludes a second host and is released only by its owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".run-lock");
  assert.equal(await hasLiveRunOwner(directory), false);
  const release = await runLock(directory);
  assert.equal(await hasLiveRunOwner(directory), true);
  await assert.rejects(runLock(directory), /owned/);
  const owner = await readFile(file, "utf8");
  await writeJson(file, { pid: process.pid, token: "replacement-owner" });
  await release();
  assert.equal(await exists(file), true);
  await writeFile(file, owner);
  await release();
  assert.equal(await hasLiveRunOwner(directory), false);
  await (await runLock(directory))();
});

test("run lock reclaims a dead owner without leaving a recovery marker", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeJson(path.join(directory, ".run-lock"), deadOwner);
  assert.equal(await hasLiveRunOwner(directory), false);
  const release = await runLock(directory);
  assert.equal(await hasLiveRunOwner(directory), true);
  assert.equal(await exists(path.join(directory, ".run-lock.reclaim")), false);
  await release();
});

test("run lock refuses a recovery marker even when the owner file is absent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".run-lock"), guard = file + ".reclaim";
  await mkdir(guard);
  await assert.rejects(runLock(directory), /recovery in progress/);
  assert.equal(await exists(file), false);
  for (const owner of [deadOwner, { pid: process.pid, token: "live-owner" }]) {
    await writeJson(file, owner);
    await assert.rejects(runLock(directory), /recovery in progress/);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), owner);
  }
  assert.equal(await exists(guard), true);
});

test("malformed lock owners are never probed, reclaimed or silently replaced", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".run-lock");
  const probe = t.mock.method(process, "kill");
  for (const text of ["", "{", ...[
    null, [], {}, { pid: deadOwner.pid }, { token: "missing-pid" },
    ...[0, -1, 1.5, "123", 2147483648, Number.MAX_SAFE_INTEGER].map((pid) => ({ pid, token: "invalid-pid" })),
    ...[null, 123, "", " "].map((token) => ({ pid: deadOwner.pid, token })),
  ].map((owner) => JSON.stringify(owner))]) {
    await writeFile(file, text);
    await assert.rejects(hasLiveRunOwner(directory), /lock is incomplete/);
    await assert.rejects(runLock(directory), /lock is incomplete/);
    assert.equal(await readFile(file, "utf8"), text);
  }
  assert.equal(probe.mock.calls.length, 0);
});
