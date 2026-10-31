import { evidenceOrigin, type JsonObject } from "@eval/contracts";
import { parseEvidenceCoordinates } from "@eval/tools";
import { normalizeComponentFamily, type ComponentRole } from "@eval/agents/attribution";
import type { RawInput } from "../inputs/types.js";

export type MemberRole = "request_generation" | "tool" | "script" | "skill" | "delivery";
export interface InvestigationGroup {
  /** Stable within a turn: "delivery", or kind:name of the group's first catalog member. */
  key: string;
  delivery: boolean;
  members: JsonObject[];
  /** Tool groups review their own invocations; delivery receives every invocation as checkable source. */
  links: JsonObject[];
  errors: JsonObject[];
}

const requestTypes = new Set(["tool_call", "function_call"]);

/** A call run through an entry tool such as shell answers for the inner script it executes. */
export function invocationTarget(raw: RawInput, members: JsonObject[], requestIndex: number): string {
  const script = members.find(member => member.kind === "script" && (member.message_indices as number[]).includes(requestIndex));
  return script ? String(script.name).split("/").at(-1)! : String(raw.messages[requestIndex]?.name);
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A member owns the targets of the calls it generated; groups are investigation scope, not identity. */
function memberTargetFamilies(raw: RawInput, actors: JsonObject[], links: JsonObject[], member: JsonObject): string[] {
  if (typeof member.component_target === "string" && member.component_target.trim())
    return [normalizeComponentFamily(member.component_target)];
  const owned = new Set((member.message_indices as number[] | undefined) ?? []), families = new Set<string>();
  for (const link of links) {
    if (!owned.has(Number(link.invoking_model_message_index))) continue;
    const request = Number(link.request_message_index);
    if (!Number.isSafeInteger(request) || !raw.messages[request]) continue;
    try { families.add(normalizeComponentFamily(invocationTarget(raw, actors, request))); }
    catch { /* Missing target names fall back to the member's own kind below. */ }
  }
  return [...families];
}

function memberComponentRole(member: JsonObject): ComponentRole {
  const role = member.role, kind = member.kind;
  if (role === "request_generation")
    return member.identity_basis === "program_request_generation" ? "request_generation" : "planning";
  if (role === "delivery")
    return member.contains_final_generation === true || member.name === "答案合成" ? "delivery" : "planning";
  if (role === "skill" || role === "script" || role === "tool") return role;
  if (kind === "skill" || kind === "script" || kind === "tool") return kind;
  return kind === "model" ? "planning" : "tool";
}

function withComponentIdentity(raw: RawInput, actors: JsonObject[], links: JsonObject[], group: InvestigationGroup): InvestigationGroup {
  return { ...group, members: group.members.map(member => {
    const component_role = memberComponentRole(member);
    const families = component_role === "planning" || component_role === "request_generation"
      ? memberTargetFamilies(raw, actors, links, member) : [];
    const component_family = component_role === "delivery" ? "answer_synthesis"
      : component_role === "planning" ? families.length === 1 ? families[0]! : "model"
        : component_role === "request_generation" ? families.length === 1 ? families[0]! : "other"
          : normalizeComponentFamily(member.name);
    return { ...member, component_family, component_role };
  }) };
}

/**
 * Components sharing an invocation chain are investigated together, so request generation,
 * the executing service, scripts and skills are judged against the same paired calls.
 * Anonymous request generation is named by the program per tool; the final answer belongs
 * to no tool group.
 */
export function investigationGroups(raw: RawInput, actors: JsonObject[], links: JsonObject[], errors: JsonObject[],
  finalIndex: number, modelIndices: number[]): InvestigationGroup[] {
  const messages = (actor: JsonObject) => new Set(actor.message_indices as number[]);
  const executors = actors.filter(actor => actor.kind !== "model");
  const parent = executors.map((_, index) => index);
  const root = (index: number): number => parent[index] === index ? index : parent[index] = root(parent[index]!);
  const join = (a: number, b: number) => { parent[root(a)] = root(b); };
  const requestText = (actor: JsonObject) => (actor.message_indices as number[]).filter(index => requestTypes.has(String(raw.messages[index]?.type)))
    .map(index => JSON.stringify(raw.messages[index]!.input ?? raw.messages[index]!.arguments ?? raw.messages[index]!.parameters ?? "")).join("\n");
  executors.forEach((actor, a) => executors.forEach((other, b) => {
    if (b <= a) return;
    const own = messages(actor);
    if ((other.message_indices as number[]).some(index => own.has(index))) join(a, b);
  }));
  // A skill named by its directory owns the scripts under that directory, even when they run through another tool.
  executors.forEach((skill, a) => {
    if (skill.kind !== "skill" || String(skill.name).includes("/")) return;
    const directory = new RegExp(`/${escape(String(skill.name))}(?:[/\\s"'&;|)]|$)`, "u");
    executors.forEach((other, b) => {
      if (a !== b && (other.kind === "script" ? directory.test(String(other.name)) : other.kind === "tool" && directory.test(requestText(other)))) join(a, b);
    });
  });
  const sets = new Map<number, JsonObject[]>();
  executors.forEach((actor, index) => sets.set(root(index), [...sets.get(root(index)) ?? [], actor]));
  const groups: InvestigationGroup[] = [...sets.values()].map(members => {
    const covered = new Set(members.flatMap(actor => actor.message_indices as number[]));
    return { key: `${members[0]!.kind}:${members[0]!.name}`, delivery: false,
      members: members.map(actor => ({ ...actor, role: actor.kind as MemberRole })),
      links: links.filter(link => covered.has(Number(link.request_message_index)) ||
        (link.return_message_indices as number[]).some(index => covered.has(index))), errors: [] };
  });
  const hasCapturedFinal = actors.some(actor => actor.kind === "model" && (actor.message_indices as number[]).includes(finalIndex));
  const finalOwner = (actor: JsonObject) => actor.kind === "model" && (actor.name === "答案合成" ||
    (actor.message_indices as number[]).includes(finalIndex) || !hasCapturedFinal && (actor.message_indices as number[]).includes(modelIndices.at(-1) ?? finalIndex));
  const delivery: JsonObject[] = [];
  for (const actor of actors.filter(actor => actor.kind === "model")) {
    const own = messages(actor);
    if (actor.anonymous === true) { delivery.push(actor); continue; }
    const invoked = groups.filter(group => group.links.some(link => own.has(Number(link.invoking_model_message_index))));
    const nested = invoked.length ? [] : groups.filter(group => (actor.message_indices as number[]).every(index => group.links.some(link =>
      Number(link.request_message_index) < index && index < Math.max(...link.return_message_indices as number[]))));
    for (const group of invoked) group.members.push({ ...actor, role: "request_generation" });
    if (nested[0]) nested[0].members.push({ ...actor, role: "tool" });
    if (!invoked.length && !nested.length || finalOwner(actor)) delivery.push(actor);
  }
  // Anonymous or unrecorded request generation is a per-tool responsibility named by code, never by the model.
  let next = actors.length;
  for (const group of groups) {
    const generators = new Set(group.members.filter(member => member.role === "request_generation").flatMap(member => member.message_indices as number[]));
    const tools = new Map<string, number[]>();
    for (const link of group.links) {
      if (typeof raw.messages[Number(link.request_message_index)]?.name !== "string") continue;
      const name = invocationTarget(raw, group.members, Number(link.request_message_index));
      if (!name.trim() || generators.has(Number(link.invoking_model_message_index))) continue;
      tools.set(name, [...tools.get(name) ?? [], ...link.invoking_model_message_index === null ? [] : [Number(link.invoking_model_message_index)]]);
    }
    for (const [tool, indices] of tools) group.members.push({ component_index: ++next, kind: "model", name: `${tool} 请求生成`, component_target: tool, anonymous: true,
      role: "request_generation", identity_basis: "program_request_generation", message_indices: [...new Set(indices)], source_evidence: [] });
  }
  for (const error of errors) {
    const owner = groups.find(group => {
      const related = new Set([...group.members.filter(member => member.kind !== "model").flatMap(member => member.message_indices as number[]),
        ...group.links.flatMap(link => [Number(link.request_message_index), ...link.return_message_indices as number[]])]);
      const tools = new Set(group.members.filter(member => member.kind === "tool").map(member => member.name));
      return (error.evidence as JsonObject[]).some(proof => {
        const point = parseEvidenceCoordinates(String(proof.evidence_id));
        if (!point) return false;
        if (related.has(point.message_index)) return true;
        const message = raw.messages[point.message_index]!, observed = point.kind === "image" ? {} : evidenceOrigin(message, point.path);
        return message.type === "tool_result" && tools.has(message.name) || observed.enclosing_role === "tool" && tools.has(observed.enclosing_name);
      });
    });
    owner?.errors.push(error);
  }
  const named = delivery.find(actor => actor.name === "答案合成");
  // One final generation call reads, computes, reasons, cites and writes; each failure has a different fix,
  // so responsibility names the failed capability of that same call instead of one undivided stage.
  const members = delivery.flatMap(actor => !(named ? actor === named : finalOwner(actor)) ? [{ ...actor, role: "delivery" as MemberRole }]
    : finalCapabilities.map(([name, scope]) => ({ ...actor, component_index: ++next, name, components_content: scope,
      identity_basis: "program_final_capability", role: "delivery" as MemberRole, contains_final_generation: true })));
  return [...groups, ...delivery.length ? [{ key: "delivery", delivery: true, links, errors: [], members }] : []]
    .map(group => withComponentIdentity(raw, actors, links, group));
}

/** Capabilities of the final generation call, ordered by the earliest deviation they can explain. */
export const finalCapabilities = [
  ["答案合成·取值", "从来源取值时主体、期间、字段、单位或口径读错、张冠李戴。"],
  ["答案合成·计算", "取值正确，但比例、增速、加总、换算等派生数值算错。"],
  ["答案合成·推断", "数据与计算无误，但比较、趋势、因果或结论判断错误，或答复内前后矛盾。"],
  ["答案合成·无据内容", "写出任何来源和用户输入中都不存在的事实、数值或解释。"],
  ["答案合成·引用", "内容本身有来源，但引用标记指向不含该内容的来源或漏标真实来源。"],
  ["答案合成·指令遵循", "遗漏或违背用户明确要求、格式或交付物，或措辞误导，且不属于以上类别。"],
] as const;
