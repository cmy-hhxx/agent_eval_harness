import { canonical, type ProblemLibrary, type ProblemObservationRef } from "@eval/contracts";
import { effectiveProblemOccurrences, normalizeLabel } from "@eval/agents/clustering";
import { jobMaterial, type ClusteringJobConfig } from "./clustering-job-types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import treeSchema from "../../../../schemas/workflow/clustering-tree.schema.json" with { type: "json" };
import pendingSchema from "../../../../schemas/clustering/pending-observations.schema.json" with { type: "json" };

type TreeSample = ProblemObservationRef;
const validateNode = new Ajv2020({ allErrors: true, strict: false })
  .addSchema(pendingSchema, "/clustering/pending-observations.schema.json").compile(treeSchema);
export interface ClusteringTreeNode {
  node_id: string;
  parent_id: string | null;
  level: number;
  path: string[];
  label: string;
  definition: string;
  count: number;
  established_count: number;
  uncertain_count: number;
  established_answer_ids: string[];
  meta: { model: string; kind: "model" | "component" | "direction" | "class" | "pending"; answer_ids: string[]; attribution_sources?: ClusteringJobConfig["clusteringJob"]["sources"] };
  class_code?: string;
  samples?: TreeSample[];
}
const findingKey = (ref: Pick<ProblemObservationRef, "input_id" | "finding_id">) => canonical([ref.input_id, ref.finding_id]);

/** Export the frozen source cohort, including healthy answers and every unassigned responsibility. */
export function projectClusteringTree(config: ClusteringJobConfig, inputs: Record<string, unknown>, libraries: ProblemLibrary[]): ClusteringTreeNode[] {
  const nodes: ClusteringTreeNode[] = [];
  for (const library of libraries) {
    const model = library.model, sources = config.clusteringJob.sources.filter(source => source.model === model);
    const sourceByInput = new Map(sources.map(source => [source.input_id, source]));
    const material = jobMaterial(inputs, model), selected = material.pending.filter(ref => sourceByInput.has(ref.input_id));
    const desired = new Map(selected.flatMap(ref => ref.components.map(component => [canonical([findingKey(ref), normalizeLabel(component)]), { ref, component }] as const)));
    const assigned = new Map<string, string>(), members = new Map<string, TreeSample[]>();
    for (const occurrence of effectiveProblemOccurrences(library)) {
      const source = sourceByInput.get(occurrence.input_id);
      if (!source || occurrence.attribution?.task_id !== source.task_id || occurrence.attribution.run !== source.run) continue;
      const problem = library.classes[occurrence.class_id], component = library.components[problem.component_id];
      const owner = desired.get(canonical([findingKey(occurrence), normalizeLabel(component.label)]));
      if (!owner || canonical(occurrence.attribution) !== canonical(owner.ref.attribution) ||
          occurrence.evidence_status !== owner.ref.evidence_status || canonical(occurrence.source) !== canonical(owner.ref.source))
        throw new Error("聚类树样本与冻结归因不一致：" + occurrence.input_id + "/" + occurrence.finding_id);
      const coordinate = canonical([findingKey(occurrence), normalizeLabel(owner.component)]), previous = assigned.get(coordinate);
      if (previous && previous !== problem.id) throw new Error("聚类树同责任问题重复归类：" + coordinate);
      if (previous) continue;
      assigned.set(coordinate, problem.id);
      members.set(problem.id, [...(members.get(problem.id) ?? []), { ...owner.ref, components: [owner.component] }]);
    }
    const nodeSamples = new Map<string, TreeSample[]>();
    const add = (node: Pick<ClusteringTreeNode, "node_id" | "parent_id" | "level" | "path" | "label" | "definition">,
      kind: ClusteringTreeNode["meta"]["kind"], samples: TreeSample[], classCode?: string) => {
      const existing = nodes.find(row => row.node_id === node.node_id);
      if (existing) {
        nodeSamples.set(node.node_id, [...nodeSamples.get(node.node_id)!, ...samples]);
        return;
      }
      nodes.push({ ...node, count: 0, established_count: 0, uncertain_count: 0, established_answer_ids: [],
        meta: { model, kind, answer_ids: [], ...(kind === "model" ? { attribution_sources: sources } : {}) },
        ...(classCode ? { class_code: classCode } : {}), ...(kind === "class" || kind === "pending" ? { samples } : {}) });
      nodeSamples.set(node.node_id, samples);
    };
    const rootId = "model:" + model;
    add({ node_id: rootId, parent_id: null, level: 0, path: [model], label: model,
      definition: "本次冻结回答的功能责任、问题方向与具体机制；计数按每个节点内不同问题发现去重。" }, "model", selected);
    const place = (componentId: string, componentLabel: string, direction: string, id: string, label: string,
      definition: string, samples: TreeSample[], kind: "class" | "pending") => {
      const componentNodeId = model + ":component:" + componentId, directionId = componentNodeId + ":direction:" + direction;
      add({ node_id: componentNodeId, parent_id: rootId, level: 1, path: [model, componentLabel], label: componentLabel,
        definition: library.components[componentId]?.definition || componentLabel }, "component", samples);
      add({ node_id: directionId, parent_id: componentNodeId, level: 2, path: [model, componentLabel, direction],
        label: direction, definition: direction }, "direction", samples);
      add({ node_id: model + ":" + kind + ":" + id, parent_id: directionId, level: 3,
        path: [model, componentLabel, direction, label], label, definition }, kind, samples, kind === "class" ? id : undefined);
    };
    for (const [id, samples] of members) {
      const problem = library.classes[id], component = library.components[problem.component_id], category = problem.category;
      if (!category?.trim()) throw new Error("聚类树问题类必须有一个方向：" + id);
      place(component.id, component.label, category, id, problem.label, problem.definition, samples, "class");
    }
    const pending = new Map<string, TreeSample[]>();
    for (const [coordinate, { ref, component }] of desired) {
      if (assigned.has(coordinate)) continue;
      if (!(library.pending_observations ?? []).some(item => findingKey(item) === findingKey(ref) &&
          canonical(item.attribution) === canonical(ref.attribution) && item.components.includes(component)))
        throw new Error("聚类树问题既未归类也未列入待观察：" + coordinate);
      pending.set(component, [...(pending.get(component) ?? []), { ...ref, components: [component] }]);
    }
    for (const [label, samples] of pending) {
      const component = Object.values(library.components).find(component => [component.label, ...component.aliases].includes(label));
      place(component?.id ?? label, label, "待观察", "pending:" + label, "待观察问题", "尚无足够支持或适用问题类，保留原归因及责任。", samples, "pending");
    }
    for (const node of nodes.filter(node => node.meta.model === model)) {
      const samples = [...new Map(nodeSamples.get(node.node_id)!.map(ref => [findingKey(ref), ref])).values()];
      node.count = samples.length;
      node.established_count = samples.filter(ref => ref.evidence_status === "已确认").length;
      node.uncertain_count = samples.length - node.established_count;
      node.established_answer_ids = [...new Set(samples.filter(ref => ref.evidence_status === "已确认").map(ref => ref.input_id))].sort();
      node.meta.answer_ids = node.level === 0 ? sources.map(source => source.input_id).sort() : [...new Set(samples.map(ref => ref.input_id))].sort();
    }
  }
  if (new Set(nodes.map(node => node.node_id)).size !== nodes.length) throw new Error("聚类树节点身份重复");
  for (const node of nodes) if (!validateNode(node)) throw new Error("聚类树节点契约无效：" + JSON.stringify(validateNode.errors));
  return nodes;
}
