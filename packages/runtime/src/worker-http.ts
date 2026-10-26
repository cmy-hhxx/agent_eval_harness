import type { ServerResponse } from "node:http";
import {
  canonical,
  HttpError,
  safeId,
  submissionToolNames,
  type AttemptRecord,
  type AttemptSpec,
  type AttemptStatus,
  type EngineIdentity,
} from "@eval/contracts";
import type { ToolRegistry } from "@eval/tools";
import { body, json, listen } from "./http.js";

export interface WorkerHttpController {
  readonly identity: EngineIdentity;
  readonly tools: string[];
  activeAttempt(): string | null;
  start(spec: AttemptSpec): Promise<AttemptStatus>;
  status(attemptId: string): Promise<AttemptStatus>;
  cancel(attemptId: string): Promise<void>;
  release(attemptId: string): Promise<{ released: true }>;
  events(attemptId: string, res: ServerResponse, after: number): Promise<void>;
  record(attemptId: string): Promise<AttemptRecord>;
  artifact(attemptId: string, artifactId: string): Promise<Uint8Array>;
}

/** HTTP is an adapter over attempt lifecycle operations; wire validation stays here. */
export function serveWorkerHttp(controller: WorkerHttpController, registry: ToolRegistry, port: number) {
  return listen(async (req, res, url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/api/health")
      return json(res, {
        identity: controller.identity,
        tools: controller.tools,
        activeAttempt: controller.activeAttempt(),
      });
    if (req.method === "POST" && url.pathname === "/api/attempts") {
      const spec = (await body(req)) as AttemptSpec;
      validateAttemptSpec(spec, controller.identity, registry);
      return json(res, await controller.start(spec), 202);
    }
    if (parts[0] === "api" && parts[1] === "attempts" && parts[2]) {
      const id = safeId(parts[2]);
      if (req.method === "DELETE" && parts.length === 3)
        return json(res, await controller.release(id));
      if (req.method === "GET" && parts.length === 3)
        return json(res, await controller.status(id));
      if (req.method === "POST" && parts[3] === "cancel") {
        await controller.cancel(id);
        return json(res, { cancelled: true });
      }
      if (req.method === "GET" && parts[3] === "events") {
        const after = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
        if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "Invalid event cursor");
        await controller.events(id, res, after);
        return;
      }
      if (req.method === "GET" && parts[3] === "artifacts" && parts[4]) {
        const bytes = await controller.artifact(id, parts[4]);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(bytes);
        return;
      }
      if (req.method === "GET" && parts[3] === "record")
        return json(res, await controller.record(id));
    }
    throw new HttpError(404, "Not found");
  }, port);
}

function validateAttemptSpec(spec: AttemptSpec, identity: EngineIdentity, registry: ToolRegistry): void {
  if (!Number.isInteger(spec.inputRevision) || spec.inputRevision < 1)
    throw new HttpError(400, "Invalid input revision");
  safeId(spec.runId);
  safeId(spec.taskId);
  safeId(spec.attemptId);
  if (canonical(spec.engine) !== canonical(identity))
    throw new HttpError(409, "Worker engine build mismatch");
  if (!spec.evaluation || !Array.isArray(spec.evaluation.toolNames) || !spec.evaluation.outputSchema ||
    typeof spec.evaluation.fileSubmission !== "boolean" ||
    typeof spec.evaluation.submissionNudge !== "string" || !spec.evaluation.submissionNudge.trim())
    throw new HttpError(400, "Invalid evaluation spec");
  if (spec.evaluation.materialNavigation !== undefined && (!spec.evaluation.materialNavigation ||
    typeof spec.evaluation.materialNavigation !== "object" || Array.isArray(spec.evaluation.materialNavigation)))
    throw new HttpError(400, "Invalid material navigation");
  if (!Array.isArray(spec.inputs) || spec.inputs.some(ref => !ref || typeof ref.id !== "string" || typeof ref.name !== "string") ||
    new Set(spec.inputs.map(ref => ref.name)).size !== spec.inputs.length)
    throw new HttpError(400, "Invalid input refs");
  registry.select(spec.evaluation.toolNames);
  if (spec.evaluation.requiredReads !== undefined && (!Array.isArray(spec.evaluation.requiredReads) ||
    spec.evaluation.requiredReads.some(read => !read || !["text", "json"].includes(read.kind) || typeof read.path !== "string" || read.kind === "json" && read.path !== "" ||
      !spec.inputs.some(input => input.name === read.candidate) ||
      !Number.isSafeInteger(read.message_index) || read.message_index < 0 ||
      !Number.isSafeInteger(read.start) || !Number.isSafeInteger(read.end) || read.start < 0 || read.end <= read.start) ||
    (spec.evaluation.requiredReads.length > 0 && !spec.evaluation.toolNames.includes("read_trace"))))
    throw new HttpError(400, "Invalid required material ranges");
  const names = [...spec.evaluation.toolNames, ...submissionToolNames(spec.evaluation.fileSubmission)];
  const descriptions = spec.evaluation.toolDescriptions;
  if (!descriptions || typeof descriptions !== "object" || Array.isArray(descriptions) ||
    new Set(names).size !== names.length || Object.keys(descriptions).length !== names.length ||
    names.some(name => typeof descriptions[name] !== "string" || !descriptions[name].trim()))
    throw new HttpError(400, "Invalid evaluation tool descriptions");
  if (!Number.isFinite(spec.deadline) || spec.deadline <= Date.now())
    throw new HttpError(409, "Attempt already expired");
  if (spec.controlModelRequests !== undefined && typeof spec.controlModelRequests !== "boolean")
    throw new HttpError(400, "Invalid model request control");
  for (const key of [
    "timeoutSeconds",
    "idleTimeoutSeconds",
    "maxToolCalls",
    "codeTimeoutSeconds",
    "maxOutputChars",
  ] as const)
    if (!Number.isInteger(spec.policy?.[key]) || spec.policy[key] <= 0)
      throw new HttpError(400, "Invalid policy");
  if (!Number.isInteger(spec.policy.repairAttempts) || spec.policy.repairAttempts < 0)
    throw new HttpError(400, "Invalid repair budget");
  if (spec.policy.maxTokens !== undefined && (!Number.isInteger(spec.policy.maxTokens) || spec.policy.maxTokens < 1))
    throw new HttpError(400, "Invalid token budget");
  spec.inputs.forEach(ref => {
    safeId(ref.id);
    safeId(ref.name);
  });
  if (!/^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(spec.hostUrl))
    throw new HttpError(400, "Worker requires a loopback host URL");
  if (!spec.model || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(spec.model.apiKeyEnv))
    throw new HttpError(400, "Invalid model credential reference");
}
