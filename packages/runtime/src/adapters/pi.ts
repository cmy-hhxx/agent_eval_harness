import path from "node:path";
import * as sdk from "#pi-sdk";
import { object, type AgentBackend, type EngineIdentity } from "@eval/contracts";
import { activeToolNames, contentToolName, inlineToolSchema, providerConfig, sdkContent, transformPayload } from "../sdk-utils.js";
import { controlledModelStream } from "../model-request.js";
import { providerFetch } from "../provider-http.js";

export function piBackend(identity: EngineIdentity): AgentBackend {
  return {
    identity,
    async createSession(options) {
      const { spec, workdir } = options,
        agentDir = path.join(workdir, ".agent");
      let requestModel = spec.model;
      const names = options.tools.map((tool) => tool.name);
      let nextTool = contentToolName(spec.evaluation, Boolean(spec.recovery?.inspection));
      let activeNames = activeToolNames({ content: [] }, names, nextTool);
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
            api.on("before_provider_request", (event) => transformPayload(event.payload, requestModel, spec.evaluation, activeNames));
            if (spec.debug && spec.model.api === "openai-responses") api.on("provider_stream_event", (event) => {
              if (event.api !== "openai-responses") return;
              if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return;
              const data = object(event.data);
              if (data.type !== "response.completed" && data.type !== "response.incomplete") return;
              if (!data.response || typeof data.response !== "object" || Array.isArray(data.response)) return;
              const response = object(data.response);
              if (!Array.isArray(response.output)) return;
              const calls = response.output.flatMap(item => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return [];
                const call = object(item);
                return call.type === "function_call" && typeof call.arguments === "string"
                  ? [{ id: call.id, call_id: call.call_id, name: call.name, arguments: call.arguments }] : [];
              });
              if (calls.length) options.onEvent({ type: "provider_tool_arguments", response_id: response.id,
                status: response.status, calls });
            });
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
        executionMode: "sequential",
        async execute(_id, args, signal) {
          const result = await options.execute(tool.name, args, signal);
          nextTool = (result.details as { next_tool?: string } | undefined)?.next_tool ?? nextTool;
          activeNames = activeToolNames(result, names, nextTool);
          if (result.isError)
            throw new Error(
              result.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n"),
            );
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
      const providerStream = session.agent.streamFunction;
      session.agent.streamFunction = (_model, context, streamOptions) => {
        const routed = runtime.getModel(requestModel.provider, requestModel.model);
        if (!routed) throw new Error("Granted model unavailable");
        return providerStream(routed, context, { ...streamOptions, fetch: providerFetch,
          apiKey: process.env[requestModel.apiKeyEnv] });
      };
      if (options.modelRequest)
        session.agent.streamFunction = controlledModelStream(session.agent.streamFunction, async signal => {
          const permit = await options.modelRequest!(signal);
          try {
            requestModel = permit.model;
            const key = process.env[requestModel.apiKeyEnv];
            if (!key) throw new Error(`Missing ${requestModel.apiKeyEnv}`);
            runtime.registerProvider(requestModel.provider, providerConfig(requestModel));
            await runtime.setRuntimeApiKey(requestModel.provider, key);
            options.onEvent({ type: "model_route", channel: requestModel.provider, model: requestModel.model });
            return permit.release;
          } catch (error) { await permit.release(); throw error; }
        }, (_model, _context, options) => options?.signal);
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
