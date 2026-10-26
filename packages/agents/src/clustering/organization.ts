import type { ValidationIssue } from "@eval/contracts";

export const categoryRule = "填写一个简洁的单行纯文本问题方向，不含 ASCII 标记分隔符 < > [ ] { }、换行或控制字符。";
export const categoryAction = "依据目录语义重新填写问题方向，不提交标记分隔符、换行或控制字符。";
const invalidCategoryCharacters = /[<>\[\]{}\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

const categoryKey = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();

/** A category is one navigation label, never a class reference, graph edge or nested path. */
export function categoryIssues(category: string | undefined, location: string): ValidationIssue[] {
  if (category === undefined) return [];
  const errors: ValidationIssue[] = [], key = categoryKey(category);
  if (!key) errors.push({ category: "decision", code: "clustering_category_empty",
    path: location, message: "问题方向不能为空。", actual: category });
  if (invalidCategoryCharacters.test(category)) errors.push({ category: "decision", code: "clustering_category_characters",
    path: location, message: categoryRule, actual: category,
    expected: { category_rule: categoryRule, category_action: categoryAction } });
  return errors;
}

export function unionCategories(...categories: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  return categories.filter((category): category is string => category !== undefined).filter(category => {
    const key = categoryKey(category);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
