import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { parseSettings, readSettings, applySettings, loadConfig, createModelResolver, boundProfiles } from "@eval/host-app/config";
import { discoverAssistantModels } from "@eval/runtime/assistant";
import { listen, json } from "@eval/runtime/http";
import { ROOT } from "../../fixtures/services.js";

const ini = `# Two independently authenticated channels
[channel.evaluation-gateway]
base_url = https://first.example/v1
api_key = "first=key#;"
model = shared-model
supports_explicit_prompt_caching = true
traffic_weight = 6
[channel.openai]
name = OpenAI
base_url = https://second.example/v1
api_key = 'second=key#;'
api = openai-completions
supports_developer_role = false
traffic_weight = 4
[agent]
channel = openai
model = shared-model
thinking = high
[automation]
channels = openai, evaluation-gateway
[environment]
SEARCH_API_KEY = "search=key#;"
`;

test("standalone attribution accepts one input model while comparison still requires two", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "attribution-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "single.json"), base = path.join(ROOT, "configs/host.json");
  const input = { versions: [{ id: "only", name: "Only", adapter: "a", sources: [{ kind: "file", path: "/data/one.jsonl" }] }] };
  await writeFile(file, JSON.stringify({ workflow: "attribution", inputs: input }));
  assert.equal((await loadConfig([base, file], parseSettings(ini))).workflow, "attribution");
  await writeFile(file, JSON.stringify({ workflow: "comparison", inputs: input }));
  await assert.rejects(loadConfig([base, file], parseSettings(ini)), /至少配置两个输入版本/);
});

test("INI channels preserve literal secrets, reject ambiguous input and never quote secret-bearing lines in errors", () => {
  const config = parseSettings("\uFEFF" + ini.replaceAll("\n", "\r\n"));
  assert.equal(config.environment[config.channels.openai.apiKeyEnv], "second=key#;");
  assert.equal(config.environment.SEARCH_API_KEY, "search=key#;");
  assert.deepEqual(config.automation.channels, ["openai", "evaluation-gateway"]);
  assert.equal(config.channels["evaluation-gateway"].trafficWeight, 6);
  assert.equal(config.channels.openai.trafficWeight, 4);
  const identities = parseSettings(ini + "\n[channel.evaluation_gateway]\nbase_url=https://third.example\napi_key=third\n");
  const references = Object.values(identities.channels).map(channel => channel.apiKeyEnv);
  assert.equal(new Set(references).size, 3);
  assert(references.every(reference => /^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)));
  for (const text of [
    ini + "\n[agent]\nmodel=duplicate", ini + "\nSEARCH_API_KEY=duplicate",
    ini.replace("https://first.example/v1", "file:///private/secret"),
    ini.replace("https://first.example/v1", "https://user:secret@example.com/v1"),
    ini.replace("api_key = 'second=key#;'", 'api_key = "unterminated-secret'),
    ini.replace("thinking = high", "thinking = extreme"),
    ini.replace("thinking = high", "max_output_tokens = 0"),
    ini.replace("channel = openai", "channel = absent"),
    ini.replace("api = openai-completions", "api = unsupported"),
    ini.replace("supports_developer_role = false", "supports_developer_role = 0"),
    ini.replace("supports_explicit_prompt_caching = true", "supports_explicit_prompt_caching = 1"),
    ...["0", "-1", "1.5", "six"].map(value => ini.replace("traffic_weight = 6", `traffic_weight = ${value}`)),
    ini.replace("channels = openai, evaluation-gateway", "channels = openai, absent"),
    ini.replace("channels = openai, evaluation-gateway", "channels = openai, openai"),
    ini.replace("channels = openai, evaluation-gateway", "channels ="),
  ]) assert.throws(() => parseSettings(text), error => error instanceof Error && !/key#|unterminated-secret|user:secret/.test(error.message));
});

