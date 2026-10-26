import { realpath } from "node:fs/promises";
import path from "node:path";
import { errorText, type ToolResult, type ValidationIssue } from "@eval/contracts";
import { readJson } from "@eval/data";

/** One attempt-local queue serializes inspection, final submission and draft loading. */
export function createContentQueue() {
  let queue = Promise.resolve();
  return (operation: () => Promise<ToolResult>): Promise<ToolResult> => {
    const pending = queue.then(operation);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
}

export async function loadSubmissionFile(
  args: unknown,
  workdir: string,
  validate: (value: unknown) => boolean,
): Promise<unknown> {
  if (!validate(args)) throw new Error("文件提交参数必须是 {path: 文件路径}");
  const root = await realpath(workdir);
  const file = await realpath(path.resolve(root, (args as { path: string }).path));
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("提交文件必须位于本任务工作目录内");
  return readJson(file);
}

export function invalidSubmissionFile(error: unknown): ValidationIssue[] {
  return [{
    category: "file",
    code: "submission_file_invalid",
    path: "/path",
    actual: errorText(error),
    message: errorText(error),
  }];
}
