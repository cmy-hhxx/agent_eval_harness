import { canonical, type PlannedTask, type RunManifest, type WorkflowDefinition } from "@eval/contracts";
import { completedCaseKey, fileSourceReader, readCompletedCases, readJson, writeJson } from "@eval/data";
import { adapt, candidateKey, createInputBindings, type Candidate } from "@eval/workflows/inputs";
import { attributionWorkflow, indexAttributionTasks, planAttributionUnit, type AttributionTaskData } from "@eval/workflows/attribution";
import { assertComparableGroups, buildPlan, comparisonWorkflow, expandComparisonPairs, type EvalConfig, type TaskData } from "@eval/workflows/comparison";
import type { HostConfig } from "@eval/host-app/config";
import { checkData, emptyDataCheck, type ScheduledInput, type EvaluationUnit, type InputSchedule } from "./data-check.js";
interface Round {
  active: string[]; pending: string[]; ready: string[]; acknowledging?: boolean; number: number; finished?: boolean;
}
export const emptyInputSchedule = (): InputSchedule => ({ files: [], records: [], units: [], issues: [] });
const unitKey = (unit: EvaluationUnit) => canonical([unit.batch_id, unit.case_id, [...unit.models].sort()]);
const caseKey = (row: { batch_id: string; case_id: string }) => canonical([row.batch_id, row.case_id]);
const roundState = (manifest: RunManifest) => (manifest.preflight.rounds ??= { active: [], pending: [], ready: [], number: 0 }) as unknown as Round;

