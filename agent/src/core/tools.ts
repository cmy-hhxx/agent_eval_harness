import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, parseEvidenceCoordinates, schemaIssues, type AnalysisDataSource, type AnalysisReference, type AnalysisCaseLookup, type AnalysisQuery, type AnalysisReadOptions, type AnalysisResultReadOptions, type AssistantSource, type AssistantTool, type JsonObject, type WebSearchProvider, type WebSearchRequest, type WebReader, type WebReadRequest } from "@eval/contracts";
import { calculate } from "@eval/tools";
import { erisComparisonCheck } from "@eval/prompts";
import schemas from "../../../schemas/eris/tools.json" with { type: "json" };
import checkSchema from "../../../schemas/eris/comparison-check.json" with { type: "json" };
import { comparisonChartData, validateChart, type ChartSpec } from "./chart.js";
import { comparisonDiagram, type ComparisonDiagramInput } from "./comparison-diagram.js";
import { comparisonSample } from "./comparison-sample.js";

export interface ErisDependencies {
  data: AnalysisDataSource;
  search: WebSearchProvider;
  web: WebReader;
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

function resultView(options: AnalysisResultReadOptions) {
  return options.view ?? (options.offset !== undefined || options.limit !== undefined ? "details" : "summary");
}

function withContinuation(tool: string, args: object, page: JsonObject): JsonObject {
  return page.hasMore === true && typeof page.nextOffset === "number"
    ? { ...page, nextRead: { tool, args: { ...args, offset: page.nextOffset } } } : page;
}

/** Filter evidence containers only at the model boundary; accepted rows remain untouched. */
function resultSummary(value: unknown, run?: Pick<AnalysisReference, "collectionId" | "runId">): unknown {
  if (Array.isArray(value)) return value.map(child => resultSummary(child, run));
  if (value === null || typeof value !== "object") return value;
  const { rewritten, ...fields } = value as Record<string, unknown>;
  return { ...(rewritten === undefined ? {} : { rewritten: resultSummary(rewritten, run) }),
    ...Object.fromEntries(Object.entries(fields)
      .flatMap(([key, child]) => {
        if (key !== "evidence" && !key.endsWith("_evidence")) return [[key, resultSummary(child, run)]];
        if (!Array.isArray(child)) return [];
        if (child.some(item => item && typeof item === "object" && "source_id" in item)) return [[key, child]];
        if (!run) return [];
        const references = new Map<string, AnalysisReference>();
        for (const item of child) {
          const coordinate = typeof item?.evidence_id === "string" ? parseEvidenceCoordinates(item.evidence_id) : undefined;
          if (coordinate) references.set(`${coordinate.input_id}:${coordinate.message_index}`, {
            collectionId: run.collectionId, runId: run.runId, inputId: coordinate.input_id, messageIndex: coordinate.message_index,
          });
        }
        return references.size ? [[`${key}_references`, [...references.values()]]] : [];
      })) };
}

/** A review keeps source navigation without treating earlier judgments as facts. */
function reviewReferences(value: unknown, run: Pick<AnalysisReference, "collectionId" | "runId">): AnalysisReference[] {
  const references = new Map<string, AnalysisReference>();
  function visit(item: unknown) {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (item === null || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (key === "evidence_id" && typeof child === "string") {
        const coordinate = parseEvidenceCoordinates(child);
        if (coordinate) references.set(`${coordinate.input_id}:${coordinate.message_index}`, {
          collectionId: run.collectionId, runId: run.runId, inputId: coordinate.input_id, messageIndex: coordinate.message_index,
        });
      } else visit(child);
    }
  }
  visit(value);
  return [...references.values()];
}

/** Combine current case material with earlier observed evidence, including uncited counterevidence. */
function comparisonSources(sources: AssistantSource[], reference: AnalysisReference, result: unknown): AssistantSource[] {
  const parsed = sources.map(source => ({ source, materials: source.content.flatMap(block => {
    if (block.type !== "text" || !block.text) return [];
    try {
      const value = JSON.parse(block.text);
      return value && typeof value === "object" ? [value as JsonObject] : [];
    } catch { return []; }
  }) }));
  const isPair = (ref?: AnalysisReference) => ref?.collectionId === reference.collectionId && ref?.runId === reference.runId && ref.taskId === reference.taskId;
  const inputIds = new Set(reviewReferences(result, reference).map(ref => ref.inputId));
  for (const { materials } of parsed) for (const material of materials) {
    if (!isPair(material.reference as AnalysisReference | undefined)) continue;
    for (const answer of (material.answers as { reference: AnalysisReference }[] | undefined) ?? [])
      if (answer.reference.collectionId === reference.collectionId && answer.reference.runId === reference.runId) inputIds.add(answer.reference.inputId);
  }
  const selected = parsed.filter(({ materials }) => materials.some(material => {
    const ref = material.reference as AnalysisReference | undefined;
    return isPair(ref) || ref?.collectionId === reference.collectionId && ref?.runId === reference.runId && !!ref.inputId && inputIds.has(ref.inputId);
  }));
  // Deduplicate only identical observed material in this request, never by a locator alone.
  const seen = new Set<string>();
  const packed = selected.flatMap(({ source, materials }) => {
    const content = materials.flatMap(material => {
      if (source.tool === "read_evidence" && Array.isArray(material.items)) return material.items as JsonObject[];
      if (source.tool === "read_case" && Array.isArray(material.answers)) return [{ ...material,
        answers: (material.answers as JsonObject[]).map(answer => {
          const trace = answer.trace as JsonObject | undefined;
          // Retain previews and their truncation markers; empty navigation nodes carry no evidence.
          return trace && Array.isArray(trace.nodes) ? { ...answer, trace: { ...trace,
            nodes: (trace.nodes as JsonObject[]).filter(node => typeof node.preview === "string" && node.preview.length > 0) } } : answer;
        }) }];
      return [material];
    }).flatMap(material => {
      let value = material;
      if (material.kind === "message") {
        const { nextRead: _nextRead, limit: _limit, ...page } = material;
        value = page;
      }
      const identity = canonical(value);
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [{ tool: source.tool, content: [{ type: "text" as const, text: JSON.stringify(value) }] }];
    });
    // Preserve non-JSON text and images belonging to a selected source.
    const other = source.content.filter(block => {
      if (block.type !== "text" || !block.text) return true;
      try { const value = JSON.parse(block.text); return !value || typeof value !== "object"; } catch { return true; }
    });
    return [...content, ...(other.length ? [{ tool: source.tool, content: other }] : [])];
  });
  return packed;
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
  const validateChartReceipt = new Ajv2020({ strict: false }).compile({ ...schemas.show_chart,
    required: ["type", "title", "scope", "unit", "source", "categories", "series"] });
  const execute: Record<keyof typeof schemas, AssistantTool["execute"]> = {
    list_data: async (value, context) => {
      const query = value as AnalysisQuery;
      const sampled = query.sample ? await comparisonSample(options.data, query, context) : undefined;
      const result: JsonObject = sampled?.result ?? await options.data.list(query);
      const current = result.currentRun as JsonObject | undefined;
      // Apply to every page, including empty searches. Chart validation still reads complete provenance.
      return { ...textResult({ ...result,
        ...(result.summary ? { summary: directorySummary(result.summary as JsonObject) } : {}),
        ...(current?.summary ? { currentRun: { ...current, summary: directorySummary(current.summary as JsonObject) } } : {}),
        ...(result.currentRuns ? { currentRuns: (result.currentRuns as JsonObject[]).map(run => ({ ...run, summary: directorySummary(run.summary as JsonObject) })) } : {}),
      }), ...(sampled?.qualityCheck ? { details: { qualityCheck: sampled.qualityCheck } } : {}) };
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
        : { formal: { ...formal, result: resultSummary(formal.result, args.reference) } } : {}) }),
        details: { sourceRead: { tool: "read_case", args: { reference: data.reference, ...(args.review === undefined ? {} : { review: args.review }) } } } };
    },
    read_evidence: async (value, context) => {
      const sourceArgs = value as { reference: AnalysisReference; offset?: number; limit?: number };
      if (sourceArgs.reference.sourceId) {
        const result = await options.data.read(sourceArgs.reference, sourceArgs);
        return { ...textResult(withContinuation("read_evidence", sourceArgs, result)), details: { sourceRead: { tool: "read_evidence", args: value } } };
      }
      const { reference: { messageIndex, ...reference }, messages, ...defaults } = value as {
        reference: AnalysisReference; messages?: Extract<AnalysisReadOptions, { view: "evidence" }>["messages"];
        format?: "text" | "json"; offset?: number; limit?: number;
      };
      const args = { reference, messages: (messages ?? [{ messageIndex: messageIndex! }]).map(node => ({ ...defaults, ...node })) };
      const data = await options.data.read(args.reference, { view: "evidence", messages: args.messages });
      return { ...textResult({ ...data, items: (data.items as JsonObject[]).map(item => withContinuation("read_evidence",
        { reference: item.reference, format: item.format, limit: item.limit }, evidenceMaterial(item, context.audience))) }),
        isError: data.readCount === 0, details: { sourceRead: { tool: "read_evidence", args } } };
    },
    read_data: async (value, context) => {
      const args = value as { reference: AnalysisReference } & AnalysisResultReadOptions;
      const data = await options.data.read(args.reference, args);
      return args.reference.taskId ? textResult(resultView(args) === "details"
        ? withContinuation("read_data", { ...args, view: "details" }, { kind: "accepted-result", reference: args.reference, view: "details", ...resultPage(data, args) })
        : { ...data, view: "summary", result: data.comparisonScope
          ? { status: (data.result as JsonObject).status, ground_truth: (data.result as JsonObject).ground_truth,
            evidence_references: reviewReferences(data.result, args.reference) }
          : resultSummary(data.result) })
        : { ...textResult(withContinuation("read_data", args, evidenceMaterial(data, context.audience))), details: { sourceRead: { tool: "read_data", args } } };
    },
    search_data: async (value) => {
      const input = value as { reference: AnalysisReference; query: string | string[]; offset?: number; limit?: number; scope?: "evidence" | "all" };
      const args = { ...input, scope: input.scope ?? (input.reference.messageIndex === undefined ? "evidence" as const : "all" as const) };
      return { ...textResult(withContinuation("search_data", args, await options.data.search(args.reference, args.query, args))),
        details: { sourceRead: { tool: "search_data", args } } };
    },
    search_web: async (value, context) => {
      const result = await options.search.search(value as WebSearchRequest, context.signal);
      return { ...textResult(result), isError: result.attempts.length > 0 && result.attempts.every(attempt => attempt.state === "failed") };
    },
    read_web: async (value, context) => textResult(await options.web.read(value as WebReadRequest, context.signal)),
    view_image: async (value) => ({ ...await options.data.image((value as { reference: AnalysisReference }).reference), details: { sourceRead: { tool: "view_image", args: value } } }),
    calculate: async (value) => { const args = value as { operation: string; operands: string[] }; return textResult(calculate(args.operation, args.operands)); },
    show_comparison: async (value, context) => {
      const args = value as ComparisonDiagramInput;
      const material = await options.data.read(args.reference, { view: "case" });
      context.signal.throwIfAborted();
      const result = material.formal as JsonObject | undefined;
      if (material.kind !== "case" || !result) throw new Error("当前对战缺少正式结果，尚未展示。");
      const { diagram, omittedHighlights } = comparisonDiagram(args, result);
      if (!context.complete) throw new Error("比较图结论核对不可用，尚未展示");
      const reference = result.reference as AnalysisReference;
      const answers = (Array.isArray(material.answers) ? material.answers as JsonObject[] : [])
        .filter(answer => args.candidates.some(candidate => candidate.model === answer.model));
      if (typeof material.question !== "string" || !material.question.trim() || answers.length !== 2
        || new Set(answers.map(answer => answer.model)).size !== 2
        || answers.some(answer => (answer.reference as AnalysisReference | undefined)?.collectionId !== reference.collectionId || (answer.reference as AnalysisReference | undefined)?.runId !== reference.runId || !answer.answer))
        throw new Error("当前对战的原始问题或双方回答缺失，尚未展示；请检查该对战的数据源。");
      const sources: AssistantSource[] = [{ tool: "read_case", ...textResult({ ...material, answers }) }];
      // A long final answer is represented by a preview in read_case; fetch all its pages before checking.
      const continuations = await Promise.all(answers.map(async answer => {
        const response = answer.answer as JsonObject;
        if (response.complete === true && typeof response.text === "string") return [];
        const source = response.reference as AnalysisReference | undefined;
        if (response.complete !== false || !source || source.collectionId !== reference.collectionId || source.runId !== reference.runId || !source.inputId
          || source.inputId !== (answer.reference as AnalysisReference).inputId || !Number.isInteger(source.messageIndex))
          throw new Error("当前对战的原始回答缺少完整正文或有效引用，尚未展示。");
        const pages: AssistantSource[] = [];
        let offset = 0;
        while (true) {
          context.signal.throwIfAborted();
          const page = await options.data.read(source, { offset, limit: 16000 });
          if (page.kind !== "message" || typeof page.text !== "string") throw new Error("当前对战的原始回答续读失败，尚未展示。");
          pages.push({ tool: "read_data", ...textResult(page) });
          if (page.hasMore === false) break;
          if (page.hasMore !== true || !Number.isInteger(page.nextOffset) || Number(page.nextOffset) <= offset)
            throw new Error("当前对战的原始回答分页不完整，尚未展示。");
          offset = Number(page.nextOffset);
        }
        return pages;
      }));
      sources.push(...continuations.flat());
      context.signal.throwIfAborted();
      const { complete: _complete, reasonHighlight: _reasonHighlight, ...draft } = args;
      const check = await context.complete({ systemPrompt: erisComparisonCheck, maxThinking: "low", draft: { ...draft,
        candidates: args.candidates.map(candidate => ({ ...candidate, paths: candidate.paths.map(({ highlights: _highlights, ...path }) => path) })) }, outputSchema: checkSchema,
        sourceTools: ["read_case", "search_data", "read_evidence", "read_data"],
        selectSources: observed => comparisonSources([...sources, ...observed], reference, result.result) });
      let review: unknown;
      try { review = JSON.parse(check.text); } catch { /* Preserve invalid output and usage for diagnosis. */ }
      if (!validateCheck(review)) return { ...textResult({ kind: "comparison-check", error: "比较图结论核对格式无效，尚未展示", issues: schemaIssues(validateCheck.errors) }),
        isError: true, details: { consistencyCheck: check } };
      const consistencyCheck = { ...check, issues: review.issues };
      if (review.issues.length) return { ...textResult({ kind: "comparison-check", issues: review.issues }), isError: true, details: { consistencyCheck } };
      return { ...textResult({ kind: "comparison-diagram", diagram }),
        ...(args.complete ? { terminate: true } : {}),
        details: { reference: result.reference, evaluatorVersion: result.evaluatorVersion, consistencyCheck,
          ...(omittedHighlights.length ? { omittedHighlights } : {}) } };
    },
    show_chart: async (value, context) => {
      const { statistics, references: suppliedReferences, ...input } = value as Partial<ChartSpec> & { title: string;
        statistics?: { collectionId: string; runId: string; comparisonTier: string };
        references?: { collectionId?: string; runId?: string; reference?: AnalysisReference; statistics?: { collectionId: string; runId: string; comparisonTier: string } }[] };
      const references: NonNullable<typeof suppliedReferences> = statistics ? [{ statistics }] : suppliedReferences ?? [];
      let chart = { type: "heatmap", source: "本地评测材料", ...input } as ChartSpec;
      if (!statistics) validateChart({ ...chart, annotations: undefined });
      const citations: unknown[] = [];
      const timeScopes = new Map<string, string>();
      // Only share within this chart. A later tool call must observe new accepted results.
      const runs = new Map<string, Awaited<ReturnType<AnalysisDataSource["list"]>>>();
      const readRun = async (runId: string, collectionId: string) => {
        const key = JSON.stringify([collectionId, runId]);
        if (!runs.has(key)) runs.set(key, await options.data.list({ collectionId, runId, limit: 1 }));
        return runs.get(key)!;
      };
      for (const item of references) {
        context.signal.throwIfAborted();
        if (item.statistics) {
          const result = await readRun(item.statistics.runId, item.statistics.collectionId);
          const summary = result.summary as { formalComparisonStats?: { tiers: (JsonObject & { comparisonTier: string; comparisonCount: number; references: AnalysisReference[] })[] } } | undefined;
          const tier = summary?.formalComparisonStats?.tiers?.find(tier => tier.comparisonTier === item.statistics!.comparisonTier);
          if (result.kind !== "inputs" || !tier || tier.comparisonCount <= 0 || !tier.references?.length)
            throw new Error("该运行与档位没有可引用的正式统计");
          if (statistics) chart = { ...chart, ...comparisonChartData(tier) };
          if (references.every(item => item.statistics)) timeScopes.set(JSON.stringify([item.statistics.collectionId, item.statistics.runId]), statisticalScope(result.summary as JsonObject,
            references.filter(ref => ref.statistics?.collectionId === item.statistics!.collectionId && ref.statistics?.runId === item.statistics!.runId).map(ref => ref.statistics!.comparisonTier)));
          citations.push({ statistics: item.statistics, evaluatorVersion: result.evaluatorVersion, references: tier.references,
            timeScope: (result.summary as JsonObject).timeScope, batches: (result.summary as JsonObject).batches });
        } else if (item.runId) {
          const result = await readRun(item.runId, item.collectionId!);
          if (result.kind !== "inputs") throw new Error("图表目录引用不存在");
          citations.push({ collectionId: item.collectionId, runId: item.runId, evaluatorVersion: result.evaluatorVersion });
        } else if (item.reference) {
          const result = await options.data.read(item.reference);
          if (item.reference.taskId ? !result.result : !["messages", "message"].includes(String(result.kind)))
            throw new Error("图表来源不存在或没有已接受的正式结果");
          citations.push({ reference: item.reference, ...(result.evaluatorVersion ? { evaluatorVersion: result.evaluatorVersion } : {}) });
        }
      }
      if (timeScopes.size) chart.scope = [...timeScopes.values()].join("；");
      const omittedAnnotations: number[] = [];
      if (chart.annotations) chart.annotations = chart.annotations.filter((annotation, index) => {
        const valid = chart.categories[annotation.categoryIndex] !== undefined && chart.series[annotation.seriesIndex] !== undefined
          && chart.series[annotation.seriesIndex].values[annotation.categoryIndex] != null
          && (!["scatter", "bubble"].includes(chart.type) || chart.xValues?.[annotation.categoryIndex] != null)
          && (chart.type !== "bubble" || chart.sizeValues?.[annotation.categoryIndex] != null);
        if (!valid) omittedAnnotations.push(index);
        return valid;
      });
      if (!validateChartReceipt(chart)) throw new Error(`图表数据无法呈现：${JSON.stringify(schemaIssues(validateChartReceipt.errors))}`);
      validateChart(chart);
      const result = textResult({ kind: "chart", chart });
      return { ...result, ...(citations.length || omittedAnnotations.length ? { details: {
        ...(citations.length ? { references: citations } : {}), ...(omittedAnnotations.length ? { omittedAnnotations } : {}),
      } } : {}) };
    },
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return erisToolNames.map((name) => {
    const inputSchema = schemas[name];
    const validate = ajv.compile(inputSchema);
    const validateArgs = (value: unknown) => {
      if (validate(value)) return;
      const errors = validate.errors?.filter(error => error.keyword !== "if");
      const issues = schemaIssues(errors).map(({ path, code, expected }) => {
        const issue = { path, code, expected };
        if (code !== "schema_maxLength") return issue;
        const field = path.split("/").slice(1).reduce<unknown>((parent, key) => parent !== null && typeof parent === "object"
          ? (parent as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined, value);
        if (typeof field !== "string") return issue;
        const actualLength = [...field].length;
        return { ...issue, actualLength, excess: actualLength - (expected as { limit: number }).limit };
      });
      throw new Error(`${name} 参数无效；未执行。只修正以下字段，不原样重试：${JSON.stringify(issues)}。${ajv.errorsText(errors)}`);
    };
    return { name, description: descriptions[name], inputSchema, readOnly: ["list_data", "read_case", "read_evidence", "read_data", "search_data", "search_web", "read_web", "view_image", "calculate", "show_chart", "show_comparison"].includes(name),
      validate: validateArgs,
      async execute(value, context) {
        context.signal.throwIfAborted();
        validateArgs(value);
        return execute[name](value, context);
      },
    };
  });
}