test("INI proxy configuration reaches a model catalog while local Host requests bypass it", async () => {
  const names = ["http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const requests: string[] = [];
  const gateway = await listen(async (req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer proxy-fixture");
    return json(res, { data: [{ id: "shared-model" }] });
  });
  const sockets = new Set<Duplex>();
  const proxy = createServer();
  proxy.on("connect", (request, socket, head) => {
    requests.push(request.url!);
    const upstream = connect(Number(new URL(gateway.url).port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    for (const stream of [socket, upstream]) {
      sockets.add(stream);
      stream.on("error", () => { socket.destroy(); upstream.destroy(); });
      stream.on("close", () => sockets.delete(stream));
    }
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const local = await listen(async (_req, res) => json(res, { ok: true }));
  try {
    for (const name of names) delete process.env[name];
    const settings = parseSettings(`[channel.proxy-test]
base_url=http://catalog.invalid/v1
api_key=proxy-fixture
[environment]
http_proxy=http://127.0.0.1:${(proxy.address() as { port: number }).port}
no_proxy=internal.example
NO_PROXY=legacy.example
`);
    applySettings(settings);
    assert.deepEqual(new Set(process.env.no_proxy!.split(",")), new Set(["internal.example", "legacy.example", "localhost", "127.0.0.1", "::1"]));
    assert.equal(process.env.NO_PROXY, process.env.no_proxy);
    assert.equal((await discoverAssistantModels(settings.channels["proxy-test"]))[0].id, "shared-model");
    assert.deepEqual(await (await fetch(local.url)).json(), { ok: true });
    assert.deepEqual(requests, ["catalog.invalid:80"]);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    applySettings({ channels: {}, agent: {}, automation: { channels: [] }, environment: {} });
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await gateway.close(); await local.close();
  }
});

test("each evaluation stage can route an identical model ID to a different channel without exposing keys", async () => {
  const settings = parseSettings(ini.replace("api = openai-completions", "api = openai-responses\ncontext_window = 8192\nmax_output_tokens = 2048"));
  const config = await loadConfig(path.join(ROOT, "configs/host.json"), settings, {
    bindings: { comparison: { channel: "openai", model: "shared-model" } },
  });
  const resolve = createModelResolver(config.models);
  assert.equal(resolve("attribution").baseUrl, "https://first.example/v1");
  assert.equal(resolve("comparison").baseUrl, "https://second.example/v1");
  assert.equal(resolve("comparison").api, "openai-responses");
  assert.equal(resolve("comparison").contextWindow, 8192);
  assert.equal(resolve("comparison").maxOutputTokens, 2048);
  assert.equal(resolve("comparison").supportsDeveloperRole, false);
  assert.equal(resolve("attribution").supportsExplicitPromptCaching, true);
  assert.equal(resolve("comparison").supportsExplicitPromptCaching, undefined, "channel overrides must not inherit proprietary cache controls");
  assert.equal(process.env[resolve("comparison").apiKeyEnv], "second=key#;");
  assert(boundProfiles(config.models).some(profile => profile.provider === "openai"));
  assert(!JSON.stringify(config).includes("key#"));
  await assert.rejects(loadConfig(path.join(ROOT, "configs/host.json"), settings, {
    bindings: { comparison: { channel: "missing" } },
  }), /Unknown bindings.comparison.channel/);
});

test("evaluation profiles cannot override channel protocol or capabilities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "model-profile-fields-"));
  try {
    const file = path.join(directory, "models.json"), base = path.join(ROOT, "configs/host.json");
    for (const [field, value] of Object.entries({ api: "openai-responses", baseUrl: "https://other.example", supportsDeveloperRole: false,
      contextWindow: 1000, maxOutputTokens: 500 })) {
      await writeFile(file, JSON.stringify({ models: { judge: { [field]: value } } }));
      await assert.rejects(loadConfig([base, file], parseSettings(ini)), new RegExp(`Invalid models.judge.${field}`));
    }
    await writeFile(file, JSON.stringify({ bindings: { comparison: { maxOutputTokens: 100 } } }));
    await assert.rejects(loadConfig([base, file], parseSettings(ini)), /Invalid bindings.comparison.maxOutputTokens/);
    await assert.rejects(loadConfig(base, parseSettings(ini), { bindings: { comparison: { channel: "openai" } } }), /requires openai-responses/);
    const host = await loadConfig(base, parseSettings(ini));
    host.models.models.judge.api = "openai-completions";
    assert.throws(() => createModelResolver(host.models)("comparison"), /requires openai-responses/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("evaluation routing enforces explicit model and effort catalogs before inference", async () => {
  const settings = parseSettings(ini.replace("model = shared-model", "model = shared-model\nmodels = shared-model\nefforts = off, low, medium, high"));
  const host = await loadConfig(path.join(ROOT, "configs/host.json"), settings);
  const resolve = createModelResolver(host.models);
  assert.equal(resolve("comparison").model, "shared-model");
  host.models.bindings.comparison.model = "missing-model";
  assert.throws(() => resolve("comparison"), /not declared/);
  host.models.bindings.comparison.model = "shared-model";
  host.models.bindings.comparison.thinking = "max";
  assert.throws(() => resolve("comparison"), /not supported/);
});

test("every configured model is checked against its channel declaration before dispatch", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "model-catalog-preflight-"));
  try {
    const file = path.join(directory, "models.json");
    const settings = parseSettings(`[channel.evaluation-gateway]
base_url = https://first.example/v1
api_key = first
models = deepseek-v4.1-flash
[channel.evaluation-gateway-2]
base_url = https://second.example/v1
api_key = second
models = deepseek-v4.1-flash
`);
    await writeFile(file, JSON.stringify({ models: { judge: { channel: "evaluation-gateway-2", model: "deepseek" } } }));
    await assert.rejects(loadConfig([path.join(ROOT, "configs/host.json"), file], settings), error =>
      error instanceof Error &&
      /channel "evaluation-gateway-2"/.test(error.message) &&
      /Model "deepseek"/.test(error.message) &&
      /available models: deepseek-v4\.1-flash/.test(error.message));
    await writeFile(file, JSON.stringify({ models: { judge: { channel: "evaluation-gateway-2", model: "deepseek-v4.1-flash" } } }));
    const host = await loadConfig([path.join(ROOT, "configs/host.json"), file], settings);
    assert.equal(createModelResolver(host.models)("comparison").provider, "evaluation-gateway-2");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("settings come only from the selected INI file; missing files and missing channels fail explicitly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ini-settings-"));
  try {
    const file = path.join(directory, "config.ini");
    await assert.rejects(readSettings(file), /Missing config.ini/);
    await writeFile(file, ini);
    assert.equal((await readSettings(file)).channels.openai.name, "OpenAI");
    await writeFile(file, "[environment]\nSEARCH_API_KEY=fixture\n");
    await assert.rejects(readSettings(file), /at least one/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
