import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BSON, MongoClient, type Collection, type Document, type AnyBulkWriteOperation } from "mongodb";
import { errorText, redact, safeId, type PublicationInput, type PublicationResult, type PublicationCounts, type PublicationLabels } from "@eval/contracts";

export interface MongoPublicationConfig { uri: string; database: string; collection: string; tlsCAFile?: string; inputsUnchanged?: boolean }
type Stored = Document & { _id: string };
const BATCH_BYTES = 2 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 60_000;

/** No collection creation, migrations, deletes or cross-run result cache. */
export async function publishMongo(
  config: MongoPublicationConfig, date: string, inputs: AsyncIterable<PublicationInput>,
  results: AsyncIterable<PublicationResult>, signal: AbortSignal,
): Promise<PublicationCounts> {
  return withMongoPublication(config, signal, (collection) =>
    writeMongoPublication(collection, date, inputs, results, signal, config.inputsUnchanged));
}

/** Oldest first: the last record per case supplies its current difficulty, with _id breaking time ties. */
export async function readMongoLabels(config: MongoPublicationConfig, dates: string[], signal: AbortSignal): Promise<PublicationLabels[]> {
  if (!dates.length) return [];
  return withMongoPublication(config, signal, async (collection) => {
    const documents = await collection.find({ kind: "input", batchId: { $in: dates } }, {
      signal, timeoutMS: OPERATION_TIMEOUT_MS, timeoutMode: "iteration", batchSize: 500,
      projection: { _id: 1, createdAt: 1, batchId: 1, "trace.case_id": 1, "trace.meta.case_id": 1, "trace.meta.task": 1, "trace.meta.difficulty": 1 },
    }).toArray();
    // A server sort blocks the first batch until all historical traces have been scanned.
    for (const doc of documents) if (typeof doc._id !== "string" || !(doc.createdAt instanceof Date) || !Number.isFinite(doc.createdAt.getTime()))
      throw new Error("Mongo label lacks a valid createdAt or record ID");
    documents.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    return documents.map((doc) => {
      const caseId = doc.trace?.case_id ?? doc.trace?.meta?.case_id;
      if (typeof doc.batchId !== "string" || typeof caseId !== "string" || !caseId) throw new Error("Mongo label lacks business identity");
      return { batchId: doc.batchId, caseId, task: doc.trace?.meta?.task, difficulty: doc.trace?.meta?.difficulty ?? "" };
    });
  });
}

async function withMongoPublication<T>(config: MongoPublicationConfig, signal: AbortSignal, operation: (collection: Collection<Stored>) => Promise<T>): Promise<T> {
  let client: MongoClient | undefined;
  const stop = () => { void client?.close().catch(() => {}); };
  try {
    client = new MongoClient(config.uri, {
      ...(config.tlsCAFile ? { tls: true, tlsCAFile: config.tlsCAFile } : {}),
      serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, socketTimeoutMS: OPERATION_TIMEOUT_MS, timeoutMS: OPERATION_TIMEOUT_MS,
    });
    signal.throwIfAborted();
    signal.addEventListener("abort", stop, { once: true });
    await client.connect();
    const db = client.db(config.database);
    if (!(await db.listCollections({ name: config.collection }, { nameOnly: true }).hasNext()))
      throw new Error("Publication collection does not exist: " + config.collection);
    return await operation(db.collection<Stored>(config.collection));
  } catch (error) {
    const credentials = config.uri.match(/\/\/([^@/]+)@/)?.[1];
    const secrets = [config.uri, credentials, ...credentials?.split(":").flatMap((part) => {
      try { return [part, decodeURIComponent(part)]; } catch { return [part]; }
    }) ?? []].filter((value): value is string => !!value);
    throw new Error(redact(errorText(error), secrets));
  } finally { signal.removeEventListener("abort", stop); await client?.close(); }
}

