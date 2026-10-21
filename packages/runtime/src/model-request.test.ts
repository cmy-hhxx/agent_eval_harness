import test from "node:test";
import assert from "node:assert/strict";
import { controlledModelStream } from "./model-request.js";

test("a provider stream starts only with a permit and releases before subsequent local tool work", async () => {
  let grant!: () => void, finish!: () => void, calls = 0, released = 0;
  const gate = new Promise<void>(resolve => { grant = resolve; });
  const result = new Promise<void>(resolve => { finish = resolve; });
  const response = { result: () => result };
  const stream = controlledModelStream(async () => { calls++; return response; },
    async () => { await gate; return async () => { released++; }; }, () => undefined);
  const pending = stream();
  assert.equal(calls, 0);
  grant();
  assert.equal(await pending, response);
  assert.equal(calls, 1);
  assert.equal(released, 0);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
});

test("denied requests never reach the provider; provider startup failures release their permit", async () => {
  let calls = 0, released = 0;
  const denied = controlledModelStream(async () => { calls++; return { result: async () => {} }; },
    async () => { throw new Error("cancelled"); }, () => undefined);
  await assert.rejects(denied(), /cancelled/);
  assert.equal(calls, 0);
  const failed = controlledModelStream(async (): Promise<{ result(): Promise<void> }> => { throw new Error("provider unavailable"); },
    async () => async () => { released++; }, () => undefined);
  await assert.rejects(failed(), /provider unavailable/);
  assert.equal(released, 1);
});
