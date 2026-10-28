import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { exists, fileSourceReader, readJson, writeJsonl } from "@eval/data";
import { extract, readState } from "./extract-lost-user.mjs";
import { packageDay } from "./watch-lost-user.mjs";
import { scanInbox, signature } from "./auto-renew.mjs";
import { slimRecord, expandRecord } from "./aime-slim.mjs";

export async function lostHelper(python, request) {
  return (await import("./night-lost-helper.mjs")).lostHelper(python, request);
}

/** Strict incremental mode: never rebuild, rename a conflicting upload, or swallow bad state. */
export async function ingestLost(config, state, save, record, call, stopping = () => false) {
  const scan = await scanInbox(config.inbox, state.observed, config.stableSeconds * 1000);
  state.observed = scan.observed;
  await save();
  const selected = scan.packages.filter(item => !state.closed || state.closed.packages.includes(item.name));
  const errors = {};
  for (const item of selected) {
    if (stopping()) break;
    try {
    const file = path.join(config.inbox, item.name);
    if (await call({ operation: "writable", file }).then(value => value.writing)) continue;
    if (!isDeepStrictEqual(await signature(file), item.signature)) continue;
    const day = /_(\d{8})_/.exec(item.name)?.[1];
    if (!day || packageDay(item.name, new Date(NaN)) !== day) throw new Error("压缩包缺少有效业务日期：" + item.name);
    const target = path.join(config.inbox, "3_processed_archives", day, item.name);
    const manifest = await readState(config.inputDirectory);
    if (!manifest) throw new Error("流失解包清单缺失或损坏；禁止自动全量重建");
    const linked = await exists(target);
    if (linked) {
      const archived = await signature(target);
      if (archived.ino !== item.signature.ino || archived.dev !== item.signature.dev)
        throw new Error("同名归档冲突，保留原包：" + item.name);
    }
    const info = await stat(file), receipt = manifest.archives[item.name];
    if (linked && (!receipt || receipt.size !== info.size || receipt.mtimeMs !== info.mtimeMs))
      throw new Error("中断归档缺少有效解包回执：" + item.name);
    const result = linked ? { accepted: 0 } : await extract({ source: config.inbox, target: config.inputDirectory,
      sevenZip: config.sevenZip, include: [item.name], quiet: true });
    if (!isDeepStrictEqual(await signature(file), item.signature))
      throw new Error("解包期间上传文件发生变化：" + item.name);
    await call({ operation: "archive", file, target, expected: item.signature });
    await record("package_archived", { package: item.name, target, accepted: result.accepted,
      excluded: result.skipped ?? {}, invalid: result.invalid ?? 0 });
    } catch (error) {
      errors[`archive/${item.name}`] = { reason: error.message };
      await record("package_failed", { package: item.name, error: error.message });
    }
  }
  return errors;
}

export function recordKey(model, row) {
  const batch = row.batch_id ?? row.meta?.batch_id, id = row.case_id ?? row.meta?.case_id;
  if (typeof batch !== "string" || !batch || typeof id !== "string" || !id)
    throw new Error("清洗记录缺少 batch_id/case_id");
  return JSON.stringify([model, batch, id]);
}

