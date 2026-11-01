import path from "node:path";
import { type JsonObject } from "@eval/contracts";
import { cite, displayEvidence, evidenceSources, messageContentSources, isComponentLocator, traceExchanges, traceCallOrigins } from "@eval/tools";
import type { RawInput } from "../inputs/types.js";
import { compactSourceEvidence } from "./evidence-presentation.js";

/** Written heredoc bodies are data, not shell invocations; retain offsets for original citations. */
function shellCommands(text: string): string {
  const delimiters: string[] = [];
  const code = text.split(/(?<=\n)/u).map(line => {
    if (delimiters.length) {
      if (line.trim() === delimiters[0]) delimiters.shift();
      return line.replace(/[^\n]/g, " ");
    }
    for (const match of line.matchAll(/<<-?\s*(["']?)([A-Za-z_][\w-]*)\1/gu)) delimiters.push(match[2]!);
    return line;
  }).join("");
  let quote = "", escaped = false, comment = false;
  return code.split("").map((char, index) => {
    if (comment) { if (char === "\n") comment = false; else return " "; }
    if (escaped) { escaped = false; return /[;&|\n]/u.test(char) ? " " : char; }
    if (char === "\\" && quote !== "'") { escaped = true; return char; }
    if (quote) {
      if (char === quote) quote = "";
      else if (/[;&|\n]/u.test(char)) return " ";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#" && (index === 0 || /\s/u.test(code[index - 1]!))) { comment = true; return " "; }
    return char;
  }).join("");
}

/**
 * The working directory of each simple command. A skill script run as `cd <dir> && python scripts/x.py`
 * executes the same file as its absolute path, so identity is decided after this resolution.
 */
function commandDirectories(command: string) {
  const spans: { start: number; end: number; cwd?: string }[] = [];
  let cwd: string | undefined, start = 0;
  const push = (end: number) => {
    const segment = command.slice(start, end).trim(), change = /^cd(?:\s+(.+))?$/u.exec(segment);
    if (change) {
      const target = change[1]?.replace(/^(["'])(.*)\1$/u, "$2");
      cwd = !target || target === "-" ? undefined
        : target.startsWith("/") ? path.posix.normalize(target)
          : cwd ? path.posix.normalize(path.posix.join(cwd, target)) : undefined;
    }
    spans.push({ start, end, cwd });
  };
  // shellCommands masks separators inside quotes and heredocs, so every remaining one starts a command.
  for (const match of command.matchAll(/&&|\|\||;|\n/gu)) { push(match.index!); start = match.index! + match[0].length; }
  push(command.length);
  return spans;
}

/** A script written or run relative to a resolved directory keeps its absolute identity across sessions. */
function samePath(first: string, second: string) {
  return first === second || first.endsWith("/" + second) || second.endsWith("/" + first);
}

/** Model navigation needs identities and proof, while code retains full positions and invocation bookkeeping. */
export function actorCatalog(components: JsonObject[]) {
  return components.map(({ component_index, kind, name, anonymous, components_content, source_evidence, message_indices, invoked_by }) => ({ actor_index: component_index, kind, name,
    ...(kind === "model" ? { anonymous: anonymous === true } : {}),
    ...(components_content ? { content: components_content } : {}), source_evidence, message_indices, invoked_by }));
}

/** Source identities only. This directory never decides which component caused a failure. */
export function processComponents(raw: RawInput, original: RawInput, inputId: string,
  positions: { trace_index: number; message_index: number }[], extracted?: JsonObject[]) {
  const entries: JsonObject[] = [];
  const pythonFiles: { trace: number; name: string; body: string; index: number; source: ReturnType<typeof evidenceSources>[number]; start: number; proof: JsonObject }[] = [];
  const add = (kind: string, name: string, message_indices: number[], source_evidence: JsonObject[], extra: JsonObject = {}) => {
    if (kind === "script") {
      // A relative path run from a skill directory and its absolute path name the same executed script.
      const same = entries.filter(entry => entry.kind === "script" && entry.name !== name && samePath(String(entry.name), name));
      if (same.length === 1) {
        if (name.length > String(same[0]!.name).length) same[0]!.name = name;
        name = String(same[0]!.name);
      }
    }
    const existing = entries.find(entry => entry.kind === kind && entry.name === name);
    if (existing) {
      existing.message_indices = [...new Set([...existing.message_indices as number[], ...message_indices])];
      existing.source_evidence = [...new Map([...(existing.source_evidence as JsonObject[]), ...source_evidence]
        .map(item => [(item.reference as JsonObject).evidence_id, item])).values()];
      if (extra.components_content && extra.components_content !== existing.components_content)
        existing.components_content = [existing.components_content, extra.components_content].filter(Boolean).join(" ");
      return;
    }
    entries.push({ ...extra, kind, name, message_indices: [...new Set(message_indices)], source_evidence });
  };
  const proof = (index: number, path: string) => evidenceSources(raw.messages[index]).filter(source =>
    source.kind === "text" && source.path === path && source.quotable !== false && source.text.length &&
    evidenceSources(original.messages[index]).some(other => other.kind === source.kind && other.path === source.path && other.text === source.text))
    .map(source => displayEvidence(cite(inputId, index, source, 0, Math.min(400, source.text.length))));
  const returned = new Map<number, number>();
  const owners = new Map<number, number>();
  const generatedFinals = new Set<number>();
  for (const trace_index of new Set(positions.map(point => point.trace_index))) {
    const indices = positions.flatMap((point, index) => point.trace_index === trace_index ? [index] : []);
    const final = indices.findLast(index => raw.messages[index]!.type === "final_answer" || raw.messages[index]!.role === "assistant");
    const model = indices.findLast(index => index < (final ?? -1) && raw.messages[index]!.type === "llm_turn");
    if (final !== undefined && model !== undefined) {
      const delivered = messageContentSources(raw.messages[final]).map(source => source.text).join("\n");
      const generated = messageContentSources({ content: raw.messages[model]!.output }).map(source => source.text).join("\n");
      if (delivered && generated === delivered) generatedFinals.add(trace_index);
    }
    for (const exchange of traceExchanges(indices.map(index => raw.messages[index]!))) {
      for (const index of exchange.return_indices) returned.set(indices[index]!, indices[exchange.request_index]!);
      if (exchange.planner_index !== null) owners.set(indices[exchange.request_index]!, indices[exchange.planner_index]!);
    }
    for (const origin of traceCallOrigins(indices.map(index => raw.messages[index]!)))
      owners.set(indices[origin.request_index]!, indices[origin.planner_index]!);
  }
  raw.messages.forEach((message, index) => {
    const tool = ["tool_call", "function_call", "tool_result", "function_call_output"].includes(String(message.type)) || message.role === "tool";
    const model = message.type === "llm_turn" || message.type === "final_answer" || message.role === "assistant";
    if (!tool && !model) return;
    if (model && message.type !== "llm_turn" && generatedFinals.has(positions[index]!.trace_index)) return;
    const origin = returned.get(index) ?? index, source = raw.messages[origin]!;
    const nameKey = ["agent_name", "node_name", "service_name", "tool_name", "name"].find(key =>
      typeof source[key] === "string" && String(source[key]).trim());
    const modelKey = typeof source.model === "string" && source.model.trim() ? "model" : undefined;
    const key = nameKey ?? modelKey ?? (typeof source.name === "string" && source.name.trim() ? "name" : undefined);
    const name = key ? String(source[key]) : `${tool ? "工具调用" : "模型调用"}（轮次${positions[index]!.trace_index}，消息${positions[index]!.message_index}）`;
    add(tool ? "tool" : "model", name, [origin, index], key ? proof(origin, `/${key}`) : proof(origin, source.type ? "/type" : "/role"),
      { ...(modelKey ? { model: source.model } : {}), identity_basis: "source_record",
        ...(model ? { anonymous: !key || key === "model" || isComponentLocator(name) || name === source.model } : {}),
        identity_status: key && !isComponentLocator(name) ? "named" : "located" });
    if (!tool || origin !== index) return;
    const sources = evidenceSources(source).filter(item => item.kind === "text" && item.quotable !== false &&
      evidenceSources(original.messages[index]).some(other => other.kind === item.kind && other.path === item.path && other.text === item.text));
    for (const item of sources) {
      if (name === "view_skill" && /^\/(?:input|arguments|parameters)\/(?:name|skill|skill_name)$/u.test(item.path) && item.text.trim())
        add("skill", item.text, [index], [displayEvidence(cite(inputId, index, item, 0, item.text.length))], { identity_basis: "source_record" });
      if (!/^\/(?:input|arguments|parameters)\/(?:command|cmd)$/u.test(item.path)) continue;
      const command = shellCommands(item.text), directories = commandDirectories(command);
      const trace = positions[index]!.trace_index;
      const directory = (position: number) => {
        let cwd: string | undefined;
        for (const span of directories) { if (span.start > position) break; cwd = span.cwd; }
        return cwd;
      };
      const scriptPath = (name: string, position: number) => {
        if (name.startsWith("/")) return path.posix.normalize(name);
        const cwd = directory(position);
        return cwd ? path.posix.normalize(path.posix.join(cwd, name)) : name;
      };
      for (const write of command.matchAll(/(?:^|&&|\|\||;|\n)\s*cat\s*(>>?)\s*["']?([^\s"'`<>()[\]{};$\\]+\.py)["']?\s*<<-?\s*(["']?)([A-Za-z_][\w-]*)\3/gu)) {
        const written = write[2]!, offset = write.index! + write[0].indexOf(written), name = scriptPath(written, offset);
        const start = item.text.indexOf("\n", write.index! + write[0].length) + 1;
        const end = item.text.indexOf("\n" + write[4], start - 1);
        if (!start || end < start) continue;
        const existing = pythonFiles.find(file => file.trace === trace && samePath(file.name, written));
        const body = item.text.slice(start, end);
        if (write[1] === ">>" && existing) existing.body += "\n" + body;
        else {
          if (existing) pythonFiles.splice(pythonFiles.indexOf(existing), 1);
          pythonFiles.push({ trace, name: existing?.name ?? name, body, index, source: item, start,
            proof: existing?.proof ?? displayEvidence(cite(inputId, index, item, offset, offset + written.length)) });
        }
      }
      const imports = (body: string, executed: JsonObject, parent?: typeof pythonFiles[number], visited = new Set<string>()) => {
        for (const match of body.matchAll(/^(?:from\s+([A-Za-z_]\w*)\s+import[^\n]*|import\s+([A-Za-z_]\w*)(?:\s+as\s+\w+)?\s*$)/gmu)) {
          const module = (match[1] ?? match[2]) + ".py";
          const candidates = pythonFiles.filter(file => file.trace === trace && (file.name === module || file.name.endsWith("/" + module)));
          const file = parent ? candidates.find(file => file.name.slice(0, file.name.lastIndexOf("/") + 1) === parent.name.slice(0, parent.name.lastIndexOf("/") + 1)) : candidates.length === 1 ? candidates[0] : undefined;
          if (!file || visited.has(file.name)) continue;
          visited.add(file.name);
          const proof = parent && parent.source.text.slice(parent.start + match.index!, parent.start + match.index! + match[0].length) === match[0]
            ? [displayEvidence(cite(inputId, parent.index, parent.source, parent.start + match.index!, parent.start + match.index! + match[0].length))] : [];
          add("script", file.name, [index], [file.proof, ...proof, executed], { identity_basis: "source_record" });
          imports(file.body, executed, file, visited);
        }
      };
      for (const invocation of command.matchAll(/(?:^|&&|\|\||;|\n)\s*(?:python(?:\d+(?:\.\d+)?)?|node|bash|sh|tsx|ts-node)\s+(?!-(?:c|m)(?:\s|$))(?:-[\w-]+\s+)*["']?([^\s"'`<>()[\]{};$\\]+\.(?:py|sh|js|mjs|ts))(?=["'\s;&]|$)/gu)) {
        const script = invocation[1]!, start = invocation.index! + invocation[0].lastIndexOf(script), name = scriptPath(script, start);
        const executed = displayEvidence(cite(inputId, index, item, start, start + script.length));
        const files = pythonFiles.filter(file => file.trace === trace && samePath(file.name, script));
        add("script", name, [...files.map(file => file.index), index], [...files.map(file => file.proof), executed], { identity_basis: "source_record" });
        if (files.length === 1) imports(files[0]!.body, executed, files[0]);
        if (/(?:^|\/)calc\.py$/u.test(script)) {
          const offset = invocation.index! + invocation[0].length, newline = command.indexOf("\n", offset);
          for (const argument of command.slice(offset, newline < 0 ? undefined : newline).matchAll(/--code-file(?:=|\s+)["']?([^\s"'`<>()[\]{};$\\]+\.py)(?=["'\s;&|]|$)/gu)) {
            const file = argument[1]!, begin = offset + argument.index! + argument[0].lastIndexOf(file);
            add("script", scriptPath(file, begin), [index], [displayEvidence(cite(inputId, index, item, begin, begin + file.length))], { identity_basis: "source_record" });
          }
        }
      }
      for (const inline of command.matchAll(/(?:^|&&|\|\||;|\n)\s*python(?:\d+(?:\.\d+)?)?\s+-c\s+(["'])((?:\\.|(?!\1)[\s\S])*)\1/gu))
        imports(inline[2]!, displayEvidence(cite(inputId, index, item, inline.index!, Math.min(item.text.length, inline.index! + inline[0].length, inline.index! + 400))));
      for (const read of command.matchAll(/(?:^|&&|\|\||;|\n)\s*(?:cat|bat|head|tail)\s+(?:-[\w-]+(?:\s+\d+)?\s+)*["']?([^\s"'`<>()[\]{};$\\]+\/(?:SKILL|ROUTE)\.md)(?=["'\s;&|]|$)/gu)) {
        const file = read[1]!, start = read.index! + read[0].lastIndexOf(file);
        const existing = file.endsWith("/SKILL.md") && entries.find(actor => actor.kind === "skill" && file.endsWith("/" + String(actor.name) + "/SKILL.md"));
        add("skill", existing ? String(existing.name) : file, [index],
          [displayEvidence(cite(inputId, index, item, start, start + file.length))], { identity_basis: "source_record" });
      }
    }
  });
  const recorded = entries.slice();
  if (extracted) entries.length = 0;
  for (const entry of extracted ?? []) {
    const evidence = compactSourceEvidence(entry);
    const indices = evidence.flatMap(item => typeof item.message_index === "number" ? [item.message_index] : []);
    const traces = new Set(indices.map(index => positions[index]!.trace_index));
    const ids = new Set(evidence.map(item => (item.reference as JsonObject).evidence_id));
    const matched = recorded.filter(actor => actor.kind === entry.components_kind &&
      (actor.source_evidence as JsonObject[]).some(item => ids.has((item.reference as JsonObject).evidence_id)));
    const messages = matched.length ? matched.flatMap(actor => (actor.message_indices as number[]).filter(index => traces.has(positions[index]!.trace_index))) : indices;
    add(String(entry.components_kind), String(entry.components_name), messages, evidence,
      { components_content: entry.components_content, identity_basis: "source_reference",
        anonymous: entry.components_kind === "model" && matched.length > 0 && matched.every(actor => actor.anonymous === true) });
  }
  return entries.map((entry, index) => ({ ...entry, component_index: index + 1, name: String(entry.name), kind: String(entry.kind),
    anonymous: entry.anonymous === true,
    identity_basis: String(entry.identity_basis),
    components_content: entry.components_content,
    message_indices: entry.message_indices as number[],
    source_evidence: entry.source_evidence as JsonObject[],
    invoked_by: [...new Set((entry.message_indices as number[]).flatMap(index => {
      const owner = owners.get(returned.get(index) ?? index);
      return owner === undefined ? [] : entries.flatMap((actor, index) => actor.kind === "model" &&
        actor !== entry && (actor.message_indices as number[]).includes(owner) ? [index + 1] : []);
    }))],
    positions: (entry.message_indices as number[]).map(index => ({ source_message_index: index, ...positions[index] })) }));
}
