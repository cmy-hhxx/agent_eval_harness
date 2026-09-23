import path from "node:path";
import * as sdk from "#pi-sdk";
import type { AgentBackend, EngineIdentity } from "../../contracts/src/index.js";
import { providerConfig, sdkContent, transformPayload } from "../../worker/src/sdk-utils.js";

export function piBackend(identity: EngineIdentity): AgentBackend {
  return {
    identity,
    async createSession(options) {
      const { spec, workdir } = options,
        agentDir = path.join(workdir, ".agent");
      const secret = process.env[spec.model.apiKeyEnv];
      if (!secret) throw new Error(`Missing ${spec.model.apiKeyEnv}`);
      const runtime = await sdk.ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      runtime.registerProvider(spec.model.provider, providerConfig(spec.model));
      await runtime.setRuntimeApiKey(spec.model.provider, secret);
      const model = runtime.getModel(spec.model.provider, spec.model.model);
      if (!model) throw new Error("Configured model unavailable");
      const settings = sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        cacheWarming: "off",
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
            api.on("before_provider_request", (event) => transformPayload(event.payload, spec.model));
          },
        ],
      });
      await loader.reload();
      const customTools: sdk.ToolDefinition[] = options.tools.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as sdk.ToolDefinition["parameters"],
        executionMode: "sequential",
        async execute(_id, args, signal) {
          const result = await options.execute(tool.name, args, signal);
          if (result.isError)
            throw new Error(result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
          return { ...result, content: sdkContent(result.content), details: result.details ?? {} };
        },
      }));
      const { session } = await sdk.createAgentSession({
        cwd: workdir,
        agentDir,
        modelRuntime: runtime,
        model,
        thinkingLevel: spec.model.thinking,
        settingsManager: settings,
        sessionManager: sdk.SessionManager.inMemory(workdir),
        resourceLoader: loader,
        noTools: "builtin",
        tools: customTools.map((t) => t.name),
        customTools,
      });
      await session.bindExtensions({ mode: "rpc" });
      const unsubscribe = session.subscribe(options.onEvent);
      return {
        run: (prompt) => session.prompt(prompt),
        abort: () => session.abort(),
        async dispose() {
          unsubscribe();
          await session.abort();
          session.dispose();
        },
      };
    },
  };
}