/** Register the operator's startup slim snapshot in the same incremental identity ledger. */
export async function registerPreparedLost(config, state, call) {
  const records = {}, deliveries = [];
  for (const model of ["aime_fast", "aime_expert"]) {
    const folder = path.join(config.targetDirectory, model);
    if (!await exists(folder)) continue;
    const files = (await fileSourceReader.files([{ kind: "directory", path: folder }]))
      .filter(file => !path.relative(folder, file).split(path.sep).some(part => part.startsWith(".")));
    for (const file of files) {
      if ((await call({ operation: "writable", file })).writing) throw new Error("存量瘦身文件仍在写入：" + file);
      const revision = await fileSourceReader.revision(file);
      let rows = 0, date;
      for await (const line of fileSourceReader.lines(file, revision)) {
        const slim = JSON.parse(line.line), identity = recordKey(model, slim);
        const batch = slim.batch_id ?? slim.meta?.batch_id;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(batch) || date !== undefined && date !== batch)
          throw new Error("存量瘦身文件必须只包含一个业务日期：" + file);
        date = batch;
        const expanded = expandRecord(structuredClone(slim));
        if (!isDeepStrictEqual(slimRecord(expanded), slim)) throw new Error("存量文件未完成瘦身或引用无效：" + file);
        if (Object.hasOwn(records, identity) || Object.hasOwn(state.records, identity))
          throw new Error("存量瘦身文件有重复身份：" + identity);
        records[identity] = { file, revision, offset: line.byteOffset, length: line.byteLength };
        rows++;
      }
      if ((await call({ operation: "writable", file })).writing || await fileSourceReader.revision(file) !== revision)
        throw new Error("登记期间存量瘦身文件发生变化：" + file);
      if (rows) deliveries.push({ model, file, revision, rows, date, admitted: false });
    }
  }
  // Nothing is admitted if any startup file is invalid or changing.
  Object.assign(state.records, records);
  state.deliveries.push(...deliveries);
  return { files: deliveries.length, rows: Object.keys(records).length };
}

