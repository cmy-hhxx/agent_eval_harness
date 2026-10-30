import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@eval/contracts";
import { attributionComponentLabel } from "./responsibility.js";

test("responsibility separates reasoning steps from source actors and names concrete external components", () => {
  const components = [
    { component_index: 1, kind: "model", name: "AIME-Atlas" },
    { component_index: 2, kind: "tool", name: "finquery" },
    { component_index: 3, kind: "script", name: "/opt/skills-aime/aime-finquery/scripts/finquery.py" },
    { component_index: 4, kind: "script", name: "/harness/workdir/memo/build_memo.py" },
    { component_index: 5, kind: "skill", name: "pdf" },
  ];
  assert.equal(attributionComponentLabel("arithmetic-calculation", 1, components), "算术运算");
  assert.equal(attributionComponentLabel("period-interpretation", 1, components), "期间口径判断");
  assert.equal(attributionComponentLabel("finquery", 2, components), "finquery");
  assert.equal(attributionComponentLabel("finquery-script", 3, components), components[2]!.name);
  assert.equal(attributionComponentLabel("session-script", 4, components), components[3]!.name);
  assert.equal(attributionComponentLabel("skill-content", 5, components), "pdf");
  for (const code of ["limitation-disclosure", "model-call", "script-command", "llm-call-7", "__proto__"])
    assert.throws(() => attributionComponentLabel(code, 1, components), ValidationError);
  assert.throws(() => attributionComponentLabel("finquery", 1, components), ValidationError);
  assert.throws(() => attributionComponentLabel("arithmetic-calculation", 2, components), ValidationError);
  assert.throws(() => attributionComponentLabel("period-interpretation", 99, components), ValidationError);
});
