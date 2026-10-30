import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { traceAttributionProfile, sessionAttributionProfile } from "./session-profiles.js";

for (const profile of [traceAttributionProfile, sessionAttributionProfile])
  test(`${profile.id} submissions require a supported severity and its reason on each problem`, () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(profile.submissionSchema);
    const problem = { component: "result-interpretation", actor_index: 1, label: "年份错配", definition: "将其他年份的数据当作目标年份数据。",
      problem_phenomena: "用户问2024年营收，回答使用2023年的100亿元。",
      reason: "引用来源标注2023年，不能证明2024年数值。",
      severity: "P1", severity_reason: "目标年份的关键数据未核实，需要重新取数。",
      evidence: [{ index: 1, reason: "来源明确标注2023年。" }] };
    const draft = (item: object) => profile.id === "trace" ? { summary: "已核验年份。", problems: [item] }
      : { session_summary: "营收年份错配。", session_problem: [item] };
    for (const severity of ["P0", "P1", "P2", "P3"])
      assert(validate(draft({ ...problem, severity })), JSON.stringify(validate.errors));
    for (const severity of ["P4", "p1", 1, null]) assert(!validate(draft({ ...problem, severity })));
    for (const severity_reason of ["", null, 1]) assert(!validate(draft({ ...problem, severity_reason })));
    for (const field of ["severity", "severity_reason"]) {
      const incomplete = { ...problem } as Record<string, unknown>;
      delete incomplete[field];
      assert(!validate(draft(incomplete)), `${field} is required`);
    }
  });
