import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalAnalysisCode } from "../../../apps/host/src/assistant-code.js";
import { ROOT } from "../../fixtures/services.js";

test("Eris code verifies calculations, persists files and progressively reads large output within its session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-code-"));
  const code = new LocalAnalysisCode(directory, path.join(ROOT, ".venv/bin/python"));
  const context = { scope: { userId: "test", sessionId: crypto.randomUUID() }, callId: "code", signal: new AbortController().signal, progress() {} };
  try {
    const result = await code.execute({ language: "python", code: 'from decimal import Decimal\nfrom pathlib import Path\nassert Decimal("0.1") + Decimal("0.2") == Decimal("0.3")\nPath("check.txt").write_text("passed")\nprint("核验" * 20000)', outputs: ["check.txt"] }, context);
    assert(!result.isError);
    const receipt = JSON.parse(result.content[0].text!);
    assert.equal(receipt.exit_code, 0);
    assert.equal(receipt.stdout.length, 4000);
    assert.equal(result.details, undefined, "large receipts are not duplicated");
    const stdout = receipt.artifacts.find((item: { name: string }) => item.name.endsWith(".stdout"));
    const first = JSON.parse((await code.read({ id: stdout.id }, context)).content[0].text!);
    assert.equal(first.text.length, 8000);
    assert.equal(first.total, 40001);
    assert.equal(first.hasMore, true);
    const next = JSON.parse((await code.read({ id: stdout.id, offset: first.nextOffset, limit: 100 }, context)).content[0].text!);
    assert.equal(next.offset, 8000);
    assert.equal(next.text, "核验".repeat(50));
    await assert.rejects(code.read({ id: stdout.id }, { ...context, scope: { ...context.scope, sessionId: crypto.randomUUID() } }), /ENOENT/);
    const resumed = await new LocalAnalysisCode(directory, path.join(ROOT, ".venv/bin/python")).execute({ language: "shell", code: 'test "$(<check.txt)" = passed && printf verified' }, context);
    assert.equal(JSON.parse(resumed.content[0].text!).stdout, "verified");
    const failed = await code.execute({ language: "python", code: 'assert 1 == 2, "calculation mismatch"' }, context);
    assert.equal(failed.isError, true);
    assert.match(JSON.parse(failed.content[0].text!).stderr, /calculation mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
