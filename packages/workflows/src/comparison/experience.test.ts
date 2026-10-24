import test from "node:test";
import assert from "node:assert/strict";
import { originalAnswerUsage } from "./experience.js";
import type { RawInput } from "../inputs/types.js";

const source = (usage?: unknown): RawInput => ({ messages: [], meta: { usage } });

test("answer usage normalizes A/B cache fields without adding cache twice", () => {
  const a = originalAnswerUsage(source({ input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 80 }, model: "private-model" }));
  const b = originalAnswerUsage(source({ input_tokens: 100, output_tokens: 20, cached_read_tokens: 80 }));
  for (const value of [a, b]) {
    assert.equal(value.total_tokens, 120);
    assert.equal(value.cached_input_tokens, 80);
    assert.deepEqual(value.issues, []);
    assert(!JSON.stringify(value).includes("private-model"));
  }
  assert.equal(a.total_tokens_basis, "reported");
  assert.equal(b.total_tokens_basis, "input_plus_output");
});

test("missing answer usage stays unknown, while recorded zero stays zero", () => {
  const missing = originalAnswerUsage(source());
  assert.equal(missing.input_tokens, null);
  assert.equal(missing.output_tokens, null);
  assert.equal(missing.total_tokens, null);
  assert.equal(missing.cached_input_tokens, null);
  assert.equal(missing.total_tokens_basis, null);
  const zero = originalAnswerUsage(source({ input_tokens: 0, output_tokens: 0, cached_read_tokens: 0 }));
  assert.equal(zero.total_tokens, 0);
  assert.equal(zero.cached_input_tokens, 0);
});

test("conflicting or invalid usage cannot become a comparative advantage", () => {
  const conflict = originalAnswerUsage(source({ input_tokens: 100, output_tokens: 20,
    total_tokens: 50, cached_read_tokens: 200 }));
  assert.equal(conflict.total_tokens, null);
  assert.equal(conflict.cached_input_tokens, null);
  assert.equal(conflict.input_tokens, 100);
  assert.equal(conflict.output_tokens, 20);
  assert.equal(conflict.issues.length, 2);
  for (const invalid of [-1, 1.5, "10", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const value = originalAnswerUsage(source({ input_tokens: invalid, output_tokens: 20 }));
    assert.equal(value.input_tokens, null);
    assert.equal(value.total_tokens, null);
    assert.equal(value.issues.length, 1);
  }
});
