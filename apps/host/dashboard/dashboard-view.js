/**
 * Dashboard detail views.
 *
 * The browser entry owns lifecycle, state transitions, and event wiring. This
 * module owns the presentation seam for case inputs, task results, and the
 * structured result blocks so those concerns can evolve independently.
 */
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

  function renderInput() {
    const input = state.inputView;
    if (!state.selectedInput) return "";
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
    text: "内容", reason: "依据", evidence: "证据", assessment: "要求评估", problem: "问题归因",
    requirement_index: "要求索引", observation: "观察", evidence_status: "证据状态", impact: "影响",
    component: "组件", label: "问题名称", definition: "定义", ranking: "排名", models: "候选信息", assessments: "候选评估",
    meets_core: "满足核心要求", decision_basis: "判决依据", tradeoff: "权衡", decisive_findings: "决定性发现",
    ground_truth: "标准答案", available: "可用", value: "答案", verdicts: "两两判决",
    result: "结果", winner: "胜出候选", winner_name: "胜出名称", winner_version: "胜出版本",
    rewrites: "改写内容",
  };
  const valueLabels = {
    type: { strength: "优点", problem: "问题" },
    dimension: { correctness: "正确性", completeness: "完整性", instruction_following: "指令遵循",
      evidence_quality: "证据质量", reasoning: "推理", format: "格式", relevance: "相关性", efficiency: "效率" },
    importance: { high: "高", medium: "中", low: "低" },
    evidence_status: { established: "已建立", uncertain: "不确定" },
    stage: { context_recall: "上下文", reasoning: "推理", execution: "执行", final_answer: "最终回答" },
    result: { win: "胜出", both_good: "都好", both_bad: "都差" },
  };
  const fieldLabel = (key) => fieldLabels[key]
    ? `<span>${escapeHtml(fieldLabels[key])}</span><code>${escapeHtml(key)}</code>`
    : `<span>${escapeHtml(key.replaceAll("__vs__", " / "))}</span>`;
  function scalar(value, key) {
    if (value === "") return "空";
    if (value === null) return key === "is_correct" ? "未判定" : "无";
    if (typeof value === "boolean") return key === "is_correct" ? (value ? "正确" : "错误") : (value ? "是" : "否");
    return valueLabels[key]?.[value] || value;
  }

  function fieldsHtml(value, path) {
    return `<dl class="schema-fields">${Object.entries(value).map(([key, item]) =>
      `<div class="schema-field"><dt>${fieldLabel(key)}</dt><dd>${valueHtml(item, `${path}.${key}`, key)}</dd></div>`).join("")}</dl>`;
  }

  function valueHtml(value, path, key) {
    if (Array.isArray(value)) {
      if (!value.length) return '<span class="muted">无</span>';
      if (key === "evidence" || key === "correctness_evidence")
        return `<ul class="evidence-list">${value.map((item, index) => `<li><span class="evidence-location">消息 #${escapeHtml(item.message_index)}</span>${textHtml(item.quote, `${path}.${index}.quote`)}</li>`).join("")}</ul>`;
      if (key === "decisive_findings")
        return `<ul class="schema-list">${value.map((item) => `<li>${escapeHtml(item.candidate)} · findings[${escapeHtml(item.finding_index)}]</li>`).join("")}</ul>`;
      return `<ol class="schema-list"${key === "requirements" ? ' start="0"' : ""}>${value.map((item, index) => `<li>${textHtml(Array.isArray(item) ? item.join(" · ") : item, `${path}.${index}`)}</li>`).join("")}</ol>`;
    }
    if (value && typeof value === "object") return fieldsHtml(value, path);
    return textHtml(scalar(value, key), path);
  }

  function sectionHtml(key, body) {
    return `<section class="schema-section"><h5>${fieldLabel(key)}</h5>${body}</section>`;
  }

  function findingHtml(finding, index, path) {
    const metadata = [["type", "类型"], ["dimension", "维度"], ["stage", "阶段"], ["importance", "重要性"]]
      .filter(([key]) => finding[key] != null)
      .map(([key, title]) => `<span>${key === "type" ? "" : `${title} · `}${escapeHtml(scalar(finding[key], key))}</span>`).join("");
    const { finding_id, type, dimension, stage, importance, ...fields } = finding;
    return `<article class="finding"><header class="finding-head"><strong>findings[${index}]</strong><code>${escapeHtml(finding_id)}</code></header>
      <div class="finding-tags">${metadata}</div>${fieldsHtml(fields, path)}</article>`;
  }

  function renderResult(task) {
    const row = task.result;
    if (!row) return task.status === "succeeded" ? '<p class="muted">写入中</p>' : "";
    let body = "";
    if (task.stage === "attribution") {
      const { summary, task_analysis, findings = [], ...correctness } = row.evaluation;
      body = sectionHtml("summary", textHtml(summary, `${task.id}.summary`))
        + fieldsHtml(correctness, task.id)
        + sectionHtml("task_analysis", fieldsHtml(task_analysis, `${task.id}.task_analysis`))
        + sectionHtml("findings", findings.map((finding, index) => findingHtml(finding, index, `${task.id}.findings.${index}`)).join(""));
    } else if (task.stage === "comparison") {
      body = ["models", "task_analysis", "ground_truth", "ranking", "assessments", "decision_basis", "verdicts"]
        .filter((key) => row[key] !== undefined)
        .map((key) => sectionHtml(key, valueHtml(row[key], `${task.id}.${key}`, key))).join("");
    } else if (task.stage === "rewrite") {
      body = sectionHtml("rewrites", row.rewrites.map((item, index) =>
        `<article class="rewrite-item"><h6>${escapeHtml(item.id)}</h6>${textHtml(item.text, `${task.id}.rewrites.${index}.text`)}</article>`).join(""));
    }
    return `<div class="result-body"><h4 class="output-heading">评测输出</h4>${body}</div>`;
  }

  function taskHtml(task, tasks) {
    const open = state.openTasks.has(task.id);
    const source = tasks.find((item) => item.id === task.rewrite_of?.taskId);
    const versions = (source || task).versions.join(" / ");
    const scope = task.stage === "rewrite" ? `${stageLabel(source?.stage || task.rewrite_of?.stage)} · ${versions}` : versions;
    const meta = [
      `${task.attempts} 次尝试`,
      task.duration_ms != null ? `${Math.round(task.duration_ms / 1000)} 秒` : "",
      task.last_progress_at ? dateText(task.last_progress_at) : "",
    ].filter(Boolean);
    return `<details class="task-detail" data-task="${escapeHtml(task.id)}" ${open ? "open" : ""}>
      <summary><strong class="task-name">${escapeHtml(scope)}</strong><span class="task-status ${escapeHtml(task.status)}">${escapeHtml(label(task.status))}</span></summary>
      <div class="task-content"><div class="task-meta-row">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
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
    const inputs = candidates.map((candidate) => `<button type="button" class="candidate-tab ${state.selectedInput === candidate.input_id ? "selected" : ""}" aria-pressed="${state.selectedInput === candidate.input_id}" data-input="${escapeHtml(candidate.input_id)}">${escapeHtml(candidate.name || candidate.version)}</button>`).join("");
    $("#case-detail").innerHTML = `<header class="detail-heading"><div class="section-heading"><h2>问题</h2><span class="case-identity">${escapeHtml(detail.batch_id)} / ${escapeHtml(detail.case_id)}</span></div>${textHtml(detail.question, "question", true)}</header>
      <details class="detail-section input-disclosure" ${state.inputOpen ? "open" : ""}><summary><strong>评测输入</strong><span class="section-meta">${candidates.length} 个版本</span></summary><div class="input-content"><div class="candidate-tabs" role="group" aria-label="选择版本">${inputs}</div><div class="input-view">${renderInput()}</div></div></details>
      ${["attribution", "comparison", "rewrite"].map((stage) => {
        const tasks = detail.tasks.filter((task) => task.stage === stage);
        if (!tasks.length) return "";
        return `<section class="detail-section task-group"><h3>${escapeHtml(stageLabel(stage))}</h3><div class="task-list">${tasks.map((task) => taskHtml(task, detail.tasks)).join("")}</div></section>`;
      }).join("")}`;
  }

  /** Attach the lazily loaded result to its task metadata. */
  function taskView(taskId) {
    const detail = state.caseDetail;
    if (!detail) return undefined;
    const task = detail.tasks.find((task) => task.id === taskId);
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

  return { renderDetail, renderTaskResult };
}
