import { readFileSync } from "node:fs";
import type { RubricCategory, RubricChecklistItem, RubricJudge, RubricNeed, RubricState } from "@eval/agents/rubric";

export interface RubricStandardCategory extends RubricCategory {
  items: RubricChecklistItem[];
}

/** Parsed standard; the only source of checklist wording and allowed states. */
export interface RubricStandard {
  id: string;
  generic: RubricChecklistItem[];
  categories: Map<string, RubricStandardCategory>;
}

const states: RubricState[] = ["pass", "partial", "fail", "na"];
const judges: RubricJudge[] = ["model", "program", "program+model", "trace"];
const needs: RubricNeed[] = ["qa", "trace", "user_context"];

function fail(message: string): never {
  throw new Error(`rubric 标准无效：${message}`);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} 必须是对象`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${path} 必须是非空字符串`);
  return value;
}

/** Item ids stay verbatim (`G01`, `FIN-L2-053/gate/L1`); the standard is never rewritten or renumbered. */
function readItem(value: unknown, path: string, index: number): RubricChecklistItem {
  const item = asObject(value, path), id = asString(item.id, `${path}/id`);
  const allowed = item.states;
  if (!Array.isArray(allowed) || !allowed.length || allowed.some(state => !states.includes(state as RubricState)))
    fail(`${path}/states 含未知状态`);
  if (item.judge !== undefined && !judges.includes(item.judge as RubricJudge)) fail(`${path}/judge 未知`);
  const itemNeeds = item.needs;
  if (!Array.isArray(itemNeeds) || itemNeeds.some(need => !needs.includes(need as RubricNeed))) fail(`${path}/needs 未知`);
  return {
    index, item_id: id,
    source: path.startsWith("/generic") ? "generic" : "category",
    ...(item.kind === undefined ? {} : {kind: asString(item.kind, `${path}/kind`) as "gate" | "quality"}),
    ...(item.grp === undefined ? {} : {grp: asString(item.grp, `${path}/grp`)}),
    criterion: asString(item.criterion, `${path}/criterion`),
    fail: asString(item.fail, `${path}/fail`),
    ...(item.pass === undefined ? {} : {pass: asString(item.pass, `${path}/pass`)}),
    ...(item.partial === undefined ? {} : {partial: asString(item.partial, `${path}/partial`)}),
    states: allowed as RubricState[],
    na_when: item.na_when === null || item.na_when === undefined ? null : asString(item.na_when, `${path}/na_when`),
    needs: itemNeeds as RubricNeed[],
    judge: (item.judge ?? "model") as RubricJudge,
  };
}

/**
 * The standard ships 30 generic items plus 123 second-level categories; one checklist is
 * generic (all 30) followed by that category's own items, in the standard's own order.
 */
export function loadRubricStandard(path: string): RubricStandard {
  const raw = asObject(JSON.parse(readFileSync(path, "utf8")), "/");
  const genericRaw = asObject(raw.generic, "/generic"), genericItems = genericRaw.items;
  if (!Array.isArray(genericItems) || genericItems.length !== 30) fail("/generic/items 必须恰好 30 条");
  const generic = genericItems.map((item, index) => readItem(item, `/generic/items/${index}`, index + 1));
  const categoryRaw = raw.categories;
  if (!Array.isArray(categoryRaw) || !categoryRaw.length) fail("/categories 不能为空");
  const categories = new Map<string, RubricStandardCategory>();
  for (const [position, entry] of categoryRaw.entries()) {
    const category = asObject(entry, `/categories/${position}`), id = asString(category.id, `/categories/${position}/id`);
    if (!/^FIN-L2-[0-9]{3}$/u.test(id)) fail(`/categories/${position}/id 不是二级分类编号`);
    if (categories.has(id)) fail(`二级分类 ${id} 重复`);
    const items = category.items;
    if (!Array.isArray(items) || !items.length) fail(`二级分类 ${id} 没有条目`);
    categories.set(id, {
      id, name: asString(category.name, `/categories/${position}/name`), l1: asString(category.l1, `/categories/${position}/l1`),
      l1_name: asString(category.l1_name, `/categories/${position}/l1_name`),
      definition: asString(category.definition, `/categories/${position}/definition`), core: asString(category.core, `/categories/${position}/core`),
      items: items.map((item, index) => readItem(item, `/categories/${position}/items/${index}`,
        generic.length + index + 1)),
    });
  }
  const ids = new Set<string>();
  for (const item of [...generic, ...[...categories.values()].flatMap(category => category.items)]) {
    if (ids.has(item.item_id)) fail(`条目 ${item.item_id} 重复`);
    ids.add(item.item_id);
  }
  return {id: asString(raw._meta === undefined ? "" : asObject(raw._meta, "/_meta").name, "/_meta/name"), generic, categories};
}

/** Checklist composition fixed by the standard: generic 30 first, then that category's items. */
export function buildChecklist(standard: RubricStandard, categoryId: string): RubricChecklistItem[] {
  const category = standard.categories.get(categoryId);
  if (!category) throw new Error(`未知二级分类：${categoryId}`);
  return [...standard.generic, ...category.items].map((item, index) => ({...item, index: index + 1}));
}
