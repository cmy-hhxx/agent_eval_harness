import type { ValidationIssue } from "@eval/contracts";

export const categorySegmentRule = "每级填写简洁的单行纯文本名称，不含 ASCII 标记分隔符 < > [ ] { }、换行或控制字符。";
export const categorySegmentAction = "依据目录语义重新填写该层名称，不提交标记分隔符、换行或控制字符。";
const invalidCategoryCharacters = /[<>\[\]{}\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

const segmentKey = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();
const categoryPathKey = (path: string[]) => JSON.stringify(path.map(segmentKey));

/** Topic paths have no class references or graph edges; repeated levels are rejected. */
export function categoryPathIssues(paths: string[][] | undefined, location: string): ValidationIssue[] {
  if (!paths) return [];
  const errors: ValidationIssue[] = [], seen = new Set<string>();
  if (!paths.length) errors.push({ category: "decision", code: "clustering_primary_category_missing",
    path: location, message: "明确填写主题路径时必须保留一条主要路径，不能清空。", actual: paths });
  for (const [index, path] of paths.entries()) {
    if (path.length !== 1) errors.push({ category: "decision", code: "clustering_category_depth",
      path: `${location}/${index}`, message: "责任组件与具体问题之间只保留一个问题方向；路径须恰好一级。", actual: path });
    for (const [levelIndex, segment] of path.entries())
      if (invalidCategoryCharacters.test(segment)) errors.push({ category: "decision", code: "clustering_category_characters",
        path: `${location}/${index}/${levelIndex}`, message: categorySegmentRule, actual: segment,
        expected: { category_paths_rule: categorySegmentRule, category_paths_action: categorySegmentAction } });
    const levels = path.map(segmentKey), key = categoryPathKey(path);
    if (levels.some(level => !level)) errors.push({ category: "decision", code: "clustering_category_empty",
      path: `${location}/${index}`, message: "主题路径的各级名称不能为空。", actual: path });
    if (new Set(levels).size !== levels.length) errors.push({ category: "decision", code: "clustering_category_cycle",
      path: `${location}/${index}`, message: "同一主题路径不能重复同一级名称。", actual: path });
    if (seen.has(key)) errors.push({ category: "decision", code: "clustering_category_duplicate",
      path: `${location}/${index}`, message: "同一问题类的主题路径不能重复。", actual: path });
    seen.add(key);
  }
  if (paths.length > 1) errors.push({ category: "decision", code: "clustering_category_budget",
    path: location, message: "每个问题类只能保留一个问题方向，填写一条一级路径。", actual: paths });
  return errors;
}

export function unionCategoryPaths(...groups: (string[][] | undefined)[]): string[][] {
  const seen = new Set<string>();
  return groups.flatMap(paths => paths ?? []).filter(path => {
    const key = categoryPathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(path => [...path]);
}

/** A business code such as C18 is valid; only explicit uses as current request identities fail. */
export function temporaryReferenceInDescription(text: string, available: Set<string>): string | undefined {
  const contexts = [
    /(?:问题类|类编号|观察编号|组件编号|回答编号|class_id|item_id|answer_id|closest_existing)\s*[:：=]?\s*["'（(]?([OCPA][1-9]\d*)\b/gu,
    /[（(]\s*([OCPA][1-9]\d*)\s*[）)]/gu,
    /(?:不同于|区别于|与)\s*([OCPA][1-9]\d*)\s*(?:问题类|类|回答)/gu,
    /(?:归入|归到|归|转入|参见)\s*["'（(]?([OCPA][1-9]\d*)\b/gu,
  ];
  for (const expression of contexts) for (const match of text.matchAll(expression))
    if (available.has(match[1]!) && !/(?:型号|牌号|货号|代码|错误码|代号)\s*$/u.test(text.slice(0, match.index))) return match[1];
  return undefined;
}
