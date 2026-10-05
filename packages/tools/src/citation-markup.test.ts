import test from "node:test";
import assert from "node:assert/strict";
import { citationMarkers, maskCitationMarkup } from "./citation-markup.js";

test("citation masking preserves raw coordinates and only recognizes complete protocol markers", () => {
  const text = '😀12元[^12]\n公司<trace ref="1234567" />名称';
  const masked = maskCitationMarkup(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked.indexOf("名称"), text.indexOf("名称"));
  assert.equal(masked.indexOf("\n"), text.indexOf("\n"));
  assert.equal(text.slice(0, 5), masked.slice(0, 5));
  assert.deepEqual(citationMarkers(text).map(marker => [marker.format, marker.reference]),
    [["footnote", "12"], ["trace", "1234567"]]);
  for (const literal of ['普通[12]', '[^12', '<trace ref="12"/>', '<trace ref="1234567">',
    '<trace ref="1234567" extra="12"/>']) assert.equal(maskCitationMarkup(literal), literal);
});

test("current B action anchors are control markers with their source type and original offsets", () => {
  const text = '😀3.25%<trace anchor="jmxXFOm" />\n公司<trace anchor="l8bGl21"/>名称';
  const markers = citationMarkers(text);
  assert.deepEqual(markers.map(marker => [marker.format, marker.reference]),
    [["trace", "jmxXFOm"], ["trace", "l8bGl21"]]);
  assert.deepEqual(markers.map(marker => marker.attribute), ["anchor", "anchor"]);
  const masked = maskCitationMarkup(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked.indexOf("名称"), text.indexOf("名称"));
  assert.equal(masked.indexOf("\n"), text.indexOf("\n"));
  assert.equal(masked.slice(0, text.indexOf("<trace")), text.slice(0, text.indexOf("<trace")));
  for (const literal of ['<A/>', '<trace anchor="jmxXFOm">',
    '<trace anchor="jmxXFOm" ref="jmxXFOm"/>', '<trace anchor=""/>'])
    assert.equal(maskCitationMarkup(literal), literal);
});

test("vis-html resource markers preserve offsets and mask resource ID digits only in the semantic view", () => {
  const id = "html-df7addbd-8cdd-4889-b798-a29a1f6fc90f";
  const text = `😀40亿元\n<vis-html ref="${id}" />\n3.25%`;
  const markers = citationMarkers(text);
  assert.deepEqual(markers, [{ format: "vis-html", reference: id, start: text.indexOf("<vis-html"),
    end: text.lastIndexOf("\n") }]);
  const masked = maskCitationMarkup(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked.indexOf("3.25%"), text.indexOf("3.25%"));
  assert.equal(masked.slice(0, text.indexOf("<vis-html")), text.slice(0, text.indexOf("<vis-html")));
  assert.doesNotMatch(masked, /4889/u);
  for (const literal of ['<vis-html ref=""/>', '<vis-html ref="html one"/>', '<vis-html ref="html-one">',
    '<vis-html ref="html-one" title="例子"/>', '<vis-html anchor="html-one"/>', '<visual ref="html-one"/>'])
    assert.equal(maskCitationMarkup(literal), literal);
});
