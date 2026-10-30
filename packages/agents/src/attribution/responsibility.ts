import { ValidationError, type JsonObject } from "@eval/contracts";
import { attributionTaxonomy } from "@eval/prompts";

/** Reasoning names the failed step; external failures name the actual implementation. */
export function attributionComponentLabel(code: string, index: number, components: JsonObject[]): string {
  if (!Object.hasOwn(attributionTaxonomy.components, code))
    throw new ValidationError([{ category: "decision", code: "component_unknown", path: "/component",
      message: "component 必须选择 taxonomy.components 中的具体条目 ID。", actual: code }]);
  const component = components.find(entry => entry.component_index === index);
  if (!component || component.kind !== (attributionTaxonomy.components[code]!.kind === "reasoning" ? "model" : attributionTaxonomy.components[code]!.kind) || typeof component.name !== "string" || !component.name.trim())
    throw new ValidationError([{ category: "structure", code: "component_identity", path: "/actor_index",
      message: "actor_index 必须选择 actor_catalog 中的实际组件，推理条目对应 model 来源；其他条目须对应实际工具、脚本或 skill。", actual: index }]);
  return attributionTaxonomy.components[code]!.kind === "reasoning" ? attributionTaxonomy.components[code]!.label : component.name;
}
