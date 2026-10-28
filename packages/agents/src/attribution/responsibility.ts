import { attributionTaxonomy, type AttributionComponent } from "@eval/prompts";
import { isComponentLocator } from "@eval/tools";

const UNKNOWN_COMPONENT = "责任主体未确定";
const COMPONENTS = attributionTaxonomy.components as Record<string, AttributionComponent>;
const component = (code: string): AttributionComponent | undefined => COMPONENTS[code];
const label = (code: string): string => component(code)?.label ?? UNKNOWN_COMPONENT;

const componentAliases: Record<string,string> = {
  finquery:"finquery", "finquery.py":"finquery-script", search:"web-search", web_search:"web-search",
  websearch:"web-search", web_fetch:"web-fetch", web_fetch_url:"web-fetch", accessingfulltext:"web-fetch",
  shell:"shell", "data-visualizer":"data-visualizer", view_skill:"view-skill", read_file:"view-skill",
  stock_ner_parse:"stock-ner", memory:"memory", "终稿生成轮":"final-generation", "final-generation":"final-generation",
};

/** Map metadata tool/skill text to the stable taxonomy component display. */
export function attributionComponentLabel(name: string): string {
  const value=name.trim();
  if (isComponentLocator(value))
    return /^llm[-_]?call[-_: /]/iu.test(value) ? "中间推理处理" : "流程处理";
  const direct=component(value);
  if(direct)return direct.label;
  const matching=Object.values(COMPONENTS).find(component=>component.label===value);
  if(matching)return matching.label;
  const code=componentAliases[value.toLowerCase()];
  if(code)return label(code);
  if (["中间推理处理", "流程处理", "工具执行"].includes(value)) return value;
  return value===UNKNOWN_COMPONENT?UNKNOWN_COMPONENT:`${label("other-tools")}（${value}）`;
}