/** Existing case IDs are resolved through raw business identity; new cases get persistent UUIDs. */
export async function writeMongoPublication(
  collection: Pick<Collection<Stored>, "find" | "bulkWrite">, date: string,
  inputs: AsyncIterable<PublicationInput>, results: AsyncIterable<PublicationResult>, signal: AbortSignal,
  inputsUnchanged = false,
): Promise<PublicationCounts> {
  const readOptions = { signal, timeoutMS: OPERATION_TIMEOUT_MS, timeoutMode: "iteration" as const, batchSize: 1 };
  async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try { return await operation(); }
    catch (error) { throw new Error(`Mongo ${date} ${name}: ${errorText(error)}`); }
  }
  const existing = await step("read identities", () => collection.find({ batchId: date }, { ...readOptions, batchSize: 100, projection: {
    kind: 1, caseId: 1, versionId: 1, "trace.case_id": 1, "trace.meta.case_id": 1, evaluatedAt: 1,
  } }).toArray());
  const cases = new Map<string, string>(), rawById = new Map<string, string>();
  const storedIds = new Set(existing.map((doc) => doc._id));
  for (const doc of existing.filter((item) => item.kind === "input")) {
    const raw = doc.trace?.case_id ?? doc.trace?.meta?.case_id;
    if (typeof raw !== "string" || !raw || typeof doc.caseId !== "string") throw new Error("Mongo input lacks business identity");
    if ((cases.has(raw) && cases.get(raw) !== doc.caseId) || (rawById.has(doc.caseId) && rawById.get(doc.caseId) !== raw))
      throw new Error("Conflicting Mongo case identity: " + raw);
    cases.set(raw, doc.caseId); rawById.set(doc.caseId, raw);
  }
  const counts: PublicationCounts = { inputs: 0, comparisons: 0, inserted: 0, updated: 0 };
  let pending: Stored[] = [], pendingBytes = 0;
  const seen = new Set<string>();
  async function flush() {
    if (!pending.length) return;
    signal.throwIfAborted();
    const batch = `${pending[0].kind} batch (${pending.length} documents, ${pendingBytes} bytes)`;
    const stored = new Map((await step(`read ${batch}`, () => collection.find({ _id: { $in: pending.map((doc) => doc._id) } }, readOptions)
      .toArray())).map((doc) => [doc._id, doc]));
    const operations: AnyBulkWriteOperation<Stored>[] = [];
    for (const doc of pending) {
      const prior = stored.get(doc._id);
      const { _id, createdAt, ...fields } = doc;
      if (prior) {
        // Raw source refreshes must not erase annotations maintained on the stored input.
        if (doc.kind === "input") {
          const meta = { ...doc.trace.meta };
          for (const field of ["task", "difficulty"])
            if (!meta[field] && prior.trace?.meta?.[field]) meta[field] = prior.trace.meta[field];
          if (!isDeepStrictEqual(meta, doc.trace.meta ?? {})) fields.trace = { ...doc.trace, meta };
        }
        const sameResult = doc.kind === "comparison" && isDeepStrictEqual(prior.result, doc.result);
        const changed = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
          !(key === "evaluatedAt" && sameResult) && !isDeepStrictEqual(prior[key], value)));
        const unsetTask = doc.kind === "comparison" && !Object.hasOwn(doc, "task") && Object.hasOwn(prior, "task");
        if (!Object.keys(changed).length && !unsetTask) continue;
        operations.push({ updateOne: { filter: { _id }, update: { $set: changed, ...(unsetTask ? { $unset: { task: "" } } : {}) } } });
      } else operations.push({ updateOne: { filter: { _id }, update: { $setOnInsert: doc }, upsert: true } });
    }
    if (operations.length) {
      // The destination's envelope validator predates the task field used by its current reader.
      // Validate this producer's document shape before bypassing that stale comparison-only validator.
      const result = await step(`write ${batch}`, () => collection.bulkWrite(operations, {
        ordered: true, bypassDocumentValidation: pending[0].kind === "comparison", timeoutMS: OPERATION_TIMEOUT_MS,
      }));
      if (!result.isOk()) throw new Error("Mongo publication was not acknowledged");
      counts.inserted += result.upsertedCount;
      counts.updated += result.modifiedCount;
    }
    pending = []; pendingBytes = 0;
  }
  async function queue(doc: Stored) {
    signal.throwIfAborted();
    if (seen.has(doc._id)) throw new Error("Duplicate publication identity: " + doc._id);
    const bytes = BSON.calculateObjectSize(doc);
    if (bytes >= 16 * 1024 * 1024) throw new Error("Mongo document exceeds 16 MiB: " + doc._id);
    if (pendingBytes + bytes > BATCH_BYTES) await flush();
    seen.add(doc._id); pending.push(doc); pendingBytes += bytes;
    if (pending.length >= 100 || pendingBytes >= BATCH_BYTES) await flush();
  }
  const inputTasks = new Map<string, unknown>();
  for await (const { versionId, trace } of inputs) {
    safeId(versionId);
    if (trace.batch_id !== date ||
        typeof trace.case_id !== "string" || !trace.case_id || !Array.isArray(trace.messages) || !trace.messages.length)
      throw new Error("Invalid publication input: " + versionId);
    const caseId = cases.get(trace.case_id) ?? randomUUID();
    cases.set(trace.case_id, caseId);
    inputTasks.set(JSON.stringify([trace.case_id, versionId]), trace.task);
    const id = `input:${date}:${caseId}:${versionId}`;
    if (inputsUnchanged && storedIds.has(id)) {
      if (seen.has(id)) throw new Error("Duplicate publication identity: " + id);
      seen.add(id);
    } else await queue({ _id: id, kind: "input", batchId: date, caseId, versionId, trace, createdAt: new Date() });
    counts.inputs++;
  }
  await flush();
  const core = new Map<string, boolean>();
  for await (const { row, evaluatedAt } of results) {
    if (row.status === "needs_review" || row.evaluation_type === "comparison_review")
      throw new Error("Only decided comparisons can be published");
    const identity = row.case as { batch_id?: string; case_id?: string };
    const models = row.models as Record<string, Document>;
    const versions = Object.keys(models ?? {}).sort(), rawId = identity?.case_id;
    const caseId = rawId && cases.get(rawId);
    if (identity?.batch_id !== date || !caseId || versions.length !== 2 || !Number.isFinite(evaluatedAt) ||
        !versions.every((id) => inputTasks.has(JSON.stringify([rawId, id]))))
      throw new Error("Comparison is missing paired input or evaluation time");
    if (row.rewritten !== undefined && (!Array.isArray((row.rewritten as Document)?.rewrites) || !(row.rewritten as Document).rewrites.length))
      throw new Error("Invalid comparison rewrite");
    const task = inputTasks.get(JSON.stringify([rawId, versions[0]]));
    if (task !== inputTasks.get(JSON.stringify([rawId, versions[1]]))) throw new Error("Comparison input tasks differ");
    for (const version of versions) {
      const key = JSON.stringify([rawId, version]), value = (row.assessments as Document | undefined)?.[version]?.meets_core;
      if (row.status === "decided" && typeof value !== "boolean") throw new Error("Settled comparison is missing a core assessment: " + key);
      if (typeof value !== "boolean") continue;
      if (core.has(key) && core.get(key) !== value) throw new Error("Conflicting answer core assessments across comparisons: " + key);
      core.set(key, value);
    }
    const matching = Object.entries(row.verdicts as Record<string, unknown>).filter(([key]) => {
      const pair = key.split("__vs__");
      return pair.length === 2 && versions.every((id) => pair.includes(id));
    });
    if (matching.length !== 1) throw new Error("Comparison verdict is missing or duplicated");
    const verdict = matching[0][1];
    const comparison = { ...row, case: { batch_id: date, case_id: caseId },
      models: Object.fromEntries(versions.map((id) => [id, { ...models[id], version: id, display_name: models[id].version }])), verdict };
    await queue({ _id: `comparison:${date}:${caseId}:${versions.join(":")}`, kind: "comparison", batchId: date, caseId,
      ...(typeof task === "string" && task ? { task } : {}), versionA: versions[0], versionB: versions[1],
      result: { comparison }, evaluatedAt: new Date(evaluatedAt), createdAt: new Date(evaluatedAt) });
    counts.comparisons++;
  }
  await flush();
  return counts;
}
