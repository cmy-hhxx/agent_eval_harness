import type { ValidationIssue } from "@eval/contracts";

interface ComponentProblemDraft {
  label: string;
  definition: string;
  problem_phenomena: string;
  reason: string;
  evidence: { reason: string }[];
}

const placeholders = new Set([
  "tmp", "test", "todo", "placeholder", "dummy", "sample", "foo", "bar", "baz", "lorem", "ipsum",
  "na", "n/a", "null", "undefined", "none", "nil", "占位", "占位内容", "测试", "待补", "待补充", "待定",
  "暂无", "无", "没有", "同上", "略", "问题", "错误", "异常", "失败", "有错", "有问题", "不符合",
  "不符合要求", "不满足要求", "内容错误", "结果错误", "信息不足", "无法判断", "未知",
]);

function semanticText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function uninformative(text: string): boolean {
  const compact = semanticText(text);
  if (!compact || placeholders.has(compact)) return true;
  if (/^(.)\1+$/su.test(compact)) return true;
  return /^(?:tmp|test|todo|placeholder|dummy|foo|bar|baz)[-_]?\d+$/iu.test(compact);
}

function pointer(path: string): string {
  return path.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Reject syntactically valid component prose that carries no attributable information. */
export function componentContentIssues(problems: readonly ComponentProblemDraft[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const problemsSeen = new Map<string, number>();
  problems.forEach((problem, index) => {
    const base = `/problems/${index}`;
    const fields = [
      ["label", problem.label], ["definition", problem.definition], ["problem_phenomena", problem.problem_phenomena],
      ["reason", problem.reason], ...problem.evidence.map((evidence, evidenceIndex) =>
        [`evidence/${evidenceIndex}/reason`, evidence.reason] as const),
    ] as const;
    for (const [field, text] of fields)
      if (uninformative(text)) issues.push({ category: "structure", code: "placeholder_content",
        path: `${base}/${pointer(field)}`, message: "问题描述必须包含可核查的具体语义，不能使用占位、空泛或重复字符。" });

    const normalized = (text: string) => semanticText(text);
    const label = normalized(problem.label), definition = normalized(problem.definition), phenomena = normalized(problem.problem_phenomena),
      reason = normalized(problem.reason), evidenceReasons = problem.evidence.map((evidence) => normalized(evidence.reason));
    if (phenomena && phenomena === reason)
      issues.push({ category: "structure", code: "duplicate_semantics", path: `${base}/reason`,
        message: "problem_phenomena 与 reason 必须分别说明具体现象和证据如何证明技术原因，不能重复同一句话。" });
    if (evidenceReasons.some((value) => value && [label, definition, phenomena, reason].includes(value)))
      issues.push({ category: "structure", code: "duplicate_semantics", path: `${base}/evidence`,
        message: "evidence.reason 只说明该段原文直接证明了什么，不能复述问题字段。" });
    if (evidenceReasons.length > 1 && new Set(evidenceReasons).size === 1)
      issues.push({ category: "structure", code: "duplicate_evidence_reason", path: `${base}/evidence`,
        message: "不同证据必须分别说明各自的证明作用；若作用完全相同，应合并证据而不是复制理由。" });
    const allText = [problem.label, problem.definition, problem.problem_phenomena, problem.reason,
      ...problem.evidence.map((evidence) => evidence.reason)].map(normalized).filter(Boolean);
    if (allText.length > 1 && new Set(allText).size === 1)
      issues.push({ category: "structure", code: "duplicate_problem_text", path: base,
        message: "label、definition、problem_phenomena、reason 与 evidence.reason 不能全部重复同一句占位文本。" });
    const signature = [problem.label, problem.definition, problem.problem_phenomena, problem.reason,
      ...problem.evidence.map((evidence) => evidence.reason)].map(normalized).join("\u0000");
    const previous = problemsSeen.get(signature);
    if (previous !== undefined) issues.push({ category: "structure", code: "duplicate_problem", path: base,
      message: `该问题与 problems/${previous} 内容完全相同；应合并为一个完整问题并保留全部证据。` });
    else problemsSeen.set(signature, index);
  });
  return issues;
}
