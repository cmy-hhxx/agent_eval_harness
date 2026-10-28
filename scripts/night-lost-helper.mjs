import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

const helperFile = fileURLToPath(new URL("../data_service/lost_user_pipeline.py", import.meta.url));
const pending = new Map();
let worker, sequence = 0;

// Linux process creation can block for seconds in a large Host. Keep it off its HTTP event loop.
export function lostHelper(python, request) {
  if (!worker) {
    const current = worker = new Worker(new URL(import.meta.url));
    const fail = error => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      current.unref();
    };
    current.unref();
    current.on("message", ({ id, value, error, code }) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (!pending.size) current.unref();
      if (error) request.reject(Object.assign(error, code ? { code } : {}));
      else request.resolve(value);
    });
    current.on("error", fail);
    current.on("exit", code => {
      if (worker === current) worker = undefined;
      fail(new Error(`Lost-user adapter thread exited (${code})`));
    });
  }
  const id = ++sequence;
  worker.ref();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try { worker.postMessage({ id, python, request }); }
    catch (error) {
      pending.delete(id);
      if (!pending.size) worker.unref();
      reject(error);
    }
  });
}

if (!isMainThread) parentPort.on("message", async ({ id, python, request }) => {
  try {
    const value = await new Promise((resolve, reject) => {
      const child = spawn(python, [helperFile], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "", error = "";
      child.stdout.setEncoding("utf8").on("data", value => { output += value; });
      child.stderr.setEncoding("utf8").on("data", value => { error = (error + value).slice(-8000); });
      child.on("error", reject);
      child.stdin.on("error", reject);
      child.on("close", code => {
        if (code !== 0) reject(new Error(`Lost-user adapter (${code}): ${error}`));
        else { try { resolve(JSON.parse(output)); } catch (failure) { reject(failure); } }
      });
      child.stdin.end(JSON.stringify(request));
    });
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error, code: error.code }); }
});
