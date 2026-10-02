import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { fileURLToPath } from "node:url";

// Malformed requests must not crash the server, so the regression runs in its own process.
test("HTTP dispatch reports malformed URLs and sync/async errors without killing the server", { timeout: 10000 }, async (t) => {
  const child = fork(fileURLToPath(new URL("../../../tests/fixtures/http-child.js", import.meta.url)), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  const [message] = await once(child, "message");
  const url = new URL((message as { url: string }).url);
  async function read(path: string) {
    return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      get({ hostname: url.hostname, port: url.port, path }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode!, data: JSON.parse(body) }); }
          catch (error) { reject(error); }
        });
      }).on("error", (error) => reject(new Error(`${error.message}\n${stderr}`)));
    });
  }
  assert.deepEqual(await read("//["), { status: 400, data: { error: "Invalid request URL" } });
  assert.deepEqual(await read("/sync-error"), { status: 409, data: { error: "Synchronous handler failure" } });
  assert.deepEqual(await read("/async-error"), { status: 422, data: { error: "Asynchronous handler failure" } });
  assert.deepEqual(await read("/healthy"), { status: 200, data: { path: "/healthy" } });
});
