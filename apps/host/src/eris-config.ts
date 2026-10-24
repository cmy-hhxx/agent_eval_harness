import path from "node:path";
import { readJson } from "@eval/data";
import { object } from "@eval/contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import schema from "../../../schemas/eris/server.schema.json" with { type: "json" };

const validate = new Ajv2020({ allErrors: true }).compile(schema);

export async function readErisConfig(file: string) {
  const source = object(await readJson(file));
  if (!validate(source)) throw new Error("Eris 配置无效：" + JSON.stringify(validate.errors));
  const location = (key: string) => {
    if (typeof source[key] !== "string" || !source[key].trim()) throw new Error(`缺少 Eris 配置 ${key}`);
    return path.resolve(path.dirname(file), source[key]);
  };
  const publicOrigin = new URL(String(source.publicOrigin));
  if (!["http:", "https:"].includes(publicOrigin.protocol) || publicOrigin.origin !== source.publicOrigin || publicOrigin.username || publicOrigin.password) throw new Error("publicOrigin 须为完整外部来源，不含路径");
  const listen = object(source.listen);
  return { runtimeRoot: location("runtimeRoot"), dataRoot: location("dataRoot"), evalConfigFile: location("evalConfigFile"), publicOrigin: publicOrigin.origin, listen: { host: listen.host as string, port: listen.port as number } };
}
