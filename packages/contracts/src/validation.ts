import type { JsonObject, ValidationIssue } from "./index.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v ?? null)).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as JsonObject;
}

export function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}$/.test(value) || value.includes(".."))
    throw new HttpError(400, "Invalid identifier");
  return value;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redact(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
  return text;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(
    status: number,
    message: string,
    readonly issues?: ValidationIssue[],
  ) {
    super(message);
    this.status = status;
  }
}

export class ValidationError extends HttpError {
  constructor(issues: ValidationIssue[]) {
    super(422, issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"), issues);
  }
}

export function schemaIssues(
  errors:
    | {
        keyword: string;
        instancePath: string;
        message?: string;
        params: unknown;
      }[]
    | null
    | undefined,
  value?: unknown,
): ValidationIssue[] {
  return (errors || []).map((error) => {
    const field =
      (
        error.params as {
          missingProperty?: string;
          additionalProperty?: string;
        }
      ).missingProperty || (error.params as { additionalProperty?: string }).additionalProperty;
    const location =
      error.instancePath + (field ? "/" + field.replaceAll("~", "~0").replaceAll("/", "~1") : "");
    const actual = location
      .split("/")
      .slice(1)
      .reduce<unknown>(
        (node, key) =>
          node && typeof node === "object"
            ? (node as Record<string, unknown>)[key.replaceAll("~1", "/").replaceAll("~0", "~")]
            : undefined,
        value,
      );
    return {
      category: "structure",
      code: "schema_" + error.keyword,
      path: location || "/",
      expected: error.params,
      actual: actual ?? null,
      message:
        "输出结构无效：" +
        (error.message || error.keyword) +
        (error.keyword === "required" ? "；依赖此字段的语义检查暂不可执行" : ""),
    };
  });
}
