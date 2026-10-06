import test from "node:test";
import assert from "node:assert/strict";
import { numericReferenceDirectory, numericReferenceMaterials } from "./units.js";

test("index names and month ranges do not become numerical answer targets", () => {
  assert.deepEqual(numericReferenceDirectory("上证50的年涨幅+12.90%，相对上证-5.51%；中证2000年涨幅+36.42%，相对上证+18.01%")
    .map(item => item.expected), ["+12.90", "-5.51", "+36.42", "+18.01"]);
  for (const range of ["1-5月", "1—5月", "1至5月", "1月到5月"])
    assert.deepEqual(numericReferenceDirectory(`比亚迪2025年销量：4602436；2026年${range}销量：1405039；比亚迪2026年${range}股价涨跌幅为：-1.58%；同时期的长城汽车股价涨跌幅为：-25.36%`)
      .map(item => item.expected), ["4602436", "1405039", "-1.58", "-25.36"]);
});

test("quantities beside index identities remain available with original precision", () => {
  assert.deepEqual(numericReferenceDirectory("沪深300涨幅4.50%；中证500上涨3.25%；科创50下跌2.00%；样本50只，截至2026年5月")
    .map(item => item.expected), ["4.50", "3.25", "-2.00", "50"]);
});

test("relative-return shorthand stays visible for interpretation without pretending to be a direct unit match",()=>{
  const input={candidate_id:"11111111-1111-4111-8111-111111111111",
    ground_truth:{available:true,value:"上证50年涨幅12.90%，相对上证-5.51%；中证2000年涨幅36.42%，相对上证18.01%"},
    answer:{final_answer:"上证50上涨12.90%，相对上证-5.51个百分点；中证2000上涨36.42%，相对上证18.01个百分点。"}};
  const shown=numericReferenceMaterials(input);
  assert.deepEqual(shown.direct.map(item=>item.expected),["12.90","36.42"]);
  assert.deepEqual(shown.interpreted.map(item=>item.expected),["-5.51","18.01"]);
  input.ground_truth.value="利润率变化-0.60%";input.answer.final_answer="利润率变化-0.60个百分点。";
  assert.equal(numericReferenceMaterials(input).direct.length,1,"a definite percentage target does not bypass its unit check");
});
