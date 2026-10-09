import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, type AnalysisDataSource, type AnalysisReference, type AssistantScope, type AssistantTool, type JsonObject, type SpecialistGateway, type SpecialistRequest, type WebSearchProvider, type WebSearchRequest, type WebReader, type WebReadRequest } from "@eval/contracts";
import { calculate } from "@eval/tools";
import schemas from "../../../schemas/eris/tools.json" with { type: "json" };
import { validateChart, type ChartSpec } from "./chart.js";

export interface ErisDependencies {
  data: AnalysisDataSource;
  specialists: SpecialistGateway;
  search: WebSearchProvider;
  web: WebReader;
  code: { execute: AssistantTool["execute"]; read: AssistantTool["execute"] };
  save(scope: AssistantScope, markdown: string): Promise<JsonObject>;
}

export const erisToolNames = Object.keys(schemas) as (keyof typeof schemas)[];

// The JSON output already contains the business result. Metadata is reserved
// for source locators; repeating the entire result there doubles the journal.
const textResult = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

function resultPage(value: unknown, options: { offset?: number; limit?: number } = {}) {
  const text = JSON.stringify(value), offset = options.offset ?? 0, limit = options.limit ?? 8000;
  const end = Math.min(text.length, offset + limit);
  return { text: text.slice(offset, end), total: text.length, offset, limit, unit: "characters",
    hasMore: end < text.length, nextOffset: end < text.length ? end : null };
}

/** Whole-run counts are independent of paging; whole-run prose and coordinates are not tool material. */
function directorySummary(summary: JsonObject): JsonObject {
  const { formalComparisonReferences: _formal, comparisonReviewReferences: _review, ...progress } = summary;
  const statistics = summary.formalComparisonStats as JsonObject | undefined;
  if (!statistics) return progress;
  const { records: _records, ...counts } = statistics;
  const tiers = (counts.tiers as JsonObject[]).map(({ references: _sources, ...tier }) => tier);
  return { ...progress, formalComparisonStats: { ...counts, tiers } };
}

export function erisTools(options: ErisDependencies, descriptions: Record<string, string>): AssistantTool[] {
  const execute: Record<keyof typeof schemas, AssistantTool["execute"]> = {
    list_data: async (value) => {
      const result = await options.data.list(value as JsonObject);
      const current = result.currentRun as JsonObject | undefined;
      // Apply to every page, including empty searches. Chart validation still reads complete provenance.
      return textResult({ ...result,
        ...(result.summary ? { summary: directorySummary(result.summary as JsonObject) } : {}),
        ...(current?.summary ? { currentRun: { ...current, summary: directorySummary(current.summary as JsonObject) } } : {}),
      });
    },
    read_data: async (value) => {
      const args = value as { reference: AnalysisReference; offset?: number; limit?: number };
      const data = await options.data.read(args.reference, args);
      return args.reference.taskId ? textResult({ kind: "accepted-result", reference: args.reference, ...resultPage(data, args) })
        : { ...textResult(data), details: { sourceRead: { tool: "read_data", args } } };
    },
    search_data: async (value) => { const args = value as { reference: AnalysisReference; query: string; offset?: number; limit?: number }; return { ...textResult(await options.data.search(args.reference, args.query, args)), details: { sourceRead: { tool: "search_data", args } } }; },
    search_web: async (value, context) => {
      const result = await options.search.search(value as WebSearchRequest, context.signal);
      return { ...textResult(result), isError: result.attempts.length > 0 && result.attempts.every(attempt => attempt.state === "failed") };
    },
    read_web: async (value, context) => textResult(await options.web.read(value as WebReadRequest, context.signal)),
    view_image: async (value) => ({ ...await options.data.image((value as { reference: AnalysisReference }).reference), details: { sourceRead: { tool: "view_image", args: value } } }),
    calculate: async (value) => { const args = value as { operation: string; operands: string[] }; return textResult(calculate(args.operation, args.operands)); },
    execute_code: (value, context) => options.code.execute(value, context),
    read_code_output: (value, context) => options.code.read(value, context),
    call_specialist: async (value, context) => {
      const result = await options.specialists.invoke(context.scope, value as SpecialistRequest, context.signal, context.progress);
      const { result: body, ...receipt } = result;
      return { ...textResult({ ...receipt, ...(body === undefined ? {} : { result: resultPage(body) }) }), isError: result.state === "failed" || result.state === "cancelled" };
    },
    read_specialist: async (value, context) => {
      const args = value as { operationId: string; offset?: number; limit?: number };
      const { result, ...receipt } = await options.specialists.read(context.scope, args.operationId);
      return textResult({ ...receipt, ...(result === undefined ? {} : { result: resultPage(result, args) }) });
    },
    show_chart: async (value, context) => {
      const { references = [], ...chart } = value as ChartSpec & { references?: { runId?: string; operationId?: string; reference?: AnalysisReference; statistics?: { runId: string; comparisonTier: string } }[] };
      validateChart(chart);
      const citations: unknown[] = [];
      for (const item of references) {
        context.signal.throwIfAborted();
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
      return citations.length
        ? { ...textResult({ kind: "chart", chart }), details: { references: citations } }
        : textResult({ kind: "chart", chart });
    },
    save_summary: async (value, context) => {
      const args = value as { markdown: string; references: { operationId?: string; reference?: AnalysisReference }[] };
      const citations: unknown[] = [];
      for (const item of args.references) {
        context.signal.throwIfAborted();
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
      context.signal.throwIfAborted();
      return { ...textResult(await options.save(context.scope, args.markdown)), details: { references: citations } };
    },
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return erisToolNames.map((name) => {
    const inputSchema = schemas[name];
    const validate = ajv.compile(inputSchema);
    const validateArgs = (value: unknown) => {
      if (validate(value)) return;
      const issues = schemaIssues(validate.errors).map(({ path, code, expected }) => ({ path, code, expected }));
      throw new Error(`${name} 参数无效；未执行。只修正以下字段，不原样重试：${JSON.stringify(issues)}。${ajv.errorsText(validate.errors)}`);
    };
    return { name, description: descriptions[name], inputSchema, readOnly: ["list_data", "read_data", "search_data", "search_web", "read_web", "view_image", "calculate", "read_code_output", "read_specialist", "show_chart"].includes(name),
      validate: validateArgs,
      async execute(value, context) {
        context.signal.throwIfAborted();
        validateArgs(value);
        return execute[name](value, context);
      },
    };
  });
}
