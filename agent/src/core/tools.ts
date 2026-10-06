import { Ajv2020 } from "ajv/dist/2020.js";
import { type AnalysisDataSource, type AnalysisReference, type AssistantScope, type AssistantTool, type JsonObject, type SpecialistGateway, type SpecialistRequest, type WebSearchProvider, type WebSearchRequest, type WebReader, type WebReadRequest } from "@eval/contracts";
import { calculate } from "@eval/tools";
import schemas from "../../../schemas/eris/tools.json" with { type: "json" };
import { validateChart, type ChartSpec } from "./chart.js";

export interface ErisDependencies {
  data: AnalysisDataSource;
  specialists: SpecialistGateway;
  search: WebSearchProvider;
  web: WebReader;
  save(scope: AssistantScope, markdown: string): Promise<JsonObject>;
}

export const erisToolNames = Object.keys(schemas) as (keyof typeof schemas)[];

// The JSON output already contains the business result. Metadata is reserved
// for source locators; repeating the entire result there doubles the journal.
const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

export function erisTools(options: ErisDependencies, descriptions: Record<string, string>): AssistantTool[] {
  const execute: Record<keyof typeof schemas, AssistantTool["execute"]> = {
    list_data: async (value) => {
      const result = await options.data.list(value as JsonObject);
      const current = result.currentRun as JsonObject | undefined;
      const summary = current?.summary as JsonObject | undefined;
      const statistics = summary?.formalComparisonStats as JsonObject | undefined;
      if (result.kind !== "runs" || !statistics) return textResult(result);
      // The initial overview carries counts. Case narratives are requested by runId when needed.
      // Keep the data source intact: chart provenance validation still reads its complete references.
      const { records: _records, ...counts } = statistics;
      const { formalComparisonReferences: _references, ...progress } = summary!;
      const tiers = (counts.tiers as JsonObject[]).map(({ references: _sources, ...tier }) => tier);
      return textResult({ ...result, currentRun: { ...current, summary: { ...progress, formalComparisonStats: { ...counts, tiers } } } });
    },
    read_data: async (value) => { const args = value as { reference: AnalysisReference; offset?: number; limit?: number }; const result = textResult(await options.data.read(args.reference, args)); return args.reference.taskId ? result : { ...result, details: { sourceRead: { tool: "read_data", args } } }; },
    search_data: async (value) => { const args = value as { reference: AnalysisReference; query: string; offset?: number; limit?: number }; return { ...textResult(await options.data.search(args.reference, args.query, args)), details: { sourceRead: { tool: "search_data", args } } }; },
    search_web: async (value, context) => textResult(await options.search.search(value as WebSearchRequest, context.signal)),
    read_web: async (value, context) => textResult(await options.web.read(value as WebReadRequest, context.signal)),
    view_image: async (value) => ({ ...await options.data.image((value as { reference: AnalysisReference }).reference), details: { sourceRead: { tool: "view_image", args: value } } }),
    calculate: async (value) => { const args = value as { operation: string; operands: string[] }; return textResult(calculate(args.operation, args.operands)); },
    call_specialist: async (value, context) => textResult(await options.specialists.invoke(context.scope, value as SpecialistRequest, context.signal, context.progress)),
    read_specialist: async (value, context) => textResult(await options.specialists.read(context.scope, (value as { operationId: string }).operationId)),
    show_chart: async (value, context) => {
      const { references, ...chart } = value as ChartSpec & { references: { runId?: string; operationId?: string; reference?: AnalysisReference; statistics?: { runId: string; comparisonTier: string } }[] };
      validateChart(chart);
      const citations: unknown[] = [];
      for (const item of references) {
        if (item.statistics) {
          const result = await options.data.list({ runId: item.statistics.runId, limit: 1 });
          const summary = result.summary as { formalComparisonStats?: { tiers: { comparisonTier: string; comparisonCount: number; references: AnalysisReference[] }[] } } | undefined;
          const tier = summary?.formalComparisonStats?.tiers?.find(tier => tier.comparisonTier === item.statistics!.comparisonTier);
          if (result.kind !== "inputs" || !tier || tier.comparisonCount <= 0 || !tier.references?.length)
            throw new Error("该运行与档位没有可引用的正式统计");
          citations.push({ statistics: item.statistics, evaluatorVersion: result.evaluatorVersion, references: tier.references });
        } else if (item.operationId) {
          const result = await options.specialists.read(context.scope, item.operationId);
          if (result.state !== "succeeded") throw new Error("图表只能引用已接受的专业结果");
          citations.push({ operationId: item.operationId, evaluatorVersion: result.evaluatorVersion, reference: result.reference });
        } else if (item.runId) {
          const result = await options.data.list({ runId: item.runId, limit: 1 });
          if (result.kind !== "inputs") throw new Error("图表目录引用不存在");
          citations.push({ runId: item.runId, evaluatorVersion: result.evaluatorVersion });
        } else if (item.reference) {
          const result = await options.data.read(item.reference);
          if (item.reference.taskId ? !result.result : !["messages", "message"].includes(String(result.kind)))
            throw new Error("图表来源不存在或没有已接受的正式结果");
          citations.push({ reference: item.reference, ...(result.evaluatorVersion ? { evaluatorVersion: result.evaluatorVersion } : {}) });
        }
      }
      return { ...textResult({ kind: "chart", chart }), details: { references: citations } };
    },
    save_summary: async (value, context) => {
      const args = value as { markdown: string; references: { operationId?: string; reference?: AnalysisReference }[] };
      const citations: unknown[] = [];
      for (const item of args.references) {
        if (item.operationId) {
          const result = await options.specialists.read(context.scope, item.operationId);
          if (result.state !== "succeeded") throw new Error("总结只能引用已接受的专业结果");
          citations.push({ operationId: item.operationId, evaluatorVersion: result.evaluatorVersion, reference: result.reference });
        } else if (item.reference?.taskId) {
          const result = await options.data.read(item.reference);
          if (!result.result) throw new Error("正式结果不存在");
          citations.push({ reference: item.reference, evaluatorVersion: result.evaluatorVersion });
        } else throw new Error("总结缺少正式结果引用");
      }
      return { ...textResult(await options.save(context.scope, args.markdown)), details: { references: citations } };
    },
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return erisToolNames.map((name) => {
    const inputSchema = schemas[name];
    const validate = ajv.compile(inputSchema);
    return { name, description: descriptions[name], inputSchema, readOnly: ["list_data", "read_data", "search_data", "search_web", "read_web", "view_image", "calculate", "read_specialist", "show_chart"].includes(name),
      async execute(value, context) {
        if (!validate(value)) throw new Error(ajv.errorsText(validate.errors));
        return execute[name](value, context);
      },
    };
  });
}
