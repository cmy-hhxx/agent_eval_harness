/**
 * Dashboard detail views.
 *
 * The browser entry owns lifecycle, state transitions, and event wiring. This
 * module owns the presentation seam for case inputs, task results, and the
 * structured result blocks so those concerns can evolve independently.
 */
export function groupCaseCandidates(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const side = /^([ab])_/i.exec(candidate.version)?.[1].toLowerCase()
      || /^([ab])组/i.exec(candidate.name || "")?.[1].toLowerCase();
    const id = side || `version:${candidate.version}`;
    if (!groups.has(id)) groups.set(id, {
      id, name: side ? `${side.toUpperCase()}组` : candidate.name || candidate.version, candidates: [],
    });
    groups.get(id).candidates.push(candidate);
  }
  const tier = (candidate) => /(?:_|组)fast$/i.test(candidate.version) || /fast$/i.test(candidate.name || "") ? 0
    : /(?:_|组)expert$/i.test(candidate.version) || /expert$/i.test(candidate.name || "") ? 1 : 2;
  const rank = (id) => id === "a" ? 0 : id === "b" ? 1 : 2;
  return [...groups.values()].sort((left, right) => rank(left.id) - rank(right.id) || left.id.localeCompare(right.id))
    .map((group) => ({ ...group, candidates: group.candidates.sort((left, right) => tier(left) - tier(right) || left.version.localeCompare(right.version)) }));
}

