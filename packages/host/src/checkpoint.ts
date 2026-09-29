import type { RunState } from "@eval/contracts";

export function checkpointSnapshot(state: RunState, clone = structuredClone): RunState {
  const { receipts, ...progress } = state;
  return {
    ...clone(progress),
    // Accepted bodies are immutable. Writers replace exported references on the
    // receipt, so copy each receipt wrapper while sharing its committed payload.
    receipts: Object.fromEntries(Object.entries(receipts).map(([id, receipt]) => [id, { ...receipt }])),
  };
}
