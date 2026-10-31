import { cite, displayEvidence, evidenceSources, images, normativeSources, parseEvidenceCoordinates } from "@eval/tools";
import type { JsonObject } from "@eval/contracts";
import type { RawInput } from "../inputs/types.js";
import { invocationTarget, type InvestigationGroup } from "./component-groups.js";
import { compactFinalMaterial, compactProcessExcerpts, compactTextRanges } from "./compact-material.js";

function citationExcerpts(raw: RawInput, original: RawInput, inputId: string, inventory: JsonObject) {
  let remaining = 4000;
  return { references: (inventory.references as JsonObject[] ?? []).map(reference => ({ reference: reference.reference,
    status: reference.status, read_requests: (reference.sources as JsonObject[]).map(item => item.read_request),
    sources: (reference.sources as JsonObject[]).flatMap(item => {
      const point = parseEvidenceCoordinates(String((item.reference as JsonObject).evidence_id));
      if (!point || point.kind === "image") return [];
      const source = evidenceSources(raw.messages[point.message_index]).find(source => source.kind === point.kind && source.path === point.path);
      if (!source || !evidenceSources(original.messages[point.message_index]).some(other => other.kind === source.kind && other.path === source.path && other.text === source.text)) return [];
      const ranges = compactTextRanges(source.text, point.start, point.end);
      return [ranges[0], ranges.at(-1)].filter((range, index, array) => range && array.indexOf(range) === index).flatMap(range => {
        if (!range || range.end - range.start > remaining) return [];
        remaining -= range.end - range.start;
        return [{ ...displayEvidence(cite(inputId, point.message_index, source, range.start, range.end)),
          read_request: item.read_request }];
      });
    }) })) };
}