export function createDashboardViews({
  state,
  $, 
  document,
  loading,
  escapeHtml,
  label,
  stageLabel,
  dateText,
}) {
  const taskReasonText = (value) => ({
    "Agent ended without an accepted submission": "Agent 未提交可接受的结果",
  }[String(value)] || String(value));

  function inlineAnswer(value) {
    return escapeHtml(value)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[\^([^\]]+)\]/g, "<sup>[$1]</sup>");
  }

  function answerCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }

  function answerTableDivider(cells) {
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function answerHtml(value) {
    const lines = String(value ?? "").split(/\r?\n/);
    const blocks = [];
    let list = [];
    let table = [];
    const flushList = () => {
      if (!list.length) return;
      blocks.push(`<ul class="answer-list">${list.map((item) => `<li>${inlineAnswer(item)}</li>`).join("")}</ul>`);
      list = [];
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.map(answerCells);
      const hasDivider = rows.length > 1 && answerTableDivider(rows[1]);
      const head = rows[0] || [];
      const body = rows.slice(hasDivider ? 2 : 1);
      blocks.push(`<table class="answer-table"><thead><tr>${head.map((cell) => `<th>${inlineAnswer(cell)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inlineAnswer(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      table = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\|.*\|$/.test(trimmed) && trimmed.length > 1) {
        flushList();
        table.push(trimmed);
        continue;
      }
      flushTable();
      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bullet) {
        list.push(bullet[1]);
        continue;
      }
      flushList();
      if (!trimmed) continue;
      const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
      if (heading) {
        blocks.push(`<h4 class="answer-heading">${inlineAnswer(heading[2])}</h4>`);
      } else if (/^(?:---+|\*\s*\*\s*\*)$/.test(trimmed)) {
        blocks.push('<hr class="answer-rule" />');
      } else {
        blocks.push(`<p>${inlineAnswer(trimmed)}</p>`);
      }
    }
    flushList();
    flushTable();
    return blocks.join("");
  }

  function renderInput(inputId) {
    const input = state.inputViews[inputId];
    if (!inputId) return "";
    if (!input) return loading("正在读取问题与回答");
    if (input.error) return `<p class="inline-error">${escapeHtml(input.error)}</p>`;
    return `<div class="answer-block">${answerHtml(input.answer)}</div>`;
  }

  // Long text expands in place: there is only one copy of the question or field.
  function textHtml(value, key, question = false) {
    const text = String(value ?? "—");
    const collapsible = text.length > (question ? 180 : 360) || text.split("\n").length > 6;
    const expanded = state.expandedTexts.has(key);
    const id = `text-${encodeURIComponent(key)}`;
    return `<div class="expandable-text ${question ? "question-text" : ""}">
      <div id="${escapeHtml(id)}" class="text-content ${collapsible && !expanded ? "is-clamped" : ""}">${escapeHtml(text)}</div>
      ${collapsible ? `<button class="text-toggle" type="button" data-expand-text="${escapeHtml(key)}" aria-controls="${escapeHtml(id)}" aria-expanded="${expanded}">${expanded ? "收起" : "展开"}</button>` : ""}
    </div>`;
  }

  const fieldLabels = {
    has_standard_answer: "有标准答案", is_correct: "正确性", correctness_reason: "判定说明",
    correctness_evidence: "判定证据", task_analysis: "任务分析", summary: "总结", findings: "发现",
    task_type: "任务类型", goal: "目标", requirements: "要求", scoring_points: "得分点", red_flags: "红线",
    id: "标识", applies_to: "适用候选", acceptance_rule: "核验方法", criterion_id: "标准标识", criterion_ids: "标准引用",
    criterion_assessments: "逐条标准评估", core_assessment: "核心要求评估", core_failure_refs: "核心失败标准", status: "状态",
    review_requests: "复核请求", candidate: "候选", finding_indices: "发现索引",
    text: "内容", reason: "依据", evidence: "证据", assessment: "要求评估", problem: "问题归因",
    requirement_index: "要求索引", observation: "观察", evidence_status: "证据状态", impact: "影响",
    component: "组件", label: "问题名称", definition: "定义", ranking: "排名", models: "候选信息", assessments: "候选评估", evaluations: "归因结果",
    meets_core: "满足核心要求", decision_basis: "判决依据", tradeoff: "权衡", decisive_findings: "决定性发现",
    ground_truth: "标准答案", available: "可用", value: "答案", verdicts: "两两判决",
    finding_id: "归因标识", type: "类型", dimension: "维度", stage: "阶段", importance: "重要性",
    evidence_id: "证据坐标", message_index: "消息索引", quote: "引用原文", source: "来源", source_input_id: "来源输入",
    stage_trace: "阶段回溯", tools: "关联工具", candidate_tools: "候选工具", locations: "位置", tool_name: "工具名称", confidence: "置信度",
    result: "结果", winner: "胜出候选", winner_name: "胜出名称", winner_version: "胜出版本",
    rewritten: "改写后", assignments: "归类", new_classes: "新建类", merges: "合并", class_updates: "类维护",
    category_paths: "主题路径", deferred_reason: "延期理由",
    item_id: "问题条目", class_id: "问题类", new_class_key: "新类", key: "标识", closest_existing: "最接近的已有类", novelty: "新建理由", into: "合入类", from: "来源类",
  };
  const valueLabels = {
    type: { strength: "优点", problem: "缺点" },
    dimension: { correctness: "正确性", completeness: "完整性", instruction_following: "指令遵循",
      evidence_quality: "证据质量", reasoning: "推理", format: "格式", relevance: "相关性", efficiency: "效率" },
    importance: { high: "高", medium: "中", low: "低" },
    evidence_status: { established: "已建立", uncertain: "不确定" },
    status: { decided: "已裁决", needs_review: "待复核", met: "满足", partial: "部分满足", unmet: "不满足", unknown: "未确认", not_applicable: "不适用" },
    stage: { context_recall: "上下文", reasoning: "推理", execution: "执行", final_answer: "最终回答" },
    result: { win: "胜出", both_good: "都好", both_bad: "都差" },
    confidence: { high: "高", medium: "中", none: "无" },
    source: { evidence_message: "证据消息", quote_reference: "引用定位", same_turn_tool_chain: "同轮工具链", none: "无" },
  };
  const fieldLabel = (key) => fieldLabels[key]
    ? `<span>${escapeHtml(fieldLabels[key])}</span><code>${escapeHtml(key)}</code>`
    : `<span>${escapeHtml(key.replaceAll("__vs__", " / "))}</span>`;
  function scalar(value, key) {
    if (value === "") return "空";
    if (value === null) return key === "is_correct" || key === "meets_core" ? "未判定" : "无";
    if (typeof value === "boolean") return key === "is_correct" ? (value ? "正确" : "错误") : (value ? "是" : "否");
    return valueLabels[key]?.[value] || value;
  }

  function fieldsHtml(value, path, rewrites) {
    return `<dl class="schema-fields">${Object.entries(value).map(([key, item]) =>
      `<div class="schema-field"><dt>${fieldLabel(key)}</dt><dd>${valueHtml(item, `${path}.${key}`, key, rewrites)}</dd></div>`).join("")}</dl>`;
  }

  function valueHtml(value, path, key, rewrites) {
    if (Array.isArray(value)) {
      if (!value.length) return `<span class="muted">${key === "component" ? "待定位" : "无"}</span>`;
      if (key === "component")
        return `<span class="finding-tags">${value.map((component) => `<span>${escapeHtml(component)}</span>`).join("")}</span>`;
      if (key === "evidence" || key === "correctness_evidence")
        return `<ul class="evidence-list">${value.map((item, index) => `<li>${fieldsHtml(item, `${path}.${index}`, rewrites)}</li>`).join("")}</ul>`;
      if (key === "decisive_findings")
        return `<ul class="schema-list">${value.map((item) => `<li>${escapeHtml(item.candidate)} · findings[${escapeHtml(item.finding_index)}]</li>`).join("")}</ul>`;
      return `<ol class="schema-list"${key === "requirements" ? ' start="0"' : ""}>${value.map((item, index) => `<li>${Array.isArray(item) ? textHtml(item.join(" · "), `${path}.${index}`) : valueHtml(item, `${path}.${index}`, key, rewrites)}</li>`).join("")}</ol>`;
    }
    if (value && typeof value === "object") return fieldsHtml(value, path, rewrites);
    if (rewrites?.has(path))
      return `<div class="rewrite-pair"><div class="rewrite-original"><h6>原文</h6>${textHtml(scalar(value, key), path)}</div><div class="rewrite-polished"><h6>改写</h6>${textHtml(rewrites.get(path), `${path}.rewritten`)}</div></div>`;
    return textHtml(scalar(value, key), path);
  }

  function sectionHtml(key, body) {
    return `<section class="schema-section"><h5>${fieldLabel(key)}</h5>${body}</section>`;
  }

  function taskAnalysisHtml(analysis, path, rewrites) {
    const { requirements, scoring_points, red_flags, ...metadata } = analysis;
    const candidates = new Map((state.caseDetail?.candidates || []).map((candidate) =>
      [candidate.input_id, candidate.name || candidate.version]));
    const groups = { requirements, scoring_points, red_flags };
    return `<div class="task-analysis">${fieldsHtml(metadata, path, rewrites)}${Object.entries(groups).map(([kind, criteria]) =>
      `<section class="criteria-group ${criteria.length ? "" : "is-empty"}" data-criteria-group="${kind}"><h5>${fieldLabel(kind)}<span class="criteria-count">${criteria.length} 项</span></h5>${criteria.map((criterion, index) => {
        const criterionPath = `${path}.${kind}.${index}`;
        const rulePath = `${criterionPath}.acceptance_rule`;
        const scope = criterion.applies_to.length ? criterion.applies_to.map((id) => candidates.get(id) || id).join(" / ") : "全部候选";
        return `<article class="criterion" data-criterion-kind="${kind}" data-criterion-index="${index}">
          <div class="criterion-heading"><h6 class="criterion-identity"><code>${kind}[${index}]</code><strong>${escapeHtml(criterion.id)}</strong></h6><span class="criterion-scope" title="${escapeHtml(criterion.applies_to.join(" / "))}">适用候选 · ${escapeHtml(scope)}</span></div>
          <div class="criterion-text"><div class="criterion-text-label">原文 <code>text</code></div>${textHtml(criterion.text, `${criterionPath}.text`)}</div>
          <details class="criterion-rule" data-criterion-rule="${escapeHtml(rulePath)}" ${state.expandedTexts.has(rulePath) ? "open" : ""}><summary>${fieldLabel("acceptance_rule")}</summary><div class="text-content">${escapeHtml(criterion.acceptance_rule)}</div></details>
        </article>`;
      }).join("")}</section>`).join("")}</div>`;
  }

  function findingsNav(findings, taskId) {
    return `<nav class="findings-nav" id="${escapeHtml(`findings-${taskId}`)}" tabindex="-1" aria-label="发现目录"><div class="findings-nav-heading">发现目录 <span>${findings.length}</span></div><div class="findings-nav-groups">${["strength", "problem"].map((type) => {
      const entries = findings.map((finding, index) => ({ finding, index })).filter(({ finding }) => finding.type === type);
      return `<section class="findings-nav-group"><h6 class="finding-type ${type}">${valueLabels.type[type]} <span>${entries.length}</span></h6>${entries.length
        ? `<ol>${entries.map(({ finding, index }) => `<li><a data-finding-target="${escapeHtml(`finding-${taskId}.findings.${index}`)}" href="#${encodeURIComponent(`finding-${taskId}.findings.${index}`)}"><span class="finding-index">${index}</span><span class="finding-nav-text">${escapeHtml(finding.text)}</span><span class="finding-importance">${escapeHtml(scalar(finding.importance, "importance"))}</span></a></li>`).join("")}</ol>`
        : '<p class="muted">无</p>'}</section>`;
    }).join("")}</div></nav>`;
  }

  function findingMetadataHtml(finding) {
    return [["dimension", "维度"], ["stage", "阶段"], ["importance", "重要性"]]
      .filter(([key]) => finding[key] != null)
      .map(([key, title]) => `<span>${title} · ${escapeHtml(scalar(finding[key], key))}</span>`).join("");
  }

  function findingHtml(finding, index, path, rewrites, taskId) {
    const { finding_id, type, dimension, stage, importance, ...fields } = finding;
    return `<details class="finding" id="${escapeHtml(`finding-${path}`)}" data-finding="${escapeHtml(path)}" ${state.openFindings.has(path) ? "open" : ""}><summary><span class="finding-head"><span class="finding-type ${escapeHtml(type)}">${escapeHtml(scalar(type, "type"))}</span><strong>findings[${index}]</strong><code>${escapeHtml(finding_id)}</code></span><span class="finding-preview">${escapeHtml(rewrites.get(`${path}.text`) ?? finding.text)}</span><span class="finding-tags">${findingMetadataHtml(finding)}</span></summary>
      <div class="finding-content"><a class="findings-return" href="#${encodeURIComponent(`findings-${taskId}`)}">返回目录</a>${fieldsHtml(fields, path, rewrites)}</div></details>`;
  }

  function attributionHtml(evaluation, path, rewritten) {
    const rewrites = new Map((rewritten?.rewrites || []).map((item) => [`${path}.${item.path}`, item.text]));
    const { summary, task_analysis, findings = [], ...correctness } = evaluation;
    return findingsNav(findings, path)
      + sectionHtml("summary", valueHtml(summary, `${path}.summary`, "summary", rewrites))
      + fieldsHtml(correctness, path, rewrites)
      + (task_analysis ? sectionHtml("task_analysis", taskAnalysisHtml(task_analysis, `${path}.task_analysis`)) : "")
      + sectionHtml("findings", findings.map((finding, index) => findingHtml(finding, index, `${path}.findings.${index}`, rewrites, path)).join(""));
  }

  function comparisonText(value, path, rewrites) {
    const polished = rewrites.get(path);
    return `<div class="comparison-copy">${textHtml(polished ?? value, polished ? `${path}.rewritten` : path)}${polished !== undefined
      ? `<details class="comparison-original"><summary>原文</summary>${textHtml(value, path)}</details>` : ""}</div>`;
  }

  function comparisonFindingHtml(evaluation, findingIndex, version, rowIndex, taskId) {
    const finding = evaluation.findings[findingIndex];
    const path = `${taskId}.decision_basis.comparisons.${rowIndex}.assessments.${version}.findings.${findingIndex}`;
    const prefix = `findings.${findingIndex}.`;
    const rewrites = new Map((evaluation.rewritten?.rewrites || []).filter((item) => item.path.startsWith(prefix))
      .map((item) => [`${path}.${item.path.slice(prefix.length)}`, item.text]));
    const { finding_id, type, dimension, stage, importance, ...fields } = finding;
    return `<details class="comparison-finding" data-comparison-finding="${escapeHtml(path)}" data-finding-index="${findingIndex}" ${state.expandedTexts.has(path) ? "open" : ""}>
      <summary><span class="finding-head"><strong>归因 #${findingIndex}</strong><code>${escapeHtml(finding_id)}</code></span><span class="finding-tags">${findingMetadataHtml(finding)}</span><span class="finding-preview">${escapeHtml(rewrites.get(`${path}.text`) ?? finding.text)}</span></summary>
      <div class="comparison-finding-content">${fieldsHtml({ type, ...fields }, path, rewrites)}</div>
    </details>`;
  }

  function comparisonHtml(row, taskId, rewrites) {
    const name = (version) => row.models?.[version]?.version || version;
    const versions = groupCaseCandidates(Object.keys(row.assessments).map((version) => ({ version, name: name(version) })))
      .flatMap((group) => group.candidates.map((candidate) => candidate.version));
    const priorities = { high: 0, medium: 1, low: 2 };
    const rows = row.decision_basis.comparisons.map((item, index) => ({ item, index }))
      .sort((a, b) => priorities[a.item.importance] - priorities[b.item.importance]);
    const verdicts = row.status === "needs_review" ? "<strong>待复核</strong>" : Object.entries(row.verdicts || {}).map(([pair, verdict]) => `<span>${escapeHtml(pair.split("__vs__").map(name).join(" / "))} · <strong>${escapeHtml(verdict.result === "win" ? `${verdict.winner_name}更好` : scalar(verdict.result, "result"))}</strong></span>`).join("");
    return `<section class="comparison-decision"><h5>裁决</h5><div class="comparison-verdicts">${verdicts}</div>${comparisonText(row.decision_basis.tradeoff, `${taskId}.decision_basis.tradeoff`, rewrites)}</section>
      <section class="schema-section"><h5>逐项对照</h5><div class="comparison-scroll" tabindex="0" role="region" aria-label="各模型逐项对照"><table class="comparison-table"><thead><tr><th scope="col">比较点</th>${versions.map((version) => `<th scope="col">${escapeHtml(name(version))}</th>`).join("")}</tr></thead><tbody>${rows.map(({ item, index }) => `<tr data-comparison-index="${index}"><th scope="row"><code class="comparison-index">comparisons[${index}]</code><strong>${escapeHtml(item.aspect)}</strong><span class="comparison-importance">重要性 · ${escapeHtml(scalar(item.importance, "importance"))}</span><span class="comparison-importance">直接标准引用 · ${escapeHtml(item.criterion_ids.length ? item.criterion_ids.join(" / ") : "0 项")}</span><span class="comparison-better-candidates">${escapeHtml(item.better_candidates.length ? `更优 · ${item.better_candidates.map(name).join(" / ")}` : "未区分优劣")}</span></th>${versions.map((version) => {
        const assessment = item.assessments[version];
        const evaluation = row.evaluations[version];
        const observed = assessment.finding_indices.flatMap(i => evaluation?.findings[i] ? [evaluation.findings[i]] : []);
        const hasRequirement = item.criterion_ids.length || observed.some(finding => finding.assessment?.requirement_index != null);
        const oneSided = !hasRequirement && !observed.length && Object.values(item.assessments).some(cell => cell.finding_indices.length);
        const stateLabel = assessment.status === "unknown" ? (oneSided ? "未核查此项" : "证据不足")
          : assessment.status === "met" && !hasRequirement ? (assessment.evidence_status !== "established" ? "观察待核" : observed.length
            ? observed.every(finding => finding.type === "problem") ? "已确认问题"
              : observed.every(finding => finding.type === "strength") ? "已确认优点" : "已确认观察"
            : "已记录") : scalar(assessment.status, "status");
        const links = assessment.finding_indices.map((findingIndex) => {
          const target = `finding-${taskId}.evaluations.${version}.findings.${findingIndex}`;
          return `<a data-finding-target="${escapeHtml(target)}" href="#${encodeURIComponent(target)}">归因 #${findingIndex}</a>`;
        }).join("");
        const findings = assessment.finding_indices.filter((findingIndex) => evaluation?.findings[findingIndex])
          .map((findingIndex) => comparisonFindingHtml(evaluation, findingIndex, version, index, taskId)).join("");
        return `<td data-candidate="${escapeHtml(version)}">${item.better_candidates.includes(version) ? '<strong class="comparison-advantage">更优</strong>' : ""}<div class="comparison-cell-states"><span class="comparison-status" data-status="${escapeHtml(assessment.status)}">状态 · ${escapeHtml(stateLabel)}</span><span class="comparison-evidence-status" data-evidence-status="${escapeHtml(assessment.evidence_status)}">证据 · ${escapeHtml(scalar(assessment.evidence_status, "evidence_status"))}</span></div>${comparisonText(assessment.summary, `${taskId}.decision_basis.comparisons.${index}.assessments.${version}.summary`, rewrites)}<div class="comparison-references">关联归因 · ${assessment.finding_indices.length} 项${links}</div>${findings}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div></section>`;
  }

  function renderResult(task) {
    const row = task.result;
    if (!row) return task.status === "succeeded" ? '<p class="muted">写入中</p>' : "";
    const rewrites = new Map((row.rewritten?.rewrites || []).map((item) => [`${task.id}.${item.path}`, item.text]));
    let body = "";
    if (task.stage === "attribution") {
      body = attributionHtml(row.evaluation, task.id, row.rewritten);
    } else if (task.stage === "comparison") {
      body = comparisonHtml(row, task.id, rewrites);
      body += `<details class="comparison-details"><summary>裁决明细</summary>` + ["status", "review_requests", "models", "task_analysis", "ground_truth", "ranking", "assessments", "verdicts"]
        .filter((key) => row[key] !== undefined)
        .map((key) => sectionHtml(key, key === "task_analysis" ? taskAnalysisHtml(row[key], `${task.id}.${key}`, rewrites)
          : valueHtml(row[key], `${task.id}.${key}`, key, rewrites))).join("")
        + sectionHtml("decisive_findings", valueHtml(row.decision_basis.decisive_findings, `${task.id}.decision_basis.decisive_findings`, "decisive_findings", rewrites)) + "</details>";
      const evaluationGroups = groupCaseCandidates(Object.keys(row.evaluations).map((version) => ({ version, name: row.models?.[version]?.version || version })));
      body += `<details class="comparison-details comparison-attributions" ${[...state.openFindings].some((path) => path.startsWith(`${task.id}.evaluations.`)) ? "open" : ""}><summary>归因明细</summary><div class="case-columns">` + evaluationGroups.map((group) =>
        `<section class="case-column" data-version-group="${escapeHtml(group.id)}"><h4 class="case-column-heading">${escapeHtml(group.name)}</h4>${group.candidates.map(({ version, name }) => {
          const { rewritten, ...evaluation } = row.evaluations[version];
          return `<section class="model-evaluation"><h6>${escapeHtml(name)}</h6>${attributionHtml(evaluation, `${task.id}.evaluations.${version}`, rewritten)}</section>`;
        }).join("")}</section>`).join("") + "</div></details>";
    } else if (task.stage === "criteria") {
      body = taskAnalysisHtml(row.result, task.id, rewrites);
    } else if (task.stage === "clustering") {
      body = fieldsHtml(row.result, task.id, rewrites);
    }
    if (task.stage !== "comparison") body = `<h4 class="output-heading">${rewrites.size ? "原文与改写" : "原始输出"}</h4>${body}`;
    return `<div class="result-body">${body}</div>`;
  }

  function taskHtml(task) {
    const open = state.openTasks.has(task.id);
    const versions = groupCaseCandidates(task.versions.map((version) => ({
      version, name: state.caseDetail?.candidates.find((candidate) => candidate.version === version)?.name || version,
    }))).flatMap((group) => group.candidates.map((candidate) => candidate.name));
    const scope = [versions.join(" / "), task.stage === "clustering" ? task.batch_id : "", task.shard != null ? `分片 ${task.shard + 1}` : ""].filter(Boolean).join(" · ");
    const hasReview = state.caseDetail?.tasks.some((other) => other.review_of?.task_id === task.id);
    const phase = task.stage === "attribution"
      ? task.review_of
        ? `${stageLabel(task.stage)}复核 · 第 ${task.review_of.round} 轮`
        : hasReview ? `首次${stageLabel(task.stage)}` : ""
      : "";
    const displayStatus = task.stage === "comparison" && task.status === "succeeded" && task.result_status === "needs_review"
      ? "needs_review" : task.status;
    const meta = [
      `${task.attempts} 次尝试`,
      task.duration_ms != null ? `${Math.round(task.duration_ms / 1000)} 秒` : "",
      task.last_progress_at ? dateText(task.last_progress_at) : "",
    ].filter(Boolean);
    const reviewReasons = task.review_of?.reasons.length
      ? `<section class="task-review"><h4>复核原因</h4><ul class="task-review-reasons">${task.review_of.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>` : "";
    return `<details class="task-detail" data-task="${escapeHtml(task.id)}" ${open ? "open" : ""}>
      <summary><span class="task-heading"><strong class="task-name">${escapeHtml(scope)}</strong>${phase ? `<span class="task-phase">${escapeHtml(phase)}</span>` : ""}</span><span class="task-status ${escapeHtml(displayStatus)}">${escapeHtml(label(displayStatus))}</span></summary>
      <div class="task-content"><div class="task-meta-row">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
        ${reviewReasons}
        ${task.reason ? `<p class="inline-error">${escapeHtml(taskReasonText(task.reason))}</p>` : ""}
        ${task.status === "succeeded" ? `<div class="task-result" data-result-for="${escapeHtml(task.id)}">${resultNodeHtml(task.id, open)}</div>` : ""}
      </div></details>`;
  }

  function renderDetail() {
    const detail = state.caseDetail;
    if (!detail) {
      $("#case-detail").innerHTML = state.selectedCase ? loading("正在读取样本详情") : "";
      return;
    }
    const candidates = detail.candidates || [];
    const inputGroups = groupCaseCandidates(candidates);
    const inputs = inputGroups.map((group) => {
      const selected = state.selectedInputs[group.id] || group.candidates[0].input_id;
      const tabs = group.candidates.map((candidate) => `<button type="button" class="candidate-tab ${selected === candidate.input_id ? "selected" : ""}" aria-pressed="${selected === candidate.input_id}" data-input="${escapeHtml(candidate.input_id)}" data-input-group="${escapeHtml(group.id)}">${escapeHtml(candidate.name || candidate.version)}</button>`).join("");
      return `<section class="case-column" data-version-group="${escapeHtml(group.id)}"><h4 class="case-column-heading">${escapeHtml(group.name)}</h4><div class="candidate-tabs" role="group" aria-label="${escapeHtml(group.name)}版本">${tabs}</div><div class="input-view">${renderInput(selected)}</div></section>`;
    }).join("");
    const standardAnswer = detail.ground_truth?.available
      ? `<section class="standard-answer"><h3>标准答案</h3>${textHtml(typeof detail.ground_truth.value === "string" ? detail.ground_truth.value : JSON.stringify(detail.ground_truth.value, null, 2), "ground_truth")}</section>` : "";
    $("#case-detail").innerHTML = `<header class="detail-heading"><div class="section-heading"><h2>问题</h2><span class="case-identity">${escapeHtml(detail.batch_id)} / ${escapeHtml(detail.case_id)}</span></div>${textHtml(detail.question, "question", true)}${standardAnswer}</header>
      <details class="detail-section input-disclosure" ${state.inputOpen ? "open" : ""}><summary><strong>评测输入</strong><span class="section-meta">${candidates.length} 个版本</span></summary><div class="input-content case-columns">${inputs}</div></details>
      ${["criteria", "attribution", "comparison"].map((stage) => {
        const tasks = detail.tasks.filter((task) => task.stage === stage);
        if (!tasks.length) return "";
        const body = stage === "attribution" ? `<div class="case-columns">${groupCaseCandidates(tasks.map((task) => ({
          version: task.versions[0], name: candidates.find((candidate) => candidate.version === task.versions[0])?.name || task.versions[0], task,
        }))).map((group) => `<section class="case-column" data-version-group="${escapeHtml(group.id)}"><h4 class="case-column-heading">${escapeHtml(group.name)}</h4><div class="task-list">${group.candidates.map(({ task }) => taskHtml(task)).join("")}</div></section>`).join("")}</div>`
          : `<div class="task-list">${tasks.map((task) => taskHtml(task)).join("")}</div>`;
        return `<section class="detail-section task-group" data-stage="${stage}"><h3>${escapeHtml(stageLabel(stage))}</h3>${body}</section>`;
      }).join("")}`;
  }

  /** Attach the lazily loaded result to its task metadata. */
  function taskView(taskId) {
    const task = [...(state.caseDetail?.tasks || []), ...(state.clusteringTasks || [])].find((task) => task.id === taskId);
    return task ? { ...task, result: state.taskResults[taskId]?.result ?? null } : undefined;
  }

  function resultNodeHtml(taskId, open) {
    const cached = state.taskResults[taskId];
    if (cached?.error) return `<p class="inline-error">${escapeHtml(cached.error)}</p>`;
    const view = taskView(taskId);
    if (!view) return "";
    return cached ? renderResult(view) : open ? loading("正在读取结果") : "";
  }

  function renderTaskResult(taskId) {
    const node = [...document.querySelectorAll("[data-result-for]")].find((item) => item.dataset.resultFor === taskId);
    if (!node) return;
    const cached = state.taskResults[taskId];
    if (cached?.error) { node.innerHTML = `<p class="inline-error">${escapeHtml(cached.error)}</p>`; return; }
    const view = taskView(taskId);
    node.innerHTML = view && cached ? renderResult(view) : loading("正在读取结果");
  }

  function renderClustering() {
    $("#clustering-tasks").innerHTML = state.clusteringTasks === null
      ? loading("正在读取聚类")
      : state.clusteringTasks.length ? state.clusteringTasks.map(taskHtml).join("") : '<p class="empty-state">无聚类任务</p>';
  }
  return { renderDetail, renderTaskResult, renderClustering };
}
