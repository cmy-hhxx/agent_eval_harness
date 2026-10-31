import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues } from "@eval/contracts";
import { componentAttributionProfile, traceAttributionProfile, sessionAttributionProfile } from "./session-profiles.js";

test("component submissions select one offered actor and require severity and evidence", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(componentAttributionProfile.submissionSchema);
  const problem = { actor_index: 1, tool_error_indices: [], label: "年份错配", definition: "使用其他年份的数据。",
    problem_phenomena: "2024年营收使用2023年的100亿元。", reason: "来源标注2023年。",
    severity: "P1", severity_reason: "关键数据期间错误。", evidence: [{ index: 1, reason: "原始来源年份。" }] };
  const draft = (item: object) => ({ content: "正常来源被误读年份。", evidence: [1], tool_error_reviews: [], problems: [item] });
  for (const severity of ["P0", "P1", "P2", "P3", "P4"]) assert(validate(draft({ ...problem, severity })), JSON.stringify(validate.errors));
  for (const severity of ["P5", "p1", 1, null]) assert(!validate(draft({ ...problem, severity })));
  for (const severity_reason of ["", null, 1]) assert(!validate(draft({ ...problem, severity_reason })));
  for (const field of ["actor_index", "severity", "severity_reason", "evidence"]) {
    const incomplete = { ...problem } as Record<string, unknown>; delete incomplete[field]; assert(!validate(draft(incomplete)));
  }
  assert(!validate(draft({ ...problem, actor_index: 0 })));
  assert(!validate(draft({ ...problem, component: "答案合成" })));
  assert(validate({ content: "未发现有证据支持的偏差。", evidence: [], tool_error_reviews: [], problems: [] }));
});

test("content tolerance allows 700 characters and maxLength rejection reports the excess", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(componentAttributionProfile.submissionSchema);
  assert(validate({ content: "字".repeat(700), evidence: [], tool_error_reviews: [], problems: [] }));
  const draft = { content: "字".repeat(701), evidence: [], tool_error_reviews: [], problems: [] };
  assert(!validate(draft));
  const issue = schemaIssues(validate.errors, draft).find(item => item.code === "schema_maxLength")!;
  assert.equal(issue.actualLength, 701);
  assert.equal(issue.excess, 1);
  assert.match(issue.message, /长度上限 700 字，实际 701 字，超出 1 字/);
});

test("trace cannot replace merged problems; session accepts cross-turn review", () => {
  const ajv = new Ajv2020({ strict: false }), trace = ajv.compile(traceAttributionProfile.submissionSchema), session = ajv.compile(sessionAttributionProfile.submissionSchema);
  assert(trace({ summary: "已汇总。" })); assert(!trace({ summary: "已汇总。", problems: [] }));
  assert(session({ session_summary: "按有序轮次汇总。", session_problem: [] }));
  assert(!session({ session_summary: "无独立问题。", component_reviews: [] }));
});
