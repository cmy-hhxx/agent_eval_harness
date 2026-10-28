/// <reference path="./node-http.d.ts" />
import path from "node:path";
import { setGlobalProxyFromEnv } from "node:http";
import { localFiles } from "@eval/data";
import type { ModelConfig } from "@eval/contracts";
import { THINKING_LEVELS, type ModelProfile } from "./models.js";
import { ROOT } from "./paths.js";

export interface Channel extends ModelProfile {
  name: string;
  models?: string[];
  efforts?: ModelConfig["thinking"][];
}
export interface ApplicationSettings {
  channels: Record<string, Channel>;
  agent: { channel?: string; model?: string; thinking?: ModelConfig["thinking"]; contextWindow?: number; maxOutputTokens?: number };
  environment: Record<string, string>;
}

/** Deliberately small INI dialect: sections, key=value, whole-line comments and quoted strings. */
export function parseSettings(text: string): ApplicationSettings {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([a-zA-Z0-9_.-]+)\]$/.exec(line);
    const fail = () => { throw new Error(`Invalid config.ini at line ${index + 1}`); };
    if (header) {
      if (sections.has(header[1])) fail();
      section = new Map(); sections.set(header[1], section); continue;
    }
    const entry = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!section || !entry || section.has(entry[1])) { fail(); continue; }
    let value = entry[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { fail(); }
      if (typeof value !== "string") fail();
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) fail();
      value = value.slice(1, -1);
    }
    section.set(entry[1], value);
  }
  const channels: Record<string, Channel> = Object.create(null);
  const environment: Record<string, string> = Object.create(null);
  let agent: ApplicationSettings["agent"] = {};
  for (const [name, values] of sections) {
    const error = (key: string): never => { throw new Error(`Invalid config.ini [${name}].${key}`); };
    const optional = (key: string) => values.get(key)?.trim() || undefined;
    const positive = (key: string) => {
      const value = optional(key); if (value === undefined) return undefined;
      const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) error(key);
      return number;
    };
    const list = (key: string) => {
      const value = optional(key); if (!value) return undefined;
      const items = value.split(",").map(item => item.trim());
      if (items.some(item => !item) || new Set(items).size !== items.length) error(key);
      return items;
    };
    if (name === "environment") {
      for (const [key, value] of values) {
        if (key.startsWith("EVAL_CHANNEL_KEY_") || key === "EVAL_CONFIG_FILE") error(key);
        environment[key] = value;
      }
      continue;
    }
    const thinking = optional("thinking") as ModelConfig["thinking"] | undefined;
    if (thinking && !THINKING_LEVELS.includes(thinking)) error("thinking");
    const parameters = { thinking, contextWindow: positive("context_window"), maxOutputTokens: positive("max_output_tokens") };
    if (name === "agent") {
      for (const key of values.keys()) if (!["channel", "model", "thinking", "context_window", "max_output_tokens"].includes(key)) error(key);
      agent = { channel: optional("channel"), model: optional("model"), ...parameters };
      continue;
    }
    if (!/^channel\.[a-z][a-z0-9_-]*$/.test(name)) error("section");
    for (const key of values.keys()) if (!["name", "base_url", "api_key", "api", "model", "thinking", "context_window", "max_output_tokens", "supports_developer_role", "supports_explicit_prompt_caching", "traffic_weight", "models", "efforts"].includes(key)) error(key);
    const id = name.slice("channel.".length), baseUrl = optional("base_url");
    if (!baseUrl) error("base_url");
    try {
      const url = new URL(baseUrl!);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) error("base_url");
    } catch { error("base_url"); }
    const api = optional("api") ?? "openai-responses";
    if (api !== "openai-responses" && api !== "openai-completions") error("api");
    const capability = optional("supports_developer_role");
    if (capability !== undefined && !["true", "false"].includes(capability)) error("supports_developer_role");
    const caching = optional("supports_explicit_prompt_caching");
    if (caching !== undefined && !["true", "false"].includes(caching)) error("supports_explicit_prompt_caching");
    const efforts = list("efforts") as ModelConfig["thinking"][] | undefined;
    if (efforts?.some(effort => !THINKING_LEVELS.includes(effort)) || (thinking && efforts && !efforts.includes(thinking))) error("efforts");
    const apiKeyEnv = `EVAL_CHANNEL_KEY_${id.replaceAll("_", "_U").replaceAll("-", "_H")}`;
    environment[apiKeyEnv] = values.get("api_key") ?? "";
    channels[id] = { provider: id, name: optional("name") ?? id, baseUrl: baseUrl!, api: api as ModelConfig["api"], apiKeyEnv,
      model: optional("model"), ...parameters, ...(capability === undefined ? {} : { supportsDeveloperRole: capability === "true" }),
      ...(caching === undefined ? {} : { supportsExplicitPromptCaching: caching === "true" }),
      models: list("models"), efforts, trafficWeight: positive("traffic_weight") ?? 1 };
  }
  if (!Object.keys(channels).length) throw new Error("config.ini requires at least one [channel.<id>]");
  if (agent.channel && !channels[agent.channel]) throw new Error("Unknown config.ini [agent].channel");
  return { channels, agent, environment };
}

export async function readSettings(file = process.env.EVAL_CONFIG_FILE || path.join(ROOT, "config.ini")): Promise<ApplicationSettings> {
  let text: string;
  try { text = (await localFiles.read(file)).toString("utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Missing config.ini; copy config.example.ini and configure channels");
    throw error;
  }
  return parseSettings(text);
}

/** Credentials stay in the server process and are inherited by its Workers, never serialized with models. */
export function applySettings(settings: ApplicationSettings): void {
  Object.assign(process.env, settings.environment);
  configureProxy();
}

let proxySettings: string | undefined;
let restoreProxy: (() => void) | undefined;
function configureProxy(): void {
  // Host/Worker control traffic is always local, independent of the entry point.
  const bypass = [...new Set([process.env.no_proxy, process.env.NO_PROXY, "localhost", "127.0.0.1", "::1"]
    .flatMap(value => value?.split(",").map(item => item.trim()).filter(Boolean) ?? []))].join(",");
  process.env.no_proxy = bypass;
  process.env.NO_PROXY = bypass;
  const current = JSON.stringify([process.env.http_proxy || process.env.HTTP_PROXY,
    process.env.https_proxy || process.env.HTTPS_PROXY, process.env.no_proxy || process.env.NO_PROXY]);
  if (current === proxySettings) return;
  restoreProxy?.();
  try { restoreProxy = setGlobalProxyFromEnv(); }
  catch { throw new Error("Invalid config.ini [environment] proxy settings"); }
  proxySettings = current;
}
// Managed Workers inherit these settings; standalone entry points load the INI themselves.
configureProxy();

export function configurationSecrets(): string[] {
  return Object.entries(process.env).filter(([name]) => name.startsWith("EVAL_CHANNEL_KEY_") || /(?:API_KEY|SECRET|TOKEN|MONGODB_URI)$/.test(name))
    .flatMap(([, value]) => value ? [value] : []);
}
