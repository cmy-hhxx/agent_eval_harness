import test from "node:test";
import assert from "node:assert/strict";
import { fitStringPage } from "./pagination.js";

function pageBuilder(text: string, offset = 0) {
  return (end: number) => ({
    text: text.slice(offset, end), offset, next_offset: end,
    total_chars: text.length, has_more: end < text.length,
  });
}

test("string pages use the output budget without losing JSON or range metadata", () => {
  const text = "文".repeat(50000), build = pageBuilder(text);
  const page = fitStringPage({ totalChars: text.length, maxChars: 16000, maxOutputChars: 16000, build });
  assert(page.end > 15000, "metadata overhead must not halve a nearly fitting page");
  assert(page.serialized.length <= 16000);
  assert.deepEqual(JSON.parse(page.serialized), page.value);
  assert.equal(page.value.next_offset, page.end);
  assert.equal(page.value.text, text.slice(0, page.end));
  assert(JSON.stringify(build(page.end + 1)).length > 16000);
});

test("escaped string pages reconstruct the complete source using returned offsets", () => {
  const text = '值"\\\n\t\u0000🙂'.repeat(50);
  let offset = 0, recovered = "", pages = 0;
  do {
    const page = fitStringPage({
      totalChars: text.length, offset, maxChars: 97, maxOutputChars: 150,
      build: pageBuilder(text, offset),
    });
    assert(page.serialized.length <= 150);
    assert.deepEqual(JSON.parse(page.serialized), page.value);
    assert(page.end > offset);
    assert(page.end <= Math.min(offset + 97, text.length));
    recovered += page.value.text;
    offset = page.end;
    pages++;
  } while (offset < text.length);
  assert(pages > 1);
  assert.equal(recovered, text);
});

test("string page fitting handles a surrogate pair whose first prefix exceeds the budget", () => {
  const text = "🙂x", build = (end: number) => ({ text: text.slice(0, end) });
  const maxOutputChars = JSON.stringify(build(2)).length;
  assert(JSON.stringify(build(1)).length > maxOutputChars);
  const page = fitStringPage({ totalChars: text.length, maxChars: 3, maxOutputChars, build });
  assert.equal(page.end, 2);
  assert.equal(page.value.text, "🙂");
  assert.equal(page.serialized.length, maxOutputChars);
});

test("string page coordinates preserve requested UTF-16 limits", () => {
  const text = "🙂", build = pageBuilder(text);
  const first = fitStringPage({ totalChars: text.length, maxChars: 1, maxOutputChars: 200, build });
  assert.equal(first.end, 1);
  const second = fitStringPage({
    totalChars: text.length, offset: first.end, maxChars: 1, maxOutputChars: 200,
    build: pageBuilder(text, first.end),
  });
  assert.equal(second.end, 2);
  assert.equal(first.value.text + second.value.text, text);
  assert.equal(JSON.parse(first.serialized).text, text.slice(0, 1));
});

test("near-budget UTF-16 pages retain the largest fitting prefix across escaped boundaries", () => {
  const texts = [
    "a".repeat(9) + "🙂x🙂y🙂z".repeat(5),
    '"\\\n🙂'.repeat(10),
    "\ud800x\udc00🙂".repeat(10),
  ];
  for (const text of texts) for (const offset of [0, 1, 9]) {
    const build = pageBuilder(text, offset), maxChars = 30;
    const ends = Array.from({ length: Math.min(maxChars, text.length - offset) }, (_, index) => offset + index + 1);
    for (let maxOutputChars = 70; maxOutputChars < 160; maxOutputChars++) {
      const expectedEnd = ends.filter((end) => JSON.stringify(build(end)).length <= maxOutputChars).at(-1);
      if (expectedEnd === undefined) {
        assert.throws(() => fitStringPage({ totalChars: text.length, offset, maxChars, maxOutputChars, build }), RangeError);
      } else {
        const page = fitStringPage({ totalChars: text.length, offset, maxChars, maxOutputChars, build });
        assert.equal(page.end, expectedEnd, `offset=${offset}, budget=${maxOutputChars}, text=${JSON.stringify(text)}`);
        assert(page.serialized.length <= maxOutputChars);
      }
    }
  }
});

test("string page fitting never extends past the source and permits an empty final page", () => {
  const text = "abc";
  const final = fitStringPage({
    totalChars: text.length, offset: 2, maxChars: 100, maxOutputChars: 200, build: pageBuilder(text, 2),
  });
  assert.equal(final.end, 3);
  assert.equal(final.value.text, "c");
  assert.equal(final.value.has_more, false);
  for (const source of [text, ""]) {
    const empty = fitStringPage({
      totalChars: source.length, offset: source.length, maxChars: 100, maxOutputChars: 200,
      build: pageBuilder(source, source.length),
    });
    assert.equal(empty.end, source.length);
    assert.equal(empty.value.text, "");
    assert.equal(empty.value.has_more, false);
  }
});

test("string page fitting rejects invalid ranges and budgets", () => {
  const valid = { totalChars: 3, offset: 0, maxChars: 3, maxOutputChars: 200, build: pageBuilder("abc") };
  for (const totalChars of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.throws(() => fitStringPage({ ...valid, totalChars }), RangeError);
  for (const offset of [-1, 4, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.throws(() => fitStringPage({ ...valid, offset }), RangeError);
  for (const field of ["maxChars", "maxOutputChars"] as const)
    for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])
      assert.throws(() => fitStringPage({ ...valid, [field]: value }), RangeError);
});

test("too-small output budgets fail instead of returning an empty unread page or truncated JSON", () => {
  const text = '"abc', build = pageBuilder(text);
  assert.throws(() => fitStringPage({
    totalChars: text.length, maxChars: text.length,
    maxOutputChars: JSON.stringify(build(1)).length - 1, build,
  }), /无法完整返回一页/);
  assert.throws(() => fitStringPage({
    totalChars: 0, maxChars: 1, maxOutputChars: 1, build: pageBuilder(""),
  }), /无法完整返回一页/);
});

test("the builder can include all transport metadata in the measured page", () => {
  const text = "a".repeat(200), build = (end: number) => ({
    text: text.slice(0, end), next_offset: end, budget: { used: 12, remaining: 0 },
  });
  const page = fitStringPage({ totalChars: text.length, maxChars: text.length, maxOutputChars: 100, build });
  assert.deepEqual(page.value.budget, { used: 12, remaining: 0 });
  assert(page.serialized.length <= 100);
  assert(JSON.stringify(build(page.end + 1)).length > 100);
});

test("an unserializable builder result does not masquerade as an empty page", () => {
  assert.throws(() => fitStringPage({
    totalChars: 1, maxChars: 1, maxOutputChars: 100, build: () => undefined,
  }), TypeError);
});
