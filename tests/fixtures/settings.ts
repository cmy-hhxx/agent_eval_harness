import path from "node:path";
import { writeFile } from "node:fs/promises";
import { parseSettings } from "@eval/host-app/config";

export function settingsText(baseUrl = "http://127.0.0.1:1/v1", apiKey = "fixture") {
  return `[channel.evaluation-gateway]\nname = 评测网关\nbase_url = ${JSON.stringify(baseUrl)}\napi_key = ${JSON.stringify(apiKey)}\n`;
}
export function testSettings(baseUrl?: string) { return parseSettings(settingsText(baseUrl)); }
export async function writeTestSettings(directory: string, baseUrl?: string, apiKey?: string) {
  const file = path.join(directory, "config.ini");
  await writeFile(file, settingsText(baseUrl, apiKey));
  return file;
}
