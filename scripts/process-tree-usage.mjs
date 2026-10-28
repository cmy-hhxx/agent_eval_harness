import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parentPort, workerData } from "node:worker_threads";

const execute = promisify(execFile);

/** Some Linux containers expose process stats but omit task/PID/children. */
export function processTreePids(root, listing) {
  const children = new Map();
  for (const line of listing.trim().split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/u).map(Number);
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const pids = [root];
  for (let i = 0; i < pids.length; i++) pids.push(...children.get(pids[i]) ?? []);
  return pids;
}

export async function sampleProcessTree(root) {
  const { stdout } = await execute("ps", ["-eo", "pid=,ppid="], { maxBuffer: 4 * 1024 * 1024 });
  const numbers = text => Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)/gmu)].map(match => [match[1], Number(match[2])]));
  let failures = 0;
  const rows = await Promise.all(processTreePids(root, stdout).map(async pid => {
    try {
      const [status, io, stat] = await Promise.all(["status", "io", "stat"].map(file => readFile(`/proc/${pid}/${file}`, "utf8")));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "), memory = numbers(status), counters = numbers(io);
      if (!Number.isFinite(memory.VmRSS)) return null; // A process that exited between ps and /proc can be a zombie.
      return { id: `${pid}:${fields[19]}`, pid, rss: memory.VmRSS * 1024,
        anonymous_bytes: memory.RssAnon === undefined ? null : memory.RssAnon * 1024,
        file_bytes: memory.RssFile === undefined ? null : memory.RssFile * 1024,
        counters: { cpu_ticks: Number(fields[11]) + Number(fields[12]), read_bytes: counters.read_bytes,
          write_bytes: counters.write_bytes, rchar: counters.rchar, wchar: counters.wchar } };
    } catch (error) {
      if (pid === root) throw error;
      if (!["ENOENT", "ESRCH"].includes(error.code)) failures++;
      return null;
    }
  }));
  const processes = rows.filter(Boolean);
  if (!processes.some(row => row.id.startsWith(root + ":"))) throw new Error("Root process has no readable memory sample");
  const host = processes.find(row => row.pid === root), workers = processes.filter(row => row.pid !== root);
  const sum = key => workers.some(row => row[key] === null) ? null : workers.reduce((total, row) => total + row[key], 0);
  const system = numbers(await readFile("/proc/meminfo", "utf8"));
  return { rss: processes.reduce((total, row) => total + row.rss, 0), processes: processes.length,
    host: { rss_bytes: host.rss, anonymous_bytes: host.anonymous_bytes, file_bytes: host.file_bytes },
    workers: { count: workers.length, rss_bytes: sum("rss"), anonymous_bytes: sum("anonymous_bytes"), file_bytes: sum("file_bytes") },
    system: { cached_bytes: system.Cached * 1024, buffers_bytes: system.Buffers * 1024, scope: "machine-wide, not attributable to this run" },
    counters: processes.map(({ id, counters }) => ({ id, ...counters })), failures };
}

// ps has a synchronous spawn phase even through execFile. Keep it off the
// measured Host event loop; one small sampling thread lives for the whole trial.
if (parentPort && workerData?.processTreeRoot) {
  let timer, pending, stopped = false;
  const sample = () => {
    pending = sampleProcessTree(workerData.processTreeRoot)
      .then(value => parentPort.postMessage({ sample: value }), error => parentPort.postMessage({ error: String(error) }))
      .finally(() => {
        pending = undefined;
        if (stopped) parentPort.close();
        else timer = setTimeout(sample, 1000);
      });
  };
  parentPort.once("message", () => {
    stopped = true; clearTimeout(timer);
    if (!pending) parentPort.close();
  });
  sample();
}
