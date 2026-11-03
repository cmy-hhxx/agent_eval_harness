import test from "node:test";
import assert from "node:assert/strict";
import { jsonRanges } from "./json-ranges.js";

test("minified JSON span indexing scales without rescanning the current line", () => {
  const text = JSON.stringify({ datas: Array.from({ length: 20_000 }, (_, index) => ({ ticker: `ROW-${index}`, value: index })) });
  const started = performance.now();
  const ranges = jsonRanges(text);
  const elapsed = performance.now() - started;
  assert.equal(ranges.size, 60_002);
  for (const index of [0, 19_999]) {
    const range = ranges.get(`/datas/${index}`)!;
    assert.deepEqual(JSON.parse(text.slice(range.valueStart, range.end)), { ticker: `ROW-${index}`, value: index });
  }
  assert(elapsed < 3000, `JSON span indexing blocked for ${Math.round(elapsed)}ms`);
});

test("JSON pointers retain original whitespace, escaped keys, duplicate values and UTF-16 spans", () => {
  const value = { "中/文~": ["相同😀", "相同😀"], number: -1.25e4, nested: { empty: [], flag: false, missing: null } };
  for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2), ' \n' + JSON.stringify(value, null, 4) + '\r\n']) {
    const ranges = jsonRanges(text);
    const first = ranges.get("/中~1文~0/0")!, second = ranges.get("/中~1文~0/1")!;
    assert.equal(text.slice(first.valueStart, first.end), JSON.stringify("相同😀"));
    assert.equal(text.slice(second.valueStart, second.end), JSON.stringify("相同😀"));
    assert(first.end < second.start);
    for (const [pointer, expected] of [["/number", -12500], ["/nested/empty", []], ["/nested/flag", false], ["/nested/missing", null]] as const) {
      const range = ranges.get(pointer)!;
      assert.deepEqual(JSON.parse(text.slice(range.valueStart, range.end)), expected);
    }
    assert(!ranges.has("/中/文~/0"));
  }
  assert.throws(() => jsonRanges('{"incomplete":'));
});