/** Rebuild changed source coordinates, never reject a resume on an old source receipt. */
export async function loadInputSchedule(host: HostConfig, file: string, signal: AbortSignal) {
  let previous: ScheduledInput[] = [];
  try {
    const schedule = await readJson<InputSchedule>(file);
    if (!Array.isArray(schedule.files) || !Array.isArray(schedule.records) || !Array.isArray(schedule.units) || !Array.isArray(schedule.issues))
      throw new Error("评测调度索引结构无效，请重新 Check data");
    previous = schedule.records;
    let fresh = true;
    for (const entry of schedule.files) {
      if (await fileSourceReader.revision(entry.source) !== entry.revision) fresh = false;
    }
    // Directory expansion can also add or remove a physical source file.
    const sources = (await Promise.all(host.evaluation.inputs.versions.map(v => fileSourceReader.files(v.sources)))).flat();
    if (fresh && sources.length === schedule.files.length && sources.every(source => schedule.files.some(f => f.source === source))) return schedule;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const schedule = emptyInputSchedule();
  await checkData(host, emptyDataCheck(host.workflow), signal, async () => {}, "resume", schedule);
  const identities = new Map(previous.map(row => [candidateKey(row as Candidate), row.input_id]));
  for (const row of schedule.records) row.input_id = identities.get(candidateKey(row as Candidate)) ?? row.input_id;
  await writeJson(file, schedule);
  return schedule;
}

function taskUnit(task: PlannedTask, comparison: boolean): EvaluationUnit | undefined {
  if (!comparison) {
    const candidate = (task.data as AttributionTaskData).candidate;
    return candidate && { batch_id: candidate.batch_id, case_id: candidate.case_id, models: [candidate.version] };
  }
  if (task.stage !== "comparison") return undefined;
  const data = task.data as TaskData, candidates = Object.values(data.candidates);
  const candidate = candidates[0];
  return candidate && { batch_id: candidate.batch_id, case_id: candidate.case_id, models: candidates.map(c => c.version).sort() };
}

/** Admit the selected final units plus their shared dependencies and polish work. */
export function roundAdmission(manifest: RunManifest, comparison: boolean): ReadonlySet<string> {
  const round = roundState(manifest);
  if (round.finished || manifest.executionScope) return new Set(manifest.tasks.map(t => t.id));
  const tasks = new Map(manifest.tasks.map(t => [t.id, t]));
  const roots = new Map<string, string[]>(), dates = new Map<string, Set<string>>();
  for (const key of round.active) {
    const [batch] = JSON.parse(key) as [string];
    if (!dates.has(batch)) dates.set(batch, new Set());
    dates.get(batch)!.add(key);
  }
  const followups = new Map<string, string[]>();
  for (const task of manifest.tasks) {
    const unit = taskUnit(task, comparison);
    if (unit) { const key = unitKey(unit); roots.set(key, [...(roots.get(key) ?? []), task.id]); }
    const parent = (task.data as TaskData).rewriteOf?.taskId;
    if (parent) followups.set(parent, [...(followups.get(parent) ?? []), task.id]);
  }
  const allowed = new Set<string>();
  const visit = (id: string) => {
    if (allowed.has(id)) return;
    const task = tasks.get(id); if (!task) return;
    allowed.add(id);
    Object.values(task.dependencies).forEach(visit);
    followups.get(id)?.forEach(visit);
  };
  for (const selected of dates.values()) {
    allowed.clear();
    for (const key of selected) if (round.ready.includes(key)) roots.get(key)?.forEach(visit);
    // Finish this date's model groups before moving to the next date in the round.
    if (round.pending.some(key => selected.has(key)) ||
        [...allowed].some(id => ["pending", "running"].includes(manifest.states[id]?.status))) return allowed;
  }
  return new Set();
}

/** One unfinished unit per date/model-pair (or date/model), with a barrier between rounds. */
export function createRoundWorkflow(host: HostConfig, schedule: InputSchedule): WorkflowDefinition {
  const comparison = host.workflow === "comparison", base = comparison ? comparisonWorkflow : attributionWorkflow;
  return {
    ...base,
    async plan(config) {
      if (comparison) assertComparableGroups(config as EvalConfig);
      return { tasks: [], inputs: {}, catalog: [], summary: { sharded: true, issues: schedule.issues,
        rounds: { active: [], pending: [], ready: [], number: 0 }, scheduled_units: schedule.units.length } };
    },
    scheduling: { ...base.scheduling, sessionAdmission: undefined, admit: manifest => roundAdmission(manifest, comparison) },
    async reconcile(_run, state, config) {
      state.manifest.config = config;
      delete state.manifest.preflight.case_stream;
      state.manifest.preflight.issues = schedule.issues;
      state.manifest.preflight.scheduled_units = schedule.units.length;
      const round = roundState(state.manifest); round.finished = false;
      // Bind unfinished inputs to their current coordinates before allowing saved tasks to run.
      round.pending = [...round.active]; round.ready = []; delete round.acknowledging;
      const catalog = state.manifest.inputCatalog as Candidate[] ?? [];
      return { tasks: state.manifest.tasks, inputs: createInputBindings(host.evaluation)(catalog.filter(c => !c.released)),
        catalog, summary: state.manifest.preflight };
    },
    release(state, inputs) {
      if (!comparison) { attributionWorkflow.release!(state, inputs); return; }
      const busy = new Set(state.manifest.tasks.filter(t => ["pending", "running"].includes(state.manifest.states[t.id]?.status))
        .flatMap(t => Object.values(t.inputIds)));
      for (const c of state.manifest.inputCatalog as Candidate[] ?? []) if (!busy.has(c.input_id)) {
        c.released = true; delete inputs[c.input_id];
      }
    },
    shards(_config, state) {
      if (state.manifest.executionScope) return { done: () => true, next: async () => undefined };
      const manifest = state.manifest, round = roundState(manifest), config = host.evaluation;
      const byCase = new Map<string, ScheduledInput[]>(), units = new Map(schedule.units.map(u => [unitKey(u), u]));
      for (const row of schedule.records) byCase.set(caseKey(row), [...(byCase.get(caseKey(row)) ?? []), row]);
      let queues: { batch: string; order: number; units: string[] }[] | undefined;
      const loadedCases = new Map<string, Candidate[]>();
      const bind = createInputBindings(config);
      const initialize = async () => {
        const completed = config.output.layout === "business" ? await readCompletedCases(config.output.path,
          comparison ? [] : config.inputs.versions.map(v => v.id), comparison ? expandComparisonPairs((config as EvalConfig).comparisons) : []) : new Set<string>();
        const stage = comparison ? "comparison" : "attribution-session", active = new Set(round.active);
        const groups = new Map<string, { batch: string; order: number; units: string[] }>();
        let skipped = 0;
        const finished = new Set<string>();
        for (const [key, unit] of units) {
          if ([unit.case_id, ...unit.aliases ?? []].some(id => completed.has(completedCaseKey(stage, unit.models, unit.batch_id, id)))) {
            skipped++; finished.add(key); continue;
          }
          if (active.has(key)) continue;
          const group = canonical([unit.batch_id, unit.models]);
          if (!groups.has(group)) groups.set(group, { batch: unit.batch_id, order: groups.size, units: [] });
          groups.get(group)!.units.push(key);
        }
        manifest.preflight.skipped_cases = skipped;
        round.active = round.active.filter(key => !finished.has(key));
        round.pending = round.pending.filter(key => !finished.has(key));
        round.ready = round.ready.filter(key => !finished.has(key));
        queues = [...groups.values()].sort((a, b) => b.batch.localeCompare(a.batch) || a.order - b.order);
      };
      const active = () => [...roundAdmission(manifest, comparison)].some(id => ["pending", "running"].includes(manifest.states[id]?.status));
      return {
        done: () => !!round.finished,
        async next() {
          if (!queues) await initialize();
          // Host merged the previous shard before asking for another one.
          if (round.acknowledging) {
            round.ready.push(round.pending.shift()!); delete round.acknowledging;
          }
          if (!round.pending.length) {
            if (active()) return undefined;
            loadedCases.clear();
            round.active = queues!.flatMap(q => q.units.length ? [q.units.shift()!] : []);
            round.pending = [...round.active]; round.ready = [];
            if (!round.active.length) { round.finished = true; return undefined; }
            round.number++;
          }
          const key = round.pending[0], unit = units.get(key);
          if (!unit) throw new Error("当前轮次的业务样本已不存在，请重新 Check data");
          const prior = manifest.inputCatalog as Candidate[] ?? [];
          const records = byCase.get(caseKey(unit)) ?? [];
          const selected = comparison ? records : records.filter(r => unit.models.includes(r.version));
          const cacheKey = comparison ? caseKey(unit) : key;
          let candidates = loadedCases.get(cacheKey);
          if (!candidates) candidates = await Promise.all(selected.map(async row => {
            const version = config.inputs.versions.find(v => v.id === row.version);
            if (!version) throw new Error("调度索引模型与当前配置不一致: " + row.version);
            const revision = await fileSourceReader.revision(row.source);
            const raw = JSON.parse(fileSourceReader.record(row.source, row.byte_offset, row.byte_length, revision));
            const candidate = adapt(raw, version, row.source, row.line, config.inputs.default_batch_id);
            if (candidateKey(candidate) !== candidateKey(row as Candidate)) throw new Error("调度索引业务身份已变化，请重新 Check data");
            const old = prior.find(c => candidateKey(c) === candidateKey(candidate));
            const current = { ...candidate, input_id: old?.input_id ?? row.input_id, released: false,
              byte_offset: row.byte_offset, byte_length: row.byte_length, source_revision: revision };
            if (old) { Object.assign(old, current); return old; }
            return current;
          }));
          loadedCases.set(cacheKey, candidates);
          const accepted = new Set(Object.keys(state.receipts));
          const plan = comparison ? await buildPlan(config as EvalConfig,
            { tasks: manifest.tasks, inputs: {}, catalog: prior, summary: {} }, { candidates, acceptedTaskIds: accepted, materializeInputs: false }) :
            { tasks: candidates.flatMap(c => planAttributionUnit(c, { previousTasks: indexAttributionTasks(manifest.tasks), acceptedTaskIds: accepted }).tasks), summary: { issues: [] } };
          round.acknowledging = true;
          return { source: candidates.map(c => c.source).join(", "), revision: "", candidates,
            tasks: plan.tasks, inputs: bind(candidates), issues: plan.summary.issues as import("@eval/contracts").JsonObject[] };
        },
      };
    },
  };
}
