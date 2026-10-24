import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AssistantSessions } from "@eval/runtime/assistant";
import { AssistantJournal } from "@eval/data";
import { object, type AssistantScope, type JsonObject, type ModelConfig } from "@eval/contracts";

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const channel of ["projections", "follow"] as const) {
test(`${channel} waits for durable writes including writes queued while reading`, { timeout: 10000 }, async t => {
  const directory = await mkdtemp(tmpdir() + "/assistant-projection-writes-");
  const firstEntered = gate(), releaseFirst = gate(), secondEntered = gate(), releaseSecond = gate();
  const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model: {} as ModelConfig, systemPrompt: "test", tools: [],
    ownership: { async locate() { return undefined; }, async claim() { return async () => {}; } } });
  const pending: Promise<unknown>[] = [];
  const scope = await sessions.create("alice");
  const controller = new AbortController();
  let follow: AsyncIterator<unknown> | undefined;
  try {
    await sessions.rename(scope, "initial");
    const append = AssistantJournal.prototype.append;
    t.mock.method(AssistantJournal.prototype, "append", async function (this: AssistantJournal, record: Parameters<AssistantJournal["append"]>[0]) {
      if (record.kind === "event" && record.event.type === "session/title") {
        if (record.event.data.title === "first pending") { firstEntered.resolve(); await releaseFirst.promise; }
        if (record.event.data.title === "second pending") { secondEntered.resolve(); await releaseSecond.promise; }
      }
      return append.call(this, record);
    });
    const first = sessions.rename(scope, "first pending");
    pending.push(first.catch(() => {}));
    await firstEntered.promise;
    let settled = false;
    let baseline: JsonObject | undefined;
    const reading = (channel === "projections" ? sessions.projections(scope) : (async () => {
      follow = sessions.events(scope, AbortSignal.any([controller.signal, t.signal]))[Symbol.asyncIterator]();
      const next = await follow.next();
      assert.equal(next.done, false);
      baseline = object(next.value);
      return baseline.projections;
    })()).then(snapshot => { settled = true; return object(snapshot); });
    pending.push(reading.catch(() => {}));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, "an uncommitted title must not be attached to the preceding cut");
    const second = sessions.rename(scope, "second pending");
    pending.push(second.catch(() => {}));
    releaseFirst.resolve(); await secondEntered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, "the read must also wait for writes enqueued during its first await");
    releaseSecond.resolve(); await Promise.all([first, second]);
    const snapshot = await reading;
    assert.equal(snapshot.asOfSeq, 2);
    assert.equal(object(snapshot.values).title, "second pending");
    if (baseline) {
      assert.equal(baseline.type, "snapshot");
      assert.equal(baseline.cursor, 2);
      assert.deepEqual((baseline.records as JsonObject[]).map(record => object(record.event).seq), [0, 1, 2]);
    }
    if (follow) {
      await sessions.rename(scope, "first following event");
      const next = await follow.next(), frame = object(next.value), event = object(frame.event);
      assert.equal(next.done, false);
      assert.equal(frame.type, "event");
      assert.equal(event.seq, 3);
      assert.equal(object(event.data).title, "first following event", "events arriving after the snapshot stay buffered until the next pull");
    }
  } finally {
    releaseFirst.resolve(); releaseSecond.resolve();
    await Promise.allSettled(pending);
    controller.abort(); await follow?.return?.();
    await sessions.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
}

for (const phase of ["opening", "changed"] as const) {
  test(`control ${phase} projection uses one authoritative cut and emits each cut once`, { timeout: 10000 }, async () => {
    const directory = await mkdtemp(tmpdir() + "/assistant-control-");
    const projectionEntered = gate(), releaseProjection = gate(), nextPollEntered = gate(), releaseNextPoll = gate();
    class InterleavedSessions extends AssistantSessions {
      holdProjection = false;
      polls = 0;
      override async list(userId: string) {
        if (++this.polls === (phase === "opening" ? 3 : 4)) {
          nextPollEntered.resolve();
          await releaseNextPoll.promise;
        }
        return super.list(userId);
      }
      override async projections(scope: AssistantScope) {
        if (this.holdProjection) {
          this.holdProjection = false;
          projectionEntered.resolve();
          await releaseProjection.promise;
        }
        return super.projections(scope);
      }
    }
    const sessions = new InterleavedSessions({ directory, url: "http://127.0.0.1:1", model: {} as ModelConfig, systemPrompt: "test", tools: [] });
    const controller = new AbortController(), control = sessions.changes("alice", controller.signal, "control");
    const readBatch = async (first: IteratorResult<unknown>, snapshot: JsonObject) => {
      const frames = [object(first.value)], values = object(snapshot.values);
      assert.equal(first.done, false);
      for (let index = 1; index < Object.keys(values).length; index++) {
        const next = await control.next();
        assert.equal(next.done, false);
        frames.push(object(next.value));
      }
      assert(frames.every(frame => frame.type === "projection" && frame.sessionId === scope.sessionId && frame.seq === snapshot.asOfSeq));
      assert.deepEqual(Object.fromEntries(frames.map(frame => [frame.key, frame.value])), values);
    };
    const scope = await sessions.create("alice");
    try {
      await sessions.rename(scope, "initial");
      if (phase === "changed") {
        const baseline = object((await control.next()).value);
        assert.equal(object(object(object(baseline.value).projections)[scope.sessionId]).asOfSeq, 0);
        await sessions.rename(scope, "list cut");
      }
      sessions.holdProjection = true;
      const reading = control.next();
      await projectionEntered.promise;
      await sessions.rename(scope, "projection cut");
      const snapshot = object(await sessions.projections(scope));
      assert.equal(snapshot.asOfSeq, phase === "opening" ? 1 : 2);
      releaseProjection.resolve();
      if (phase === "opening") {
        const baseline = object((await reading).value);
        assert.equal(baseline.type, "baseline");
        assert.deepEqual(object(object(baseline.value).projections)[scope.sessionId], snapshot);
      } else await readBatch(await reading, snapshot);

      const following = control.next();
      assert.equal(await Promise.race([
        following.then(() => "duplicate cut"),
        nextPollEntered.promise.then(() => "next poll"),
      ]), "next poll", "a list catching up to an already delivered projection cut must not emit it again");
      await sessions.rename(scope, "next cut");
      const nextSnapshot = object(await sessions.projections(scope));
      assert.equal(nextSnapshot.asOfSeq, Number(snapshot.asOfSeq) + 1);
      releaseNextPoll.resolve();
      await readBatch(await following, nextSnapshot);
    } finally {
      controller.abort(); releaseProjection.resolve(); releaseNextPoll.resolve();
      await control.return(undefined); await sessions.dispose(); await rm(directory, { recursive: true, force: true });
    }
  });
}
