import { Ajv2020 } from "ajv/dist/2020.js";
import { parseEvidenceCoordinates, schemaIssues, type AnalysisDataSource, type AnalysisReference, type AnalysisCaseLookup, type AnalysisReadOptions, type AnalysisResultReadOptions, type AssistantSource, type AssistantTool, type JsonObject, type SpecialistGateway, type SpecialistRequest, type WebSearchProvider, type WebSearchRequest, type WebReader, type WebReadRequest } from "@eval/contracts";
import { calculate } from "@eval/tools";
import { erisComparisonCheck } from "@eval/prompts";
import schemas from "../../../schemas/eris/tools.json" with { type: "json" };
import checkSchema from "../../../schemas/eris/comparison-check.json" with { type: "json" };
import { validateChart, type ChartSpec } from "./chart.js";
import { comparisonDiagram, type ComparisonDiagramInput } from "./comparison-diagram.js";

export interface ErisDependencies {
  data: AnalysisDataSource;
  specialists: SpecialistGateway;
  search: WebSearchProvider;
  web: WebReader;
  code: { execute: AssistantTool["execute"]; read: AssistantTool["execute"] };
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

/** Filter evidence containers only at the model boundary; accepted rows remain untouched. */
function resultSummary(value: unknown, runId?: string): unknown {
  if (Array.isArray(value)) return value.map(child => resultSummary(child, runId));
  if (value === null || typeof value !== "object") return value;
  const { rewritten, ...fields } = value as Record<string, unknown>;
  return { ...(rewritten === undefined ? {} : { rewritten: resultSummary(rewritten, runId) }),
    ...Object.fromEntries(Object.entries(fields)
      .flatMap(([key, child]) => {
        if (key !== "evidence" && !key.endsWith("_evidence")) return [[key, resultSummary(child, runId)]];
        if (!runId || !Array.isArray(child)) return [];
        const references = new Map<string, AnalysisReference>();
        for (const item of child) {
          const coordinate = typeof item?.evidence_id === "string" ? parseEvidenceCoordinates(item.evidence_id) : undefined;
          if (coordinate) references.set(`${coordinate.input_id}:${coordinate.message_index}`, {
            runId, inputId: coordinate.input_id, messageIndex: coordinate.message_index,
          });
        }
        return references.size ? [[`${key}_references`, [...references.values()]]] : [];
      })) };
}

/** A review keeps source navigation without treating earlier judgments as facts. */
function reviewReferences(value: unknown, runId: string): AnalysisReference[] {
  const references = new Map<string, AnalysisReference>();
  function visit(item: unknown) {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (item === null || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (key === "evidence_id" && typeof child === "string") {
        const coordinate = parseEvidenceCoordinates(child);
        if (coordinate) references.set(`${coordinate.input_id}:${coordinate.message_index}`, {
          runId, inputId: coordinate.input_id, messageIndex: coordinate.message_index,
        });
      } else visit(child);
    }
  }
  visit(value);
  return [...references.values()];
}

/** Select observed material for this pair, including earlier turns and uncited counterevidence. */
function comparisonSources(sources: AssistantSource[], reference: AnalysisReference, result: unknown): AssistantSource[] {
  const parsed = sources.map(source => ({ source, materials: source.content.flatMap(block => {
    if (block.type !== "text" || !block.text) return [];
    try {
      const value = JSON.parse(block.text);
      return value && typeof value === "object" ? [value as JsonObject] : [];
    } catch { return []; }
  }) }));
  const isPair = (ref?: AnalysisReference) => ref?.runId === reference.runId && ref.taskId === reference.taskId;
  const inputIds = new Set(reviewReferences(result, reference.runId).map(ref => ref.inputId));
  for (const { materials } of parsed) for (const material of materials) {
    if (!isPair(material.reference as AnalysisReference | undefined)) continue;
    for (const answer of (material.answers as { reference: AnalysisReference }[] | undefined) ?? [])
      if (answer.reference.runId === reference.runId) inputIds.add(answer.reference.inputId);
  }
  return parsed.filter(({ materials }) => materials.some(material => {
    const ref = material.reference as AnalysisReference | undefined;
    return isPair(ref) || ref?.runId === reference.runId && !!ref.inputId && inputIds.has(ref.inputId);
  })).map(({ source }) => source);
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

/** Keep the exact page once; its node reference, format and offset locate every character. */
function evidenceMaterial(message: JsonObject, audience?: "model" | "user"): JsonObject {
  if (audience === "user" || message.kind !== "message") return message;
  const { evidence: _evidence, ...material } = message;
  return material;
}

function statisticalScope(summary: JsonObject, names: string[]): string {
  const batches = summary.batches as string[] | undefined;
  if (!batches?.length) throw new Error("正式统计缺少登记批次。");
  const { tiers } = summary.formalComparisonStats as { tiers: { comparisonTier: string; comparisonCount: number }[] };
  return `${batches.join("、")} · ${[...new Set(names)].map(name => {
    const tier = tiers.find(tier => tier.comparisonTier === name);
    if (!tier) throw new Error("该档没有正式统计。");
    return `${name} ${tier.comparisonCount}场`;
  }).join("、")}`;
}

export function erisTools(options: ErisDependencies, descriptions: Record<string, string>): AssistantTool[] {
  const validateCheck = new Ajv2020({ strict: false }).compile<{ issues: { path: string; reason: string }[] }>(checkSchema);
  const execute: Record<keyof typeof schemas, AssistantTool["execute"]> = {
    list_data: async (value) => {
      const result = await options.data.list(value as JsonObject);
      const current = result.currentRun as JsonObject | undefined;
      // Apply to every page, including empty searches. Chart validation still reads complete provenance.
      return textResult({ ...result,
        ...(result.summary ? { summary: directorySummary(result.summary as JsonObject) } : {}),
        ...(current?.summary ? { currentRun: { ...current, summary: directorySummary(current.summary as JsonObject) } } : {}),
        ...(result.currentRuns ? { currentRuns: (result.currentRuns as JsonObject[]).map(run => ({ ...run, summary: directorySummary(run.summary as JsonObject) })) } : {}),
      });
    },
    read_case: async (value, context) => {
      const args = value as { reference: AnalysisReference | AnalysisCaseLookup; review?: boolean };
      const data = await options.data.read(args.reference, { view: "case", ...(context.audience === "user" ? { audience: "user" as const } : {}) });
      const formal = data.formal as JsonObject | undefined;
      const review = args.review === true && context.audience !== "user";
      const answers = (data.answers as JsonObject[]).map(answer => {
        if (context.audience === "user") return answer;
        if (review) { const { trace: _trace, ...response } = answer; return response; }
        const trace = answer.trace as JsonObject;
        // All nodes belong to answer.reference; messageIndex supplies the remaining coordinate.
        return { ...answer, trace: { ...trace, nodes: (trace.nodes as JsonObject[]).map(({ reference: _reference, ...node }) => node) } };
      });
      const { formal: _formal, ...caseData } = data;
      const originalVerdicts = ((formal?.comparisonScope as JsonObject | undefined)?.comparisons as JsonObject[] | undefined)?.map(pair => ({
        result: pair.result, winnerModel: pair.winnerModel, models: (pair.models as JsonObject[] | undefined)?.map(model => model.model),
      }));
      return { ...textResult({ ...caseData, answers, ...(formal ? review ? { originalVerdicts }
        : { formal: { ...formal, result: resultSummary(formal.result, args.reference.runId) } } : {}) }),
        details: { sourceRead: { tool: "read_case", args: { reference: data.reference, ...(args.review === undefined ? {} : { review: args.review }) } } } };
    },
    read_evidence: async (value, context) => {
      const args = value as { reference: AnalysisReference } & Omit<Extract<AnalysisReadOptions, { view: "evidence" }>, "view">;
      const data = await options.data.read(args.reference, { view: "evidence", messages: args.messages });
      return { ...textResult({ ...data, items: (data.items as JsonObject[]).map(item => evidenceMaterial(item, context.audience)) }),
        isError: data.readCount === 0, details: { sourceRead: { tool: "read_evidence", args } } };
    },
    read_data: async (value, context) => {
      const args = value as { reference: AnalysisReference } & AnalysisResultReadOptions;
      const data = await options.data.read(args.reference, args);
      return args.reference.taskId ? textResult(args.view === "details"
        ? { kind: "accepted-result", reference: args.reference, view: "details", ...resultPage(data, args) }
        : { ...data, view: "summary", result: data.comparisonScope
          ? { status: (data.result as JsonObject).status, ground_truth: (data.result as JsonObject).ground_truth,
            evidence_references: reviewReferences(data.result, args.reference.runId) }
          : resultSummary(data.result) })
        : { ...textResult(evidenceMaterial(data, context.audience)), details: { sourceRead: { tool: "read_data", args } } };
    },
    search_data: async (value) => { const args = { scope: "evidence" as const, ...value as { reference: AnalysisReference; query: string | string[]; offset?: number; limit?: number; scope?: "evidence" | "all" } }; return { ...textResult(await options.data.search(args.reference, args.query, args)), details: { sourceRead: { tool: "search_data", args } } }; },
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
      return { ...textResult({ ...receipt, view: "summary", ...(body === undefined ? {} : { result: resultSummary(body) }) }), isError: result.state === "failed" || result.state === "cancelled" };
    },
    read_specialist: async (value, context) => {
      const args = value as { operationId: string } & AnalysisResultReadOptions;
      const { result, ...receipt } = await options.specialists.read(context.scope, args.operationId);
      return textResult({ ...receipt, view: args.view ?? "summary", ...(result === undefined ? {} : { result: args.view === "details" ? resultPage(result, args) : resultSummary(result) }) });
    },
    show_comparison: async (value, context) => {
      const args = value as ComparisonDiagramInput;
      const result = await options.data.read(args.reference);
      const diagram = comparisonDiagram(args, result);
      if (!context.complete) throw new Error("比较图结论核对不可用，尚未展示");
      const check = await context.complete({ systemPrompt: erisComparisonCheck, text: JSON.stringify(args), outputSchema: checkSchema,
        sourceTools: ["read_case", "search_data", "read_evidence", "read_data"],
        selectSources: sources => comparisonSources(sources, result.reference as AnalysisReference, result.result) });
      let review: unknown;
      try { review = JSON.parse(check.text); } catch { /* Preserve invalid output and usage for diagnosis. */ }
      if (!validateCheck(review)) return { ...textResult({ kind: "comparison-check", error: "比较图结论核对格式无效，尚未展示", issues: schemaIssues(validateCheck.errors) }),
        isError: true, details: { consistencyCheck: check } };
      const consistencyCheck = { ...check, issues: review.issues };
      if (review.issues.length) return { ...textResult({ kind: "comparison-check", issues: review.issues }), isError: true, details: { consistencyCheck } };
      return { ...textResult({ kind: "comparison-diagram", diagram }),
        ...(args.complete ? { terminate: true } : {}),
        details: { reference: result.reference, evaluatorVersion: result.evaluatorVersion, consistencyCheck } };
    },
    show_chart: async (value, context) => {
      const { references = [], ...chart } = value as ChartSpec & { references?: { runId?: string; operationId?: string; reference?: AnalysisReference; statistics?: { runId: string; comparisonTier: string } }[] };
      validateChart(chart);
      const citations: unknown[] = [];
      const timeScopes = new Map<string, string>();
      // Only share within this chart. A later tool call must observe new accepted results.
      const runs = new Map<string, Awaited<ReturnType<AnalysisDataSource["list"]>>>();
      const readRun = async (runId: string) => {
        if (!runs.has(runId)) runs.set(runId, await options.data.list({ runId, limit: 1 }));
        return runs.get(runId)!;
      };
      for (const item of references) {
        context.signal.throwIfAborted();
        if (item.statistics) {
          const result = await readRun(item.statistics.runId);
          const summary = result.summary as { formalComparisonStats?: { tiers: { comparisonTier: string; comparisonCount: number; references: AnalysisReference[] }[] } } | undefined;
          const tier = summary?.formalComparisonStats?.tiers?.find(tier => tier.comparisonTier === item.statistics!.comparisonTier);
          if (result.kind !== "inputs" || !tier || tier.comparisonCount <= 0 || !tier.references?.length)
            throw new Error("该运行与档位没有可引用的正式统计");
          if (references.every(item => item.statistics)) timeScopes.set(item.statistics.runId, statisticalScope(result.summary as JsonObject,
            references.filter(ref => ref.statistics?.runId === item.statistics!.runId).map(ref => ref.statistics!.comparisonTier)));
          citations.push({ statistics: item.statistics, evaluatorVersion: result.evaluatorVersion, references: tier.references,
            timeScope: (result.summary as JsonObject).timeScope, batches: (result.summary as JsonObject).batches });
        } else if (item.operationId) {
          const result = await options.specialists.read(context.scope, item.operationId);
          if (result.state !== "succeeded") throw new Error("图表只能引用已接受的专业结果");
          citations.push({ operationId: item.operationId, evaluatorVersion: result.evaluatorVersion, reference: result.reference });
        } else if (item.runId) {
          const result = await readRun(item.runId);
          if (result.kind !== "inputs") throw new Error("图表目录引用不存在");
          citations.push({ runId: item.runId, evaluatorVersion: result.evaluatorVersion });
        } else if (item.reference) {
          const result = await options.data.read(item.reference);
          if (item.reference.taskId ? !result.result : !["messages", "message"].includes(String(result.kind)))
            throw new Error("图表来源不存在或没有已接受的正式结果");
          citations.push({ reference: item.reference, ...(result.evaluatorVersion ? { evaluatorVersion: result.evaluatorVersion } : {}) });
        }
      }
      if (timeScopes.size) chart.scope = [...timeScopes.values()].join("；");
      const result = textResult({ kind: "chart", chart });
      return citations.length ? { ...result, details: { references: citations } } : result;
    },
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return erisToolNames.map((name) => {
    const inputSchema = schemas[name];
    const validate = ajv.compile(inputSchema);
    const validateArgs = (value: unknown) => {
      if (validate(value)) return;
      const issues = schemaIssues(validate.errors).map(({ path, code, expected }) => {
        const issue = { path, code, expected };
        if (code !== "schema_maxLength") return issue;
        const field = path.split("/").slice(1).reduce<unknown>((parent, key) => parent !== null && typeof parent === "object"
          ? (parent as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, value);
        if (typeof field !== "string") return issue;
        const actualLength = [...field].length;
        return { ...issue, actualLength, excess: actualLength - (expected as { limit: number }).limit };
      });
      throw new Error(`${name} 参数无效；未执行。只修正以下字段，不原样重试：${JSON.stringify(issues)}。${ajv.errorsText(validate.errors)}`);
    };
    return { name, description: descriptions[name], inputSchema, readOnly: ["list_data", "read_case", "read_evidence", "read_data", "search_data", "search_web", "read_web", "view_image", "calculate", "read_code_output", "read_specialist", "show_chart", "show_comparison"].includes(name),
      validate: validateArgs,
      async execute(value, context) {
        context.signal.throwIfAborted();
        validateArgs(value);
        return execute[name](value, context);
      },
    };
  });
}
