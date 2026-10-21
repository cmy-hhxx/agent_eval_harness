import path from "node:path";
import * as sdk from "#prime-sdk";
import { setLogSink, stringifyLogEntry } from "#prime-ai";
import type { AgentBackend, EngineIdentity } from "@eval/contracts";
import { redact } from "@eval/contracts";
import { activeToolNames, contentToolName, inlineToolSchema, providerConfig, sdkContent, transformPayload } from "../sdk-utils.js";
import { controlledModelStream } from "../model-request.js";

const credentials = new Set<string>();
setLogSink(entry => {
  if (entry.level === "warn" || entry.level === "error")
    console.error(redact(stringifyLogEntry(entry), [...credentials]));
});

export function primeBackend(identity: EngineIdentity): AgentBackend {
  return {
    identity,
    async createSession(options) {
      const { spec, workdir } = options,
        agentDir = path.join(workdir, ".agent");
      const names = options.tools.map((tool) => tool.name);
      let nextTool = contentToolName(spec.evaluation, Boolean(spec.recovery?.inspection));
      let activeNames = activeToolNames({ content: [] }, names, nextTool);
      const secret = process.env[spec.model.apiKeyEnv];
      if (!secret) throw new Error(`Missing ${spec.model.apiKeyEnv}`);
      credentials.add(secret);
      const auth = sdk.AuthStorage.create(path.join(agentDir, "auth.json"));
      auth.setRuntimeApiKey(spec.model.provider, secret);
      const registry = sdk.ModelRegistry.inMemory(auth);
      registry.registerProvider(spec.model.provider, {
        ...providerConfig(spec.model),
        apiKey: secret,
      });
      const model = registry.find(spec.model.provider, spec.model.model);
      if (!model) throw new Error("Configured model unavailable");
      const settings = sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        autoRefine: { enabled: false },
        packages: [],
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd: workdir,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: spec.evaluation.systemPrompt,
        extensionFactories: [
          (api) => {
            api.on("before_provider_request", (event) => transformPayload(event.payload, spec.model, spec.evaluation, activeNames));
          },
        ],
      });
      await loader.reload();
      const customTools: sdk.ToolDefinition[] = options.tools.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        // Host owns complete submission validation; the SDK only checks the JSON object envelope.
        parameters: (tool.name === "submit_evaluation" || (tool.name === "inspect_material" && !spec.evaluation.fileSubmission)
          ? { type: "object" } : inlineToolSchema(tool.inputSchema)) as sdk.ToolDefinition["parameters"],
        async execute(_id, args, signal) {
          const result = await options.execute(tool.name, args, signal);
          nextTool = (result.details as { next_tool?: string } | undefined)?.next_tool ?? nextTool;
          activeNames = activeToolNames(result, names, nextTool);
          return {
            ...result,
            content: sdkContent(result.content),
            details: result.details ?? {},
          };
        },
      }));
      const { session } = await sdk.createAgentSession({
        cwd: workdir,
        agentDir,
        authStorage: auth,
        modelRegistry: registry,
        model,
        thinkingLevel: spec.model.thinking,
        settingsManager: settings,
        sessionManager: sdk.SessionManager.inMemory(workdir),
        resourceLoader: loader,
        noTools: "builtin",
        tools: customTools.map((t) => t.name),
        customTools,
      });
      await session.bindExtensions({});
      if (options.modelRequest)
        session.agent.streamFn = controlledModelStream(session.agent.streamFn, options.modelRequest, (_model, _context, options) => options?.signal);
      const unsubscribe = session.subscribe(options.onEvent);
      return {
        run: (prompt) => session.prompt(prompt),
        abort: () => session.abort(),
        async dispose() {
          unsubscribe();
          await session.abort();
          await session.disposeAsync({ kernelSnapshot: false });
        },
      };
    },
  };
}
