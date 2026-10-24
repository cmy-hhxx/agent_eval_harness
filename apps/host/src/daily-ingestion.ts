import { HttpError } from "@eval/contracts";
import { setTimeout as delay } from "node:timers/promises";
import type { AutomationConfig } from "./automation-config.js";

export interface CatalogTask { id: string; source: string; dataset: string; archive_dir: string }
export interface CatalogPage {
  tasks: CatalogTask[]; batches: Record<string, unknown>[]; total: number; page: number; page_size: number;
}
export async function dataRequest(config: Pick<AutomationConfig, "sourceUrl">, route: string, signal?: AbortSignal, action?: object) {
  const response = await fetch(new URL(route, new URL(config.sourceUrl).origin), {
    signal: signal ?? AbortSignal.timeout(30_000), ...(action && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) }),
  });
  const value = await response.json() as any;
  if (!response.ok) throw new HttpError(response.status, value.error ?? "数据服务请求失败");
  return value;
}
export async function sourceCatalog(config: Pick<AutomationConfig, "sourceUrl">, page = 1, pageSize = 50, signal?: AbortSignal): Promise<CatalogPage> {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    throw new HttpError(400, "批次分页参数无效");
  const initial = await dataRequest(config, "/data/workbench/catalog?page_size=1", signal) as CatalogPage;
  const task = initial.tasks.find(task => task.dataset === new URL(config.sourceUrl).pathname);
  if (!task) throw new HttpError(409, "日常收包任务尚未登记");
  return dataRequest(config, `/data/workbench/catalog?task=${encodeURIComponent(task.id)}&page=${page}&page_size=${pageSize}`, signal);
}
export async function startSourceCleaning(config: AutomationConfig, signal: AbortSignal) {
  if (!config.autoClean) return;
  const catalog = await sourceCatalog(config, 1, 50, signal);
  const task = catalog.tasks.find(task => task.dataset === new URL(config.sourceUrl).pathname)!;
  await dataRequest(config, `/data/workbench/tasks/${task.id}/clean`, signal, {});
}
export async function stopSourceCleaning(config: AutomationConfig, cancel: boolean, drain = false) {
  if (!config.autoClean) return;
  const catalog = await sourceCatalog(config);
  const task = catalog.tasks.find(task => task.dataset === new URL(config.sourceUrl).pathname)!;
  const route = `/data/workbench/tasks/${task.id}/clean`;
  let status = await dataRequest(config, route + `/${cancel ? "cancel" : "stop"}`, undefined, {});
  while (drain && ["queued", "running", "stopping", "cancelling"].includes(status.status)) {
    await delay(100);
    status = await dataRequest(config, route, AbortSignal.timeout(config.requestTimeoutMs));
  }
  return status;
}
