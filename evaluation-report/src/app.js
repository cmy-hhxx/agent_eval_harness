(() => {
  'use strict';
  const report = window.EvaluationReportData;
  const $ = id => document.getElementById(id);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let toastTimer;

  function notify(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2400);
  }

  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function activatePage(page, updateHash = true, animate = true) {
    if (!['flow', 'rules', 'prompts', 'experiments'].includes(page)) page = 'flow';
    document.querySelectorAll('.page').forEach(element => { element.hidden = element.id !== `page-${page}`; });
    document.querySelectorAll('[data-page]').forEach(button => {
      if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (updateHash) history.replaceState(null, '', `#${page}`);
    window.scrollTo(0, 0);
    if (animate) window.ReportMotion.reveal($(`page-${page}`), { distance: 3, duration: 140 });
  }

  function renderCase() {
    const item = report.mechanismCase;
    const source = item.provenance;
    $('caseExample').innerHTML = `<h2>银河证券 · 01868</h2><p class="example-question">${escape(item.question)}</p><p class="case-reference">标准答案 <strong>${escape(item.reference)}</strong></p><div class="answer-comparison">${item.candidates.map(candidate => `<div><h3>${escape(candidate.source)} · ${escape(candidate.model)}</h3><strong class="example-number">${escape(candidate.result)}</strong><span>个百分点</span><p>${escape(candidate.formula)}</p><span>${candidate.usable?'核心可用':'核心不可用'}</span></div>`).join('')}</div><div class="example-result"><strong>回答②胜</strong><span>按本题标准，区间中值近似的 −0.60 与 −0.6 一致。</span></div><p class="case-origin" title="${escape(source.comparison.complete_result.file)}:${source.comparison.complete_result.jsonl_line_1_based}">原判 ${escape(source.evaluator_version_for_this_case)} · ${escape(source.judge)}<br>题库批次 ${escape(source.case.batch_id)} · 第 320 条</p>`;
  }

  function renderPrompts() {
    const resources = report.meta.promptResources;
    $('promptSummary').innerHTML = `<span>提示词快照 <strong>${escape(report.meta.evaluator)}</strong></span><span>阶段原文 <strong>${resources.stage}</strong></span><span>共用片段 <strong>${resources.shared}</strong></span><span>工具说明 <strong>${resources.tools}</strong></span>`;
    $('promptRows').innerHTML = report.promptBriefs.map(brief => `<tr><th scope="row"><strong>${escape(brief.title)}</strong></th><td class="prompt-quote">${escape(brief.quote)}</td><td><ul class="plain-list">${brief.rules.map(rule => `<li>${escape(rule)}</li>`).join('')}</ul></td></tr>`).join('');
    $('sharedPrompts').textContent = report.prompts.filter(prompt => prompt.group === '共用文案').map(prompt => prompt.name).join(' / ');
    $('toolPrompts').innerHTML = report.prompts.filter(prompt => prompt.group === '工具说明').map(prompt => `<code>${escape(prompt.name)}</code>`).join(' ');
  }

  function renderEvidence() {
    const run = report.metrics.runs[0];
    const total = run.sample.planned_comparisons;
    const complete = run.formal_results.comparison_rows;
    const completedCases = run.formal_results.distinct_cases_with_comparison;
    const stages = [
      ['共同标准', run.formal_results.criteria_rows, run.sample.business_cases],
      ['独立归因', run.formal_results.attribution_rows, run.sample.valid_answer_inputs],
      ['正式对局', complete, total],
    ];
    $('resultScope').textContent = `${run.last_manifest_evaluator} / ${run.finished_at_shanghai.slice(0, 10)} ${run.finished_at_shanghai.slice(11, 16)} / 已中断`;
    $('runEvidence').innerHTML = `<div class="section-heading"><h2>真实运行产出</h2><span>${run.sample.business_cases} 题 / ${run.sample.valid_answer_inputs} 份回答</span></div><div class="completion-heading"><strong>${complete}<span> / ${total}</span></strong><span>已产出 / 计划对局</span></div><div class="duel-cells" role="img" aria-label="${total} 场计划对局，产出 ${complete} 场">${Array.from({length:total},(_,index)=>`<span class="${index<complete?'produced':''}">${index<complete?'已产出':'未产出'}</span>`).join('')}</div><div class="stage-counts">${stages.map(([name,accepted,planned])=>`<div><span>${name}</span><strong>${accepted} / ${planned}</strong></div>`).join('')}</div><div class="observed-outcome"><span>已完成 ${completedCases} 题 / ${complete} 场</span><strong>B Fast 胜 1 场</strong><span>双方核心交付均可用</span></div>`;
    $('semanticEvidence').innerHTML = `<div class="section-heading"><h2>已完成题复核</h2><span class="status-warning">未通过</span></div><ul class="audit-findings">${run.semantic_review.issues.map(issue=>`<li>${escape(issue)}</li>`).join('')}</ul><div class="evidence-boundary"><strong>离线契约校验</strong><span>尚未校验</span></div><div class="evidence-boundary"><strong>独立人工一致率</strong><span>尚无已审定金标</span></div>`;
    $('validationRows').innerHTML = report.methodValidation.map(method => `<tr><th scope="row">${escape(method.name)}</th><td>${escape(method.conditions)}</td><td>${escape(method.metrics)}</td><td class="muted">${escape(method.result)}</td></tr>`).join('');
    const passed = report.tests.reduce((sum, test) => sum + test.passed, 0);
    const totalTests = report.tests.reduce((sum, test) => sum + test.total, 0);
    $('engineeringEvidence').innerHTML = `<h2>工程机制验证</h2><strong>${passed} / ${totalTests}</strong><span>结构、引用与统计协议</span><span class="config-version">配置快照 ${escape(report.meta.evaluator)}</span>`;
    if (report.records.length) {
      $('supplementalRecords').hidden = false;
      $('supplementalRecords').innerHTML = `<h2>补充记录</h2>${report.records.map(record => `<article class="supplemental-record"><h3>${escape(record.metric)}</h3><p>${record.numerator} / ${record.denominator} 有效观测 · ${record.cases} 题</p><p>${escape(record.notes)}</p><p>${escape(record.source)}</p></article>`).join('')}`;
    }
  }

  window.ReportFlow.render($('flowBody'), report);
  renderCase();
  renderPrompts();
  renderEvidence();
  document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => activatePage(button.dataset.page)));
  document.querySelector('.skip').addEventListener('click', event => { event.preventDefault(); $('main').focus(); });
  $('downloadPromptsBtn').addEventListener('click', () => {
    const text = `评测提示词 ${report.meta.evaluator}\n快照：${report.meta.snapshotAt}\n\n` + report.prompts.map(prompt => `${prompt.name}\n${prompt.path}\n\n${prompt.text}`).join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n');
    download('评测提示词原文.txt', text, 'text/plain;charset=utf-8');
    notify('已下载完整提示词原文');
  });
  addEventListener('hashchange', () => activatePage(location.hash.slice(1), false));
  activatePage(location.hash.slice(1) || 'flow', false, false);
})();
