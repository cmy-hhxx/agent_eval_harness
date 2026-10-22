import path from "node:path";

/** Tests stay within the same source's eval_output/test_eval, even for nested task roots. */
export function testEvaluationOutput(configuredOutput: string, requested?: string): string {
  let root = path.resolve(configuredOutput);
  while (path.basename(root) !== "eval_output") {
    const parent = path.dirname(root);
    if (parent === root) throw new Error("Evaluation output must be under the source's eval_output directory");
    root = parent;
  }
  const testRoot = path.join(root, "test_eval"), target = path.resolve(requested ?? testRoot);
  const relative = path.relative(testRoot, target);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Test evaluation output must be under " + testRoot);
  return target;
}
