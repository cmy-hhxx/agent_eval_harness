import { Ajv2020 } from "ajv/dist/2020.js";
import { type AnalysisDataSource, type AnalysisReference, type AssistantScope, type AssistantTool, type JsonObject, type SpecialistGateway, type SpecialistRequest } from "@eval/contracts";
import { assistantPrompt } from "@eval/prompts";
import { calculate, textResult } from "@eval/tools";
import schemas from "../../../schemas/assistant/tools.json" with { type: "json" };

export function analysisTools(options: { data: AnalysisDataSource; specialists: SpecialistGateway; save(scope: AssistantScope, markdown: string): Promise<JsonObject> }): AssistantTool[] {
  const descriptions = assistantPrompt().toolDescriptions;
  const execute: Record<string, AssistantTool["execute"]> = {
    list_data: async (value) => textResult(await options.data.list(value as JsonObject)),
    read_data: async (value) => { const args = value as { reference: AnalysisReference; offset?: number; limit?: number }; const result = textResult(await options.data.read(args.reference, args)); return args.reference.taskId ? result : { ...result, details: { sourceRead: { tool: "read_data", args } } }; },
    search_data: async (value) => { const args = value as { reference: AnalysisReference; query: string; offset?: number; limit?: number }; return { ...textResult(await options.data.search(args.reference, args.query, args)), details: { sourceRead: { tool: "search_data", args } } }; },
    view_image: async (value) => ({ ...await options.data.image((value as { reference: AnalysisReference }).reference), details: { sourceRead: { tool: "view_image", args: value } } }),
    calculate: async (value) => { const args = value as { operation: string; operands: string[] }; return textResult(calculate(args.operation, args.operands)); },
    call_specialist: async (value, context) => textResult(await options.specialists.invoke(context.scope, value as SpecialistRequest, context.signal, context.progress)),
    read_specialist: async (value, context) => textResult(await options.specialists.read(context.scope, (value as { operationId: string }).operationId)),
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
      const markdown = `${args.markdown}\n\n## 结果引用\n\n${citations.map((entry) => `- \`${JSON.stringify(entry)}\``).join("\n")}\n`;
      return textResult(await options.save(context.scope, markdown));
    },
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return Object.entries(schemas).map(([name, inputSchema]) => {
    const validate = ajv.compile(inputSchema);
    return { name, description: descriptions[name], inputSchema, readOnly: ["list_data", "read_data", "search_data", "view_image", "calculate", "read_specialist"].includes(name),
      async execute(value, context) {
        if (!validate(value)) throw new Error(ajv.errorsText(validate.errors));
        return execute[name](value, context);
      },
    };
  });
}
