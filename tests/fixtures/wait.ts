import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";

/** Bounded observation of a real test state; failures include the last response. */
export async function waitForTestState<T>(
  read: () => Promise<T>,
  ready: (state: T) => boolean,
  description: string,
  timeoutMs = 5000,
) {
  const deadline = performance.now() + timeoutMs;
  let latest: T;
  do {
    latest = await read();
    if (ready(latest)) return latest;
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await delay(Math.min(25, remaining));
  } while (performance.now() < deadline);
  assert.fail(`${description}; last state: ${inspect(latest!, { depth: 3, maxArrayLength: 10, maxStringLength: 500 })}`);
}
