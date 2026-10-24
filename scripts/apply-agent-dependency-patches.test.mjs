import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyAgentDependencyPatches } from "./apply-agent-dependency-patches.mjs";

const execute = promisify(execFile);
const files = ["dist/editor.dev.js", "dist/editor.prod.mjs", "src/viewport.ts"];
const original = "const offsetTop = viewport.offsetTop;\n";
const patched = "const offsetTop = viewport.pageTop - window.scrollY;\n";

async function fixture(t, inCheckout = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-dependency-patch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (inCheckout) await execute("git", ["init", "-q"], { cwd: directory });
  const installed = path.join(directory, "node_modules/@fixture/editor"), vendor = path.join(directory, "vendor/deepseek");
  await mkdir(path.join(vendor, "patches"), { recursive: true });
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, "package.json"), JSON.stringify({ name: "@fixture/editor", version: "0.49.0" }));
  for (const file of files) {
    await mkdir(path.dirname(path.join(installed, file)), { recursive: true });
    await writeFile(path.join(installed, file), original);
  }
  const patch = files.map(file => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${original}+${patched}`).join("");
  await writeFile(path.join(vendor, "patches/editor.patch"), patch);
  await writeFile(path.join(vendor, "sources.json"), JSON.stringify({ dependencyPatches: [{ package: "@fixture/editor", version: "0.49.0", file: "patches/editor.patch" }] }));
  return { directory, installed, contents: () => Promise.all(files.map(file => readFile(path.join(installed, file), "utf8"))) };
}

for (const inCheckout of [false, true]) test(`dependency patches update every published face and remain idempotent (Git checkout: ${inCheckout})`, async t => {
  const f = await fixture(t, inCheckout);
  await applyAgentDependencyPatches(f.directory);
  assert.deepEqual(await f.contents(), files.map(() => patched));
  await applyAgentDependencyPatches(f.directory);
  assert.deepEqual(await f.contents(), files.map(() => patched));
});

test("dependency patches reject a different installed version before changing files", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.installed, "package.json"), JSON.stringify({ name: "@fixture/editor", version: "0.50.0" }));
  await assert.rejects(applyAgentDependencyPatches(f.directory), /requires @fixture\/editor@0\.49\.0; installed @fixture\/editor@0\.50\.0/);
  assert.deepEqual(await f.contents(), files.map(() => original));
});

test("dependency patches reject changed or partially patched packages without rewriting other files", async t => {
  for (const first of ["unrelated installed content\n", patched]) await t.test(first === patched ? "partial patch" : "changed package", async t => {
    const f = await fixture(t, true);
    await writeFile(path.join(f.installed, files[0]), first);
    await assert.rejects(applyAgentDependencyPatches(f.directory), /does not match @fixture\/editor@0\.49\.0/);
    assert.deepEqual(await f.contents(), [first, original, original]);
  });
});
