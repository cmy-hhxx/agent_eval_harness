import test from "node:test";
import assert from "node:assert/strict";
import { jsonRanges } from "./json-ranges.js";

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
