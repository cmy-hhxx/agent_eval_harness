(() => {
  'use strict';
  const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const percentage = value => `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
  const same = (left, right) => left.outcome === right.outcome && left.winner === right.winner;
  const roundLabels = ['同序首判', '同序复判', '换位复判'];
  const group = version => version.startsWith('a_') ? 'A组' : 'B组';
  const differs = sample => sample.results.every(result => result.status === 'decided') && sample.results.some(result => !same(result, sample.results[0]));
  function summarize(samples) {
    const results = samples.flatMap(sample => sample.results);
    const coverage = {planned: results.length, decided: 0, pending: 0, failed: 0, incomplete: 0};
    results.forEach(result => { coverage[result.status === 'decided' ? 'decided' : result.status === 'needs_review' ? 'pending' : result.status === 'failed' ? 'failed' : 'incomplete']++; });
    const metrics = {};
    for (const [name, round, label] of [['repeat', 1, '同序首判 ↔ 同序复判'], ['swap', 2, '同序首判 ↔ 换位复判']]) {
      const pairs = samples.filter(sample => sample.results[0].status === 'decided' && sample.results[round].status === 'decided');
      const disagreements = pairs.filter(sample => !same(sample.results[0], sample.results[round])).map(sample => sample.id);
      const paired = pairs.length, agree = paired - disagreements.length, z = 1.959963984540054;
      const p = paired ? agree / paired : 0, denominator = 1 + z * z / paired;
      const center = (p + z * z / (2 * paired)) / denominator;
      const half = z * Math.sqrt(p * (1 - p) / paired + z * z / (4 * paired * paired)) / denominator;
      const corePairs = pairs.flatMap(sample => Object.keys(sample.results[0].core ?? {}).filter(version =>
        typeof sample.results[0].core[version] === 'boolean' && typeof sample.results[round].core?.[version] === 'boolean')
        .map(version => sample.results[0].core[version] === sample.results[round].core[version]));
      metrics[name] = {label, agree, paired, missing: samples.length - paired,
        interval: paired ? [Math.max(0, center - half), Math.min(1, center + half)] : null,
        coreAgree: corePairs.filter(Boolean).length, corePaired: corePairs.length, disagreements};
    }
    const complete = samples.filter(sample => sample.results.every(result => result.status === 'decided'));
    const stable = complete.filter(sample => sample.results.every(result => same(result, sample.results[0]))).length;
    return {coverage, metrics, conclusion: complete.length ? `${stable} / ${complete.length} 题三轮结论一致` : '暂无三轮均已决的题目'};
  }
  const outcome = result => {
    if (result.status !== 'decided') return {label: result.status === 'needs_review' ? '待核' : result.status === 'failed' ? '失败' : '未完成', state: 'pending'};
    if (result.outcome === 'both_good') return {label: '都好', state: 'tie'};
    if (result.outcome === 'both_bad') return {label: '都差', state: 'bad'};
    return {label: `${result.winner.startsWith('a_') ? 'A组' : 'B组'}胜`, state: 'win'};
  };
  const score = (id, label, value) => `<section class="exp-metric" data-experiment-metric="${id}"><div class="exp-metric-heading"><h2>${label}</h2><span>${safe(value.label)}</span></div><div class="exp-score"><strong>${value.paired ? percentage(value.agree / value.paired) : '—'}</strong><span>${value.agree} / ${value.paired} 对</span></div><div class="exp-interval">${value.paired ? `95% 区间 ${percentage(value.interval[0])}–${percentage(value.interval[1])}` : '暂无双边完成结果'}<span>缺失 ${value.missing} 对</span></div></section>`;
  const evidence = result => {
    if (!result.evidence) return '';
    const {comparison, citedFindings, originalTradeoff} = result.evidence;
    return `<details class="exp-round-evidence"><summary>判决依据与来源</summary><div><p><b>比较项</b> ${safe(comparison.aspect)}</p><p>重要性：${safe({high:'高',medium:'中',low:'低'}[comparison.importance])} · 优势方：${comparison.better_candidates.length ? comparison.better_candidates.map(group).join('、') : '未区分优劣'}</p>${Object.entries(comparison.assessments).map(([version, assessment]) => `<p><b>${group(version)}</b> ${safe(assessment.summary)}</p>${citedFindings[version].length ? `<ul>${citedFindings[version].map(finding => `<li>归因 [${finding.index}] ${safe(finding.text)}</li>`).join('')}</ul>` : ''}`).join('')}${originalTradeoff ? `<p><b>匿名原文</b> ${safe(originalTradeoff)}</p>` : ''}<p class="exp-source">${safe(result.source.file)}<br>${safe(result.source.comparisonId)}<br>取舍：decision_basis.tradeoff · 比较项：decision_basis.comparisons[0] · 归因：evaluations</p></div></details>`;
  };
  const disagreement = sample => `<details class="exp-difference" data-disagreement-case="${safe(sample.id)}"><summary><h3>${safe(sample.title)}</h3><span>${safe(sample.tier)} · ${sample.hasStandardAnswer ? '客观题' : '主观题'}</span></summary><p class="exp-question">${safe(sample.question)}</p><div class="exp-rounds">${sample.results.map((result, index) => `<section class="exp-round" data-disagreement-round="${index}"><div class="exp-round-label"><h4>${roundLabels[index]}</h4><strong>${safe(outcome(result).label)}</strong><span>匿名 A = ${group(result.mapping.A)}<br>匿名 B = ${group(result.mapping.B)}</span></div><div class="exp-round-body"><p data-round-tradeoff>${safe(result.reason)}</p>${sample.analysis?.roundNotes?.[index] ? `<p class="exp-text-note"><b>称呼混用</b> ${safe(sample.analysis.roundNotes[index])}</p>` : ''}${evidence(result)}</div></section>`).join('')}</div>${sample.analysis ? `<div class="exp-analysis"><h4>分歧分析 · ${safe(sample.analysis.title)}</h4><p>${safe(sample.analysis.explanation)}</p>${sample.analysis.caution ? `<p class="exp-analysis-caution"><b>依据待核</b> ${safe(sample.analysis.caution)}</p>` : ''}</div>` : ''}</details>`;
  const grouped = samples => `<table class="exp-group-table"><thead><tr><th>分组</th><th>题数</th><th>同序一致</th><th>换位一致</th><th>不一致</th></tr></thead><tbody>${['Fast','Expert'].flatMap(tier => [false,true].map(objective => {
    const selected = samples.filter(sample => sample.tier === tier && sample.hasStandardAnswer === objective), summary = summarize(selected);
    const count = selected.filter(differs).length;
    return `<tr data-experiment-group="${tier}-${objective ? 'objective' : 'subjective'}"><th>${tier} · ${objective ? '客观' : '主观'}</th><td>${selected.length}</td>${['repeat','swap'].map(key => `<td${summary.metrics[key].agree < summary.metrics[key].paired ? ' class="exp-group-mismatch"' : ''}>${summary.metrics[key].agree} / ${summary.metrics[key].paired}</td>`).join('')}<td${count ? ' class="exp-group-mismatch"' : ''}>${count}</td></tr>`;
  })).join('')}</tbody></table>`;
  window.ReportExperiments = {
    summarize,
    render(container, data = window.EvaluationExperimentData) {
      let tier = 'Fast', kind = 'subjective', overview = false;
      const draw = () => {
        const samples = overview ? data.samples : data.samples.filter(sample => sample.tier === tier && sample.hasStandardAnswer === (kind === 'objective'));
        const summary = summarize(samples), completion = summary.coverage;
        const differences = samples.filter(differs);
        const concurrency = data.executionEvents?.length ? `初始并发 ${data.totalConcurrency}，网关限流后降至 ${data.executionEvents.at(-1).totalConcurrency} 并沿用原任务续跑` : `总并发 ${data.totalConcurrency}`;
        container.innerHTML = `<div class="experiment-evidence" data-experiment-run="${safe(data.id)}">
          <div class="exp-filters"><h1>重复与换位实验</h1><button type="button" data-exp-overview aria-pressed="${overview}">汇总</button><select data-exp-tier aria-label="筛选模型档位">${overview ? '<option value="" disabled selected hidden>模型档位</option>' : ''}<option${!overview && tier === 'Fast' ? ' selected' : ''}>Fast</option><option${!overview && tier === 'Expert' ? ' selected' : ''}>Expert</option></select><select data-exp-kind aria-label="筛选题型">${overview ? '<option value="" disabled selected hidden>题型</option>' : ''}<option value="subjective"${!overview && kind === 'subjective' ? ' selected' : ''}>主观题</option><option value="objective"${!overview && kind === 'objective' ? ' selected' : ''}>客观题</option></select></div>
          <div class="exp-protocol"><span><strong>${samples.length} 题 × ${data.runs.length} 轮</strong>${safe(data.judge)} · ${safe(data.comparisonEvaluator)}</span><span>冻结标准与归因<strong>只重跑比较</strong></span><span>${completion.decided} / ${completion.planned} 已决<strong>${completion.pending} 待核 · ${completion.failed} 失败 · ${completion.incomplete} 未完成</strong></span></div>
          <dl class="exp-round-guide"><div><dt>同序首判 <span>原位一</span></dt><dd>固定题目、回答、标准与归因，第一次判决。</dd></div><div><dt>同序复判 <span>原位二</span></dt><dd>材料与 A/B 顺序不变，独立再判一次，不读取首判结论。</dd></div><div><dt>换位复判</dt><dd>交换匿名 A/B 位置，独立判第三次；赢家还原为真实组名。</dd></div></dl>
          <div class="exp-metrics">${score('repeat','同位重复',summary.metrics.repeat)}${score('swap','换位一致',summary.metrics.swap)}</div>
          ${overview ? grouped(samples) : ''}
          <div class="exp-results-heading"><h2>逐题结果</h2><span>A组 / B组为真实版本，换位后已还原</span></div>
          <div class="exp-table-wrap"><table class="exp-table"><thead><tr><th scope="col">固定题目</th>${roundLabels.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${samples.map(sample => {
            const values = sample.results.map(outcome);
            const different = sample.results.every(result => result.status === 'decided') && new Set(sample.results.map(result => `${result.outcome}:${result.winner}`)).size > 1;
            return `<tr data-experiment-case="${safe(sample.id)}"${different ? ' class="exp-disagreement"' : ''}><th scope="row"><span>${safe(sample.title)}</span></th>${values.map((value,index) => `<td data-round-result="${index}"><span class="exp-result exp-result-${value.state}">${safe(value.label)}</span></td>`).join('')}</tr>`;
          }).join('')}</tbody></table></div>
          <div class="exp-takeaway"><strong>${safe(summary.conclusion)}</strong><span>一致率按“结果类型 + 真实赢家”同时相同计算；稳定不等于正确。</span></div>
          <section class="exp-differences"><div class="exp-results-heading"><h2>三轮不一致的案例</h2><span>${differences.length} / ${samples.length} 题</span></div>${differences.length ? `<p class="exp-difference-summary">同序复判变化 ${summary.metrics.repeat.disagreements.length} 题，换位复判变化 ${summary.metrics.swap.disagreements.length} 题，合并去重 ${differences.length} 题。${differences.every(sample => sample.results.every(result => Object.values(result.core).length === 2 && Object.values(result.core).every(value => value === true))) ? '这些案例三轮都认为双方满足核心要求，分歧在“都好”与“单方胜”之间。' : ''}</p><p class="exp-analysis-boundary">以下分析对照已保存的取舍与比较项；换位轮也重新采样，不能把变化直接归因为位置偏差。</p>${differences.map(disagreement).join('')}` : '<p class="exp-no-differences">当前分组没有三轮不一致的案例。</p>'}</section>
          <div class="exp-boundaries"><span>比较 <strong>${safe(data.comparisonEvaluator)}</strong></span><span>标准 / 归因 <strong>${safe(data.upstreamEvaluators.join(' / '))}</strong></span><span>提示词消融 <strong>未开展</strong></span><span>人工一致性 <strong>无审定样本</strong></span></div>
          <details class="exp-method"><summary>实验口径与来源</summary><div class="exp-method-body"><p>固定 ${data.samples.length} 个不同问题，Fast / Expert 各 30 题，主观 40 题、客观 20 题，与现有评测方案使用同一批样本。每题冻结同一份 Criteria、Attribution、原始输入引用和标准；原位二重新采样，换位轮只交换匿名位置。三轮使用 ${safe(data.judge)}、${safe(data.comparisonEvaluator)}、Pi 和相同工具与修复预算，${safe(concurrency)}。上游材料保留原版本，不重新生成。</p><p>这是目的性选样的比较阶段实验。筛选同时更新覆盖、配对分母、一致率和逐题结果。95% 区间使用 Wilson 区间，只描述当前已决样本；未控制模型采样随机性，换位分歧不能单独归因为位置偏差。未引入人工金标，不用于报告评测准确率。</p><dl><dt>协议</dt><dd>${safe(data.protocolSource)}</dd><dt>报告分析</dt><dd>${safe(data.analysisSource)}</dd>${data.runs.map(run => `<dt>${roundLabels[data.runs.indexOf(run)]}</dt><dd>${safe(run.path)}</dd>`).join('')}</dl><div class="exp-reason-list">${samples.map(sample => `<section><h3>${safe(sample.title)}</h3>${sample.results.map((result,index) => `<p><b>${roundLabels[index]}</b>${safe(result.reason || '尚无正式取舍')}</p>`).join('')}</section>`).join('')}</div></div></details>
        </div>`;
      };
      const change = event => {
        const target = event.target;
        if (!target.matches('[data-exp-tier], [data-exp-kind]')) return;
        const selector = target.matches('[data-exp-tier]') ? '[data-exp-tier]' : '[data-exp-kind]';
        if (selector === '[data-exp-tier]') tier = target.value; else kind = target.value;
        overview = false;
        draw(); container.querySelector(selector).focus();
      };
      const click = event => {
        if (!event.target.closest('[data-exp-overview]')) return;
        overview = !overview; draw(); container.querySelector('[data-exp-overview]').focus();
      };
      container.addEventListener('change', change);
      container.addEventListener('click', click);
      draw();
      return {destroy() { container.removeEventListener('change', change); container.removeEventListener('click', click); }};
    },
  };
})();
