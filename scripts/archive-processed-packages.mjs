#!/usr/bin/env node
/**
 * Move already-processed upload packages out of the inbox into per-day folders.
 *
 * The data service publishes one `.7z` upload into `2_daily_eval_input/<model>/<date>.jsonl`
 * and only then records its receipt (name, size, mtime) in `<state>/root-archives.json`.
 * The package itself is never removed from the inbox, so that directory grows without bound.
 * This script reads those receipts and moves every package whose receipt still matches the
 * file on disk into `3_processed_archives/<YYYYMMDD>/`, the day taken from the package name
 * (`ainvest_20261020_160040.7z` -> `20261020`).
 *
 * A receipt is only trusted while it matches: a package that failed to ingest, is still being
 * uploaded, or was replaced in place keeps its old receipt and is left alone. `rename` keeps
 * the modification time, so receipts stay valid after the move and re-running is a no-op.
 *
 * The module is deliberately standalone: it imports nothing from this project and prints
 * nothing but the plan. Without `--apply` it does not touch the disk.
 *
 * Usage:
 *   node scripts/archive-processed-packages.mjs [options]
 *
 *   --data-root <dir>   data root (default /mnt/fin_bench/eval_data)
 *   --state-root <dir>  data-service state root (default runtime/state/data-service)
 *   --source <key>      only this source: wencai | aime (repeatable, default both)
 *   --apply             move for real; without it only the plan is printed
 */

import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

/** Folder under the inbox that receives the archived packages. */
const ARCHIVED_DIRECTORY = "3_processed_archives";
const DEFAULT_DATA_ROOT = "/mnt/fin_bench/eval_data";
const DEFAULT_STATE_ROOT = "/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime/state/data-service";

/** Inbox, receipt directory and display name of every supported source. */
export const SOURCES = [
  { key: "wencai", label: "问财", archive: "0_wencai/1_7z_data/A_AA_comparision_data", state: "wencai" },
  { key: "aime", label: "AIME", archive: "1_aime/1_7z_data/online_data", state: "aime" },
];

/**
 * Day folder for a package name, or null when the name carries no usable date.
 * `804771ad29444e29_20261026_111422.7z` -> `20261026`.
 */
export function archiveDay(name) {
  const matched = /_(\d{8})_\d{6}\.7z$/i.exec(name);
  if (!matched) return null;
  const digits = matched[1];
  const year = Number(digits.slice(0, 4)), month = Number(digits.slice(4, 6)), day = Number(digits.slice(6));
  const value = new Date(Date.UTC(year, month - 1, day));
  const valid = value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day;
  return valid ? digits : null;
}

/** Receipt name -> entry. A missing receipt is an error: never archive without one. */
async function loadReceipts(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`缺少处理回执 ${file}`);
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || !Array.isArray(value.archives)) throw new Error(`处理回执结构不正确 ${file}`);
  return new Map(value.archives.map((entry) => [entry.name, entry]));
}

/**
 * A package is processed only while the receipt still describes it.
 * `mtime_ns` is written as a JSON integer beyond 2^53, so both sides are compared as doubles
 * of the same integer instead of as strings.
 */
function isProcessed(receipt, file) {
  return !!receipt && receipt.size === Number(file.size) && receipt.mtime_ns === Number(file.mtimeNs);
}

const exists = (file) => stat(file).then(() => true, () => false);

/** Plan (and with `apply`, perform) the move for one source. Throws when the source is unreadable. */
export async function organizeSource(source, { dataRoot, stateRoot, apply = false }) {
  const archiveDirectory = path.join(dataRoot, source.archive);
  const archivedDirectory = path.join(archiveDirectory, ARCHIVED_DIRECTORY);
  const receiptFile = path.join(stateRoot, source.state, "root-archives.json");
  const receipts = await loadReceipts(receiptFile);
  const entries = await readdir(archiveDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`收包目录不存在 ${archiveDirectory}`);
    throw error;
  });
  const report = { ...source, archiveDirectory, archivedDirectory, receiptFile, scanned: 0, processed: 0,
    moved: [], existing: [], undated: [], unprocessed: [], days: new Map() };
  const packages = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".7z"))
    .map((entry) => entry.name)
    .sort();
  report.scanned = packages.length;
  for (const name of packages) {
    const file = path.join(archiveDirectory, name);
    if (!isProcessed(receipts.get(name), await stat(file, { bigint: true }))) {
      report.unprocessed.push(name);
      continue;
    }
    report.processed += 1;
    const day = archiveDay(name);
    if (!day) {
      report.undated.push(name);
      continue;
    }
    const target = path.join(archivedDirectory, day, name);
    if (await exists(target)) {
      report.existing.push(name);
      continue;
    }
    if (apply) {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(file, target);
    }
    report.moved.push(name);
    report.days.set(day, (report.days.get(day) ?? 0) + 1);
  }
  return report;
}

const listing = (names) => (names.length <= 12 ? names.join("、") : `${names.slice(0, 12).join("、")} 等 ${names.length} 个`);

function printReport(report, apply) {
  console.log(`${report.label}  ${report.archive}`);
  if (!report.scanned) {
    console.log("  收包 0 个 .7z，没有可归档的包");
    return;
  }
  console.log(`  收包 ${report.scanned} 个 .7z：已处理 ${report.processed} 个，${apply ? "移动" : "将移动"} ${report.moved.length} 个`);
  for (const [day, count] of [...report.days].sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${day}  ${count} 个`);
  }
  if (report.unprocessed.length) console.log(`  未处理，留在收包目录 ${report.unprocessed.length} 个：${listing(report.unprocessed)}`);
  if (report.undated.length) console.log(`  包名取不到日期，留在收包目录 ${report.undated.length} 个：${listing(report.undated)}`);
  if (report.existing.length) console.log(`  归档目录已有同名包 ${report.existing.length} 个：${listing(report.existing)}`);
}

function parseArguments(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "data-root": { type: "string" },
      "state-root": { type: "string" },
      source: { type: "string", multiple: true },
      apply: { type: "boolean" },
    },
    allowPositionals: false,
  });
  const source = values.source ?? [];
  for (const key of source) if (!SOURCES.some((item) => item.key === key)) throw new Error(`未知来源 ${key}`);
  return {
    dataRoot: path.resolve(values["data-root"] ?? DEFAULT_DATA_ROOT),
    stateRoot: path.resolve(values["state-root"] ?? DEFAULT_STATE_ROOT),
    source,
    apply: !!values.apply,
  };
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`${error.message}\n用法见 scripts/archive-processed-packages.mjs 顶部注释。`);
    return 2;
  }
  if (!options.apply) console.log("dry-run：只打印计划，不改动磁盘。");
  let failed = 0, moved = 0;
  for (const source of SOURCES.filter((item) => !options.source.length || options.source.includes(item.key))) {
    try {
      const report = await organizeSource(source, options);
      moved += report.moved.length;
      printReport(report, options.apply);
    } catch (error) {
      failed += 1;
      console.error(`${source.label}  失败：${error.message}`);
      console.error(`  --data-root ${options.dataRoot}  --state-root ${options.stateRoot}`);
    }
  }
  if (failed) console.log(`合计 ${failed} 个来源失败，未移动 ${moved} 个压缩包。`);
  else if (moved) console.log(`合计${options.apply ? "移动" : "将移动"} ${moved} 个压缩包到 ${ARCHIVED_DIRECTORY}/<日期>/。`);
  else console.log("合计没有需要归档的压缩包。");
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
