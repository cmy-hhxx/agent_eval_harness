import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

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
      return { id: `${pid}:${fields[19]}`, rss: memory.VmRSS * 1024,
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
  return { rss: processes.reduce((total, row) => total + row.rss, 0), processes: processes.length,
    counters: processes.map(({ id, counters }) => ({ id, ...counters })), failures };
}