/** Publish only new business identities. Prior deliveries are immutable source files. */
export async function deliverLost(config, state, model, name, save, record, call) {
  const key = `${model}/${name}`, request = { inputDirectory: config.inputDirectory,
    cleanDirectory: config.cleanDirectory, model, name };
  // A published file with an uncommitted receipt is recovered before inspecting newer cleaning.
  async function recoverDelivery() {
    const intent = state.publishing;
    if (intent) {
      if (await exists(intent.target)) {
        const revision = await fileSourceReader.revision(intent.target);
        let rows = 0;
        const records = {};
        for await (const line of fileSourceReader.lines(intent.target, revision)) {
          const identity = recordKey(intent.model, JSON.parse(line.line));
          if (Object.hasOwn(state.records, identity)) throw new Error("重复瘦身交付身份：" + identity);
          if (Object.hasOwn(records, identity)) throw new Error("重复瘦身交付身份：" + identity);
          records[identity] = { file: intent.target, revision, offset: line.byteOffset, length: line.byteLength };
          rows++;
        }
        if (rows !== intent.rows) throw new Error("恢复瘦身交付行数不一致");
        Object.assign(state.records, records);
        state.deliveries.push({ model: intent.model, file: intent.target, revision, rows,
          date: intent.name.slice(0, 10), admitted: false });
        state.cleaned[intent.key] = intent.snapshot;
        await unlink(intent.captured).catch(error => { if (error.code !== "ENOENT") throw error; });
        delete state.publishing;
        await save();
        await record("slim_delivered", { file: intent.target, rows });
      } else {
        await unlink(intent.temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
        await unlink(intent.captured).catch(error => { if (error.code !== "ENOENT") throw error; });
        delete state.publishing;
        await save();
      }
    }
  }
  await recoverDelivery();
  const settle = snapshot => {
    if (snapshot.complete) delete state.pending[key];
    else state.pending[key] = { reason: "cleaning_incomplete", status: snapshot.entry.status,
      annotationBacklog: snapshot.entry.annotation_backlog_records ?? 0,
      translationBacklog: snapshot.entry.translation_backlog_records ?? 0 };
    return snapshot.complete;
  };
  const before = await call({ operation: "snapshot", ...request });
  if (!before.ready) { state.pending[key] = before; return false; }
  if (isDeepStrictEqual(state.cleaned[key], before)) return settle(before);
  const folder = path.join(config.targetDirectory, model);
  await mkdir(folder, { recursive: true });
  const id = randomUUID(), target = path.join(folder, `${name.slice(0, 10)}-${id}.jsonl`);
  const temporary = path.join(folder, `.night-${id}.tmp`);
  const captured = path.join(folder, `.night-${id}.raw`);
  let rows = 0, newRows = 0;
  const found = new Set();
  async function* delta() {
    for await (const line of fileSourceReader.lines(captured)) {
      const raw = JSON.parse(line.line), identity = recordKey(model, raw);
      if (found.has(identity)) throw new Error("清洗输出有重复身份：" + identity);
      found.add(identity);
      rows++;
      const slim = slimRecord(structuredClone(raw));
      if (!isDeepStrictEqual(expandRecord(structuredClone(slim)), raw)) throw new Error("瘦身反向还原不一致：" + identity);
      const previous = state.records[identity];
      if (previous) {
        const old = JSON.parse(fileSourceReader.record(previous.file, previous.offset, previous.length, previous.revision));
        if (!isDeepStrictEqual(expandRecord(old), raw)) throw new Error("已交付记录被清洗改写：" + identity);
      } else { newRows++; yield slim; }
    }
  }
  try {
    const capture = await call({ operation: "capture", ...request, expected: before, captured, temporary, target });
    if (!capture.ready) { state.pending[key] = capture; return false; }
    await writeJsonl(temporary, delta());
    if (rows !== before.rows) throw new Error(`清洗输出行数不符：${rows} != ${before.rows}`);
    // The committed prefix must retain every previously delivered identity for this file.
    for (const delivery of state.deliveries.filter(item => item.model === model && item.date === name.slice(0, 10)))
      for await (const line of fileSourceReader.lines(delivery.file, delivery.revision))
        if (!found.has(recordKey(model, JSON.parse(line.line)))) throw new Error("清洗输出删除了已交付记录：" + key);
    if (!newRows) {
      const after = await call({ operation: "snapshot", ...request });
      if (!isDeepStrictEqual(before, after)) { state.pending[key] = { reason: "changed_during_slim" }; return false; }
      state.cleaned[key] = before;
      const complete = settle(before);
      await save();
      return complete;
    }
    state.publishing = { key, model, name, snapshot: before, target, temporary, captured, rows: newRows };
    await save();
    const published = await call({ operation: "publish", ...request, expected: before, captured, temporary, target });
    if (!published.ready) {
      delete state.publishing;
      state.pending[key] = published;
      await save();
      return false;
    }
    // Use the same recovery path on normal completion and after a crash.
    await recoverDelivery();
    const complete = settle(before);
    await save();
    return complete;
  } finally {
    for (const file of [temporary, captured])
      await unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function prepareLost(config, state, save, record, call, stopping = () => false) {
  state.pending = await ingestLost(config, state, save, record, call, stopping);
  const manifest = await readJson(path.join(config.inputDirectory, ".extract-lost-user.json"));
  if (!manifest.files || !manifest.archives) throw new Error("Invalid lost-user extraction manifest");
  for (const name of state.closed?.packages ?? [])
    if (!Object.hasOwn(manifest.archives, name) && !await exists(path.join(config.inbox, name)))
      state.pending[`archive/${name}`] = { reason: "截止时已接收的包缺失，且没有解包回执" };
  for (const key of Object.keys(manifest.files).sort()) {
    if (stopping()) break;
    const [model, day] = key.split("/");
    if (!["aime_fast", "aime_expert"].includes(model)) throw new Error("Unexpected lost-user model: " + model);
    try { await deliverLost(config, state, model, `${day}.jsonl`, save, record, call); }
    catch (error) {
      state.pending[key] = { reason: error.message };
      await record("slim_failed", { file: key, error: error.message });
    }
  }
  await save();
  const inbox = (await readdir(config.inbox)).filter(name => name.endsWith(".7z") &&
    (!state.closed || state.closed.packages.includes(name)));
  return !inbox.length && !Object.keys(state.pending).length && !state.publishing;
}
