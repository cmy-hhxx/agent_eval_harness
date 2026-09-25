import path from "node:path";
import * as sdk from "#prime-sdk";
import type { AgentBackend, EngineIdentity } from "@eval/contracts";
import { providerConfig, sdkContent, transformPayload } from "../sdk-utils.js";

export function primeBackend(identity: EngineIdentity): AgentBackend {
  return {
    identity,
    async createSession(options) {
      const { spec, workdir } = options,
        agentDir = path.join(workdir, ".agent");
      const secret = process.env[spec.model.apiKeyEnv];
      if (!secret) throw new Error(`Missing ${spec.model.apiKeyEnv}`);
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
        async execute(_id, args, signal) {
          const result = await options.execute(tool.name, args, signal);
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
