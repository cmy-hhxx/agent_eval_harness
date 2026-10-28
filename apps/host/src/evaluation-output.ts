import path from "node:path";
import type { OutputTarget } from "@eval/contracts";

/** Test runs stay within their explicitly configured root, regardless of directory names. */
export function testEvaluationOutput(output: Pick<OutputTarget, "testPath">, requested?: string): string {
  if (!output.testPath?.trim()) throw new Error("Test evaluations require output.testPath");
  const testRoot = path.resolve(output.testPath), target = path.resolve(requested ?? testRoot);
  const relative = path.relative(testRoot, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Test evaluation output must be under " + testRoot);
  return target;
}
