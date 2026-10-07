(() => {
  'use strict';
  const safe = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const percentage = value => `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
  const outcome = result => {
    if (result.status !== 'decided') return {label: result.status === 'needs_review' ? '待核' : result.status === 'failed' ? '失败' : '未完成', state: 'pending'};
    if (result.outcome === 'both_good') return {label: '都好', state: 'tie'};
    if (result.outcome === 'both_bad') return {label: '都差', state: 'bad'};
    return {label: `${result.winner.startsWith('a_') ? 'A组' : 'B组'}胜`, state: 'win'};
  };
  const score = (id, label, value) => `<section class="exp-metric" data-experiment-metric="${id}"><div class="exp-metric-heading"><h2>${label}</h2><span>${safe(value.label)}</span></div><div class="exp-score"><strong>${value.paired ? percentage(value.agree / value.paired) : '—'}</strong><span>${value.agree} / ${value.paired} 对</span></div><div class="exp-interval">${value.paired ? `95% 区间 ${percentage(value.interval[0])}–${percentage(value.interval[1])}` : '暂无双边完成结果'}<span>缺失 ${value.missing} 对</span></div></section>`;
  window.ReportExperiments = {
    render(container, data = window.EvaluationExperimentData) {
      const completion = data.coverage;
      container.innerHTML = `<div class="experiment-evidence" data-experiment-run="${safe(data.id)}">
        <div class="exp-protocol"><span><strong>${data.samples.length} 题 × ${data.runs.length} 轮</strong>MiniMax-M3</span><span>冻结标准与归因<strong>只重跑比较</strong></span><span>${completion.decided} / ${completion.planned} 已决<strong>${completion.pending} 待核 · ${completion.failed} 失败 · ${completion.incomplete} 未完成</strong></span></div>
        <div class="exp-metrics">${score('repeat','同位重复',data.metrics.repeat)}${score('swap','换位一致',data.metrics.swap)}</div>
        <div class="exp-results-heading"><h2>逐题结果</h2><span>A组 / B组为真实版本，换位后已还原</span></div>
        <div class="exp-table-wrap"><table class="exp-table"><thead><tr><th scope="col">固定题目</th><th scope="col">原位一</th><th scope="col">原位二</th><th scope="col">交换 A/B</th></tr></thead><tbody>${data.samples.map(sample => {
          const values = sample.results.map(outcome);
          const different = sample.results.every(result => result.status === 'decided') && new Set(sample.results.map(result => `${result.outcome}:${result.winner}`)).size > 1;
          return `<tr data-experiment-case="${safe(sample.id)}"${different ? ' class="exp-disagreement"' : ''}><th scope="row"><span>${safe(sample.title)}</span><span class="exp-case-kind">${safe(sample.tier)} · ${sample.hasStandardAnswer ? '有答案' : '没答案'}</span></th>${values.map((value,index) => `<td data-round-result="${index}"><span class="exp-result exp-result-${value.state}">${safe(value.label)}</span></td>`).join('')}</tr>`;
        }).join('')}</tbody></table></div>
        <div class="exp-takeaway"><strong>${safe(data.conclusion)}</strong><span>一致率按“结果类型 + 真实赢家”同时相同计算；稳定不等于正确。</span></div>
        <div class="exp-boundaries"><span>比较 <strong>${safe(data.comparisonEvaluator)}</strong></span><span>标准 / 归因 <strong>${safe(data.upstreamEvaluators.join(' / '))}</strong></span><span>提示词消融 <strong>未开展</strong></span><span>人工一致性 <strong>无审定样本</strong></span></div>
        <details class="exp-method"><summary>实验口径与来源</summary><div class="exp-method-body"><p>固定六题覆盖 Fast / Expert、有答案 / 没答案，以及单方胜、都好、都差。每题冻结同一份 Criteria、Attribution、原始输入引用和标准；原位二重新采样，换位轮只交换匿名位置。三轮使用同一模型、提示词、工具与修复预算。</p><p>这是目的性选样的比较阶段实验。95% 区间使用 Wilson 区间，只描述这六对观测的小样本不确定性；未控制模型采样随机性，换位分歧不能单独归因为位置偏差。未引入人工金标，不用于报告评测准确率。</p><dl><dt>协议</dt><dd>${safe(data.protocolSource)}</dd>${data.runs.map(run => `<dt>${safe(run.label)}</dt><dd>${safe(run.path)}</dd>`).join('')}</dl><div class="exp-reason-list">${data.samples.map(sample => `<section><h3>${safe(sample.title)}</h3>${sample.results.map((result,index) => `<p><b>${safe(data.runs[index].label)}</b>${safe(result.reason || '尚无正式取舍')}</p>`).join('')}</section>`).join('')}</div></div></details>
      </div>`;
      return {destroy() {}};
    },
  };
})();
