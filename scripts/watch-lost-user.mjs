#!/usr/bin/env node
/**
 * Keep the lost-user eval input current, end to end.
 *
 * The inbox receives one `.7z` every few minutes. For every package that has
 * stopped changing this watcher:
 *
 *   1. runs `extract-lost-user.mjs` so the package lands in the eval input tree,
 *   2. moves the processed package into `<inbox>/3_processed_archives/<YYYYMMDD>/`.
 *
 * It does not slim the input and never touches an archive that is still being
 * uploaded. The extractor keys its manifest by package name, and this watcher
 * keeps that name when moving the file, so the archived package is still found
 * on the next pass and never published twice.
 *
 * Failures are reported and retried on the next pass: a package is only archived
 * after the extraction that includes it has committed. Nothing is deleted.
 *
 * Usage:
 *   node scripts/watch-lost-user.mjs [options]
 *
 *   --source <dir>       inbox (default /mnt/fin_bench/eval_data/1_aime/1_7z_data/lost_user)
 *   --target <dir>       eval input root (default /mnt/fin_bench/eval_data/1_aime/5_lost_user_eval_input)
 *   --archive-dir <dir>  processed archive root (default <source>/3_processed_archives)
 *   --seven-zip <path>   archive reader (default `7z`)
 *   --interval <s>       seconds between scans (default 30)
 *   --stable <s>         a package must be unchanged this long before reading (default 30)
 *   --once               run one pass and exit
 *   --quiet              only report work, not idle scans
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { archiveDay } from "./archive-processed-packages.mjs";
import { extract, readState } from "./extract-lost-user.mjs";

const DEFAULT_SOURCE = "/mnt/fin_bench/eval_data/1_aime/1_7z_data/lost_user";
const DEFAULT_TARGET = "/mnt/fin_bench/eval_data/1_aime/5_lost_user_eval_input";

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Top-level `.7z` packages that are still waiting to be processed. */
export async function inboxPackages(source) {
  const packages = new Map();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.7z$/i.test(entry.name)) continue;
    const info = await stat(path.join(source, entry.name));
    packages.set(entry.name, { size: info.size, mtimeMs: info.mtimeMs });
  }
  return packages;
}

/**
 * Day folder for a package. Data-service names end in `_YYYYMMDD_HHMMSS`; a
 * lost-user name ends in `_YYYYMMDD_<sequence>`. Falls back to today.
 */
export function packageDay(name, now = new Date()) {
  const exact = archiveDay(name);
  if (exact) return exact;
  const matched = /_(\d{8})_/.exec(name);
  if (matched) {
    const digits = matched[1];
    const value = new Date(Date.UTC(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)) - 1, Number(digits.slice(6))));
    if (!Number.isNaN(value.getTime()) && value.toISOString().slice(0, 10).replaceAll("-", "") === digits) return digits;
  }
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * Move packages that the extraction manifest already knows about.
 * A name collision leaves the package in place: the archived copy is the source
 * of truth and is never overwritten.
 */
export async function archiveProcessed({ source, archiveDir, names, state, now = new Date() }) {
  const moved = [], kept = [];
  for (const name of names) {
    if (!Object.hasOwn(state?.archives ?? {}, name)) continue;
    const folder = path.join(archiveDir, packageDay(name, now));
    const destination = path.join(folder, name);
    if (existsSync(destination)) {
      kept.push({ name, reason: "archived_copy_exists" });
      continue;
    }
    await mkdir(folder, { recursive: true });
    await rename(path.join(source, name), destination);
    moved.push(path.relative(archiveDir, destination));
  }
  return { moved, kept };
}

const stamp = () => new Date().toISOString().slice(11, 19);

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string", default: DEFAULT_SOURCE },
    target: { type: "string", default: DEFAULT_TARGET },
    "archive-dir": { type: "string" },
    "seven-zip": { type: "string", default: "7z" },
    interval: { type: "string", default: "30" },
    stable: { type: "string", default: "30" },
    once: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  } });

  const source = path.resolve(values.source);
  const target = path.resolve(values.target);
  const archiveDir = path.resolve(values["archive-dir"] ?? path.join(source, "3_processed_archives"));
  const interval = Math.max(5, Number(values.interval));
  const stableMs = Math.max(0, Number(values.stable)) * 1000;
  const log = (message) => console.log(`[${stamp()}] ${message}`);
  const note = values.quiet ? () => {} : log;

  const seen = new Map();
  for (;;) {
    const inbox = await inboxPackages(source).catch(() => new Map());
    const now = Date.now();
    for (const [name, info] of inbox) {
      const previous = seen.get(name);
      if (!previous || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
        seen.set(name, { ...info, since: now });
      }
    }
    for (const name of [...seen.keys()]) if (!inbox.has(name)) seen.delete(name);

    const waiting = [...inbox.keys()].filter((name) => now - seen.get(name).since < stableMs);
    if (waiting.length) {
      note(`等待 ${waiting.length} 个包上传稳定：${waiting.join(", ")}`);
      if (values.once) return;
      await sleep(interval);
      continue;
    }

    if (inbox.size) {
      try {
        const summary = await extract({ source, target, sevenZip: values["seven-zip"], quiet: true, log: note });
        const state = await readState(target);
        const total = Object.values(state?.files ?? {}).reduce((sum, file) => sum + file.rows, 0);
        if (summary.accepted) log(`解压完成：新增 ${summary.accepted} 条，累计 ${total} 条`);
        else if (summary.unchanged) log(`输入已是最新：累计 ${total} 条`);
        const { moved, kept } = await archiveProcessed({ source, archiveDir, names: [...inbox.keys()], state });
        if (moved.length) log(`归档 ${moved.length} 个包：${moved.join(", ")}`);
        for (const entry of kept) log(`保留 ${entry.name}：${entry.reason}`);
      } catch (error) {
        log(`处理失败，保留收包等待重试：${error.message}`);
      }
    } else {
      note("收包目录为空");
    }

    if (values.once) return;
    await sleep(interval);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