/** The group supplies identities and its own paired invocations; context never presumes blame. */
export function componentMaterial(raw: RawInput, original: RawInput, inputId: string,
  positions: { trace_index: number; message_index: number }[], traceIndex: number, finalIndex: number,
  group: InvestigationGroup, turn: JsonObject, facts: JsonObject, finalSources?: JsonObject, components: JsonObject[] = []) {
  const roots = new Set(group.members.flatMap(member => member.message_indices as number[])), allLinks = facts.execution_links as JsonObject[];
  const links = group.links;
  const related = new Set([...roots, ...links.flatMap(link => [Number(link.request_message_index), ...link.return_message_indices as number[]])]);
  const errors = turn.tool_errors as JsonObject[];
  const ownErrors = group.errors;
  const excerpts = (indices: ReadonlySet<number>, budget: number) => compactProcessExcerpts("component_investigation", raw, original,
    inputId, positions, traceIndex, finalIndex, budget, indices).map(({ origin: _origin, total_chars: _size, ...proof }) => proof);
  const final = compactFinalMaterial(finalIndex, raw, inputId, group.delivery ? 8000 : 2400);
  let questionBudget = 6400;
  const seenQuestions = new Set<string>();
  const questionSources = raw.messages.flatMap((message, index) => index < finalIndex && (message.role === "user" || message.type === "user_question")
    ? evidenceSources(message).filter(source => source.kind === "text" && source.quotable !== false && /^\/content(?:\/|$)/u.test(source.path))
      .map(source => cite(inputId, index, source, 0, source.text.length)) : []);
  questionSources.push(...normativeSources(raw, inputId, finalIndex).filter(source => source.role === "user").flatMap(source => source.evidence));
  const question = questionSources.sort((a, b) => b.message_index - a.message_index).flatMap(proof => {
      if (seenQuestions.has(proof.evidence_id)) return [];
      seenQuestions.add(proof.evidence_id);
      const point = parseEvidenceCoordinates(proof.evidence_id)!;
      if (point.kind === "image") return [];
      const leaf = evidenceSources(raw.messages[point.message_index]).find(item => item.kind === point.kind && item.path === point.path)!;
      return compactTextRanges(leaf.text, point.start, point.end).flatMap(range => {
        if (range.end - range.start > questionBudget) return [];
        questionBudget -= range.end - range.start;
        return [displayEvidence(cite(inputId, point.message_index, leaf, range.start, range.end))];
      });
    }).sort((a, b) => a.message_index - b.message_index);
  // Context is paired too: an earlier relevant receipt is never silently replaced
  // by the last call of a tool. All own calls stay in source order for repair review.
  const deliveryLinks = [...new Set(components.flatMap(component => {
    if (component.kind === "model") return [];
    const indices = new Set(component.message_indices as number[]);
    const last = allLinks.findLast(link => indices.has(Number(link.request_message_index)) ||
      (link.return_message_indices as number[]).some(index => indices.has(index)));
    return last ? [last] : [];
  }))].filter(link => !links.includes(link));
  const cited = new Set(finalSources ? ((finalSources.citation_inventory as JsonObject).references as JsonObject[]).flatMap(reference =>
    (reference.sources as JsonObject[]).map(source => parseEvidenceCoordinates(String((source.reference as JsonObject).evidence_id))?.message_index)) : []);
  const contextLinks = [...new Set([...deliveryLinks, ...allLinks.filter(link =>
    (link.return_message_indices as number[]).some(index => cited.has(index)))])].filter(link => !links.includes(link));
  const namesAt = (index: number, kind?: string) => components.filter(component => (!kind || component.kind === kind) &&
    (component.message_indices as number[]).includes(index)).map(component => component.name);
  const navigation = (message_index: number) => {
    const message = raw.messages[message_index]!;
    return { candidate: "answer", message_index, path: "/" +
      ((["tool_call", "function_call"].includes(String(message.type)) ? ["input", "arguments", "parameters"] : ["output", "content", "result"])
        .find(key => Object.hasOwn(message, key)) ?? ""), offset: 0, max_chars: 16000 };
  };
  // Inside a tool group the request side is the member that answers for it, including program-named generation.
  const requesters = (link: JsonObject) => {
    if (group.delivery) return namesAt(Number(link.invoking_model_message_index), "model");
    const generators = group.members.filter(member => member.role === "request_generation");
    const named = generators.filter(member => member.identity_basis !== "program_request_generation" &&
      (member.message_indices as number[]).includes(Number(link.invoking_model_message_index)));
    return named.length ? named.map(member => member.name)
      : generators.filter(member => member.name === `${invocationTarget(raw, group.members, Number(link.request_message_index))} 请求生成`).map(member => member.name);
  };
  // An entry tool (shell) running a recorded script only transports the call; the script executes it.
  const executors = (request: number) => {
    const names = namesAt(request), scripts = namesAt(request, "script");
    return scripts.length ? { executed_components: scripts, entry_components: names.filter(name => !scripts.includes(name)) }
      : { executed_components: names };
  };
  const paired = (selected: JsonObject[], budget: number) => selected.map(link => {
    const request = Number(link.request_message_index), returns = link.return_message_indices as number[];
    const share = Math.min(9000, Math.max(1200, Math.floor(budget / Math.max(1, selected.length))));
    return { request_message_index: request, return_message_indices: returns,
      request_components: requesters(link), ...executors(request),
      request_evidence: excerpts(new Set([request]), Math.floor(share / 3)),
      return_evidence: excerpts(new Set(returns), Math.floor(share * 2 / 3)),
      read_requests: [request, ...returns].map(navigation),
      implementation_read_requests: returns.flatMap(message_index => {
        const message = raw.messages[message_index]!, output = (message.output ?? message.result) as JsonObject | undefined;
        const placeholders = (output?.prompt as JsonObject | undefined)?.placeHolder;
        if (!Array.isArray(placeholders)) return [];
        return (placeholders as JsonObject[]).flatMap((item, index) => ["db_info", "syntax_rule", "instruction"].includes(String(item.key)) && item.value
          ? [{ candidate: "answer", message_index, path: `/${Object.hasOwn(message, "output") ? "output" : "result"}/prompt/placeHolder/${index}/value`, offset: 0, max_chars: 16000 }] : []);
      }) };
  });
  const modelIndices = new Set([...roots, ...links.map(link => Number(link.invoking_model_message_index))]
    .filter(index => raw.messages[index]?.type === "llm_turn"));
  const skills = components.filter(component => component.kind === "skill");
  const skillIndices = new Set(skills.flatMap(component => component.message_indices as number[]));
  const contextIndices = new Set([...related, ...skillIndices, ...contextLinks.flatMap(link => [Number(link.request_message_index), ...link.return_message_indices as number[]])]);
  let contractBudget = 4000;
  const knownContracts = new Set<string>();
  const toolNames = new Set([...links, ...contextLinks].map(link => String(raw.messages[Number(link.request_message_index)]?.name)));
  const contracts = [...modelIndices].sort((a, b) => b - a).flatMap(message_index => {
    const message = raw.messages[message_index]!, snapshot = message.input_messages as JsonObject;
    if (!snapshot || !Array.isArray(snapshot.tools)) return [];
    return (snapshot.tools as JsonObject[]).flatMap((tool, index) => {
      const body = (tool.function ?? tool) as JsonObject, name = String(body.name);
      if (!toolNames.has(name) || knownContracts.has(name)) return [];
      knownContracts.add(name);
      const path = `/input_messages/tools/${index}${tool.function ? "/function" : ""}`;
      const originals = evidenceSources(original.messages[message_index]);
      const evidence = evidenceSources(message).filter(source => source.kind === "text" && source.quotable !== false &&
        source.path.startsWith(path + "/") && originals.some(other => other.kind === source.kind && other.path === source.path && other.text === source.text))
        .flatMap(source => compactTextRanges(source.text).flatMap(range => {
          if (range.end - range.start > contractBudget) return [];
          contractBudget -= range.end - range.start;
          return [displayEvidence(cite(inputId, message_index, source, range.start, range.end))];
        }));
      return [{ name, evidence, read_request: { candidate: "answer", message_index, path, offset: 0, max_chars: 16000 } }];
    });
  });
  return { errors: ownErrors, modelInput: {
    investigation_scope: group.delivery ? "delivery" : "tool_chain",
    investigated_components: group.members.map(member => ({ actor_index: member.component_index, name: member.name, kind: member.kind, role: member.role,
      ...(member.contains_final_generation ? { contains_final_generation: true } : {}),
      ...(member.components_content ? { content: member.components_content } : {}),
      source_evidence: (member.source_evidence as JsonObject[] ?? []).slice(0, 3) })),
    user_requirements: question, invocations: paired(links, 20000), context_invocations: paired(contextLinks, 6000),
    model_actions: excerpts(modelIndices, 3000), callable_contracts: contracts,
    loaded_skills: skills.map(component => ({ name: component.name, message_indices: component.message_indices })),
    skill_evidence: excerpts(skillIndices, group.members.some(member => member.kind === "skill") ? 6400 : 3200),
    tool_errors: ownErrors, upstream_error_context: errors.filter(error => !ownErrors.includes(error)),
    final_answer: final.final_evidence, final_partial: final.final_context.partial,
    final_answer_read_request: { candidate: "answer", message_index: finalIndex, path: "/content", offset: 0, max_chars: 16000 },
    final_claims: turn.key_data,
    ...(finalSources ? { citation_sources: citationExcerpts(raw, original, inputId, finalSources.citation_inventory as JsonObject),
      applicable_rules: finalSources.norm_directory } : {}),
    source_directory: [...contextIndices].sort((a, b) => a - b).map(message_index => ({ message_index,
      type: raw.messages[message_index]?.type, name: raw.messages[message_index]?.name,
      ...(images(raw.messages[message_index]).length ? { image_count: images(raw.messages[message_index]).length,
        view_request: { candidate: "answer", message_index } } : {}),
      read_request: navigation(message_index) })),
  } as JsonObject };
}
