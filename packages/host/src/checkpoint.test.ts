import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type RunState } from "@eval/contracts";
import { compactCheckpointState } from "@eval/data";

test("checkpoint snapshots drop bulky review context and keep bounded diagnostics", () => {
  const huge = "里".repeat(5_000_000);
  const state: RunState = {
    manifest: {
      format: "evaluation-run", debug: false, runId: "compact", status: "running",
      engine: { engine: "pi", version: "test", commit: "test", buildId: "test" },
      evaluatorVersion: "test", config: {}, tasks: [], inputs: {}, preflight: {}, startedAt: 1,
      states: { task: {
        status: "running", attempts: 2, reason: huge,
        failure: {
          errors: Array.from({ length: 8 }, (_, index) => ({
            category: "decision", code: "code_" + index, path: "/", message: huge, expected: { huge },
          })),
          draft: { huge }, completionCandidate: { id: "candidate", attemptId: "attempt", evaluation: { huge } },
          inspection: { id: "inspection", value: { huge }, proof: { traceReads: [], viewedImages: [] } },
          evidenceBank: [], review: { quotes: [], sources: [{ id: "source", content: huge, record: {} }], actions: [], viewed: [], searches: [] },
          contentSubmissions: 2, fileErrors: 0, repeatedErrors: 1, stopped: false, attemptId: "attempt",
        },
      } },
    },
    receipts: { task: {
      taskId: "task", attemptId: "attempt", submissionId: "submission", evaluation: { ok: true }, usage: emptyUsage(),
      audit: { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [],
        review: { quotes: [], sources: [{ id: "source", content: huge, record: {} }], actions: [], viewed: [], searches: [] } },
      acceptedAt: 1, evaluatorVersion: "test", judge: "model", status: "succeeded",
    } },
    usage: emptyUsage(), recordedAttempts: 0,
  };
  const snapshot = compactCheckpointState(state), encoded = JSON.stringify(snapshot);
  assert(Buffer.byteLength(encoded) < 100_000, `${Buffer.byteLength(encoded)} bytes`);
  const failure = snapshot.manifest.states.task!.failure!;
  assert.equal(failure.errors.length, 3);
  assert.equal(failure.errors[0]!.code, "code_5");
  assert.equal(failure.errors[0]!.expected, undefined);
  assert.equal(failure.draft, undefined);
  assert.equal(failure.completionCandidate, undefined);
  assert.equal(failure.inspection, undefined);
  assert.equal(failure.review, undefined);
  assert.equal(snapshot.receipts.task!.audit.review, undefined);
  assert.equal(state.manifest.states.task!.failure!.errors.length, 8, "live recovery context is not mutated");
});
