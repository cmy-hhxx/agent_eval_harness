import { createElement as h } from 'react';

const text = (value, maximum = Infinity) => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= maximum;
const assessments = { strength: '优点', problem: '问题', uncertain: '待核实' };
const outcomes = { win: '胜出', loss: '落败', both_good: '双方均好', both_bad: '双方均差' };
const uniquePhrase = (value, phrase, maximum) => text(phrase, maximum) && value.indexOf(phrase) >= 0
  && value.indexOf(phrase, value.indexOf(phrase) + 1) < 0;
const validHighlights = path => path.highlights === undefined || (path.highlights !== null
  && typeof path.highlights === 'object' && !Array.isArray(path.highlights)
  && Object.keys(path.highlights).length === 1
  && Object.entries(path.highlights).every(([field, phrase]) => ['evidence', 'impact'].includes(field) && uniquePhrase(path[field], phrase, 16)));

export function comparisonFromToolOutput(output, state) {
  if (state !== 'ok' || typeof output !== 'string') return null;
  let receipt;
  try { receipt = JSON.parse(output); } catch { return null; }
  const diagram = receipt?.kind === 'comparison-diagram' ? receipt.diagram : null;
  if (!diagram || !text(diagram.title, 40) || !text(diagram.verdict) || !text(diagram.reason, 160)
    || (diagram.reasonHighlight !== undefined && !uniquePhrase(diagram.reason, diagram.reasonHighlight, 16))
    || (diagram.caveat !== undefined && !text(diagram.caveat, 100))
    || !Array.isArray(diagram.candidates) || diagram.candidates.length !== 2
    || !diagram.candidates.every(candidate => candidate && text(candidate.model) && text(candidate.name)
      && typeof candidate.outcome === 'string' && Object.hasOwn(outcomes, candidate.outcome) && text(candidate.summary, 80)
      && Array.isArray(candidate.paths) && candidate.paths.length >= 1 && candidate.paths.length <= 3
      && candidate.paths.every(path => path && typeof path === 'object' && !Array.isArray(path)
        && Object.keys(path).every(key => ['title', 'evidence', 'impact', 'assessment', 'highlights'].includes(key))
        && text(path.title, 16) && text(path.evidence, 141) && text(path.impact, 36)
        && typeof path.assessment === 'string' && Object.hasOwn(assessments, path.assessment) && validHighlights(path)))
    || diagram.candidates[0].model === diagram.candidates[1].model) return null;
  const highlightCount = diagram.candidates.flatMap(candidate => candidate.paths).reduce((count, path) => count + (path.highlights ? 1 : 0), diagram.reasonHighlight === undefined ? 0 : 1);
  if (highlightCount > 2) return null;
  return diagram;
}

function label(value, highlight) {
  if (highlight) {
    const start = value.indexOf(highlight);
    const emphasis = h('strong', { key: 'highlight', className: 'eris-comparison-highlight', 'data-comparison-highlight': true }, label(highlight));
    const after = value.slice(start + highlight.length);
    if (Array.from(highlight).length <= 10) {
      const punctuation = after.match(/^[，。！？、；：,.!?;:）)\]】”’]+/)?.[0] ?? '';
      return [label(value.slice(0, start)), h('span', { key: 'phrase', className: 'eris-comparison-phrase' }, emphasis, punctuation), label(after.slice(punctuation.length))];
    }
    return [label(value.slice(0, start)), emphasis, label(after)];
  }
  return value.split(/([+-]?\d+(?:[.,:/–—-]\d+)*(?:月(?:上中旬|中下旬|上旬|中旬|下旬)|个交易日|周|倍|元|月|日|%)?)/).map((part, index) => index % 2
    ? h('span', { key: index, className: 'eris-comparison-value' }, part) : part);
}

function AnswerArrow({ model }) {
  return h('svg', { className: 'eris-comparison-arrow', viewBox: '0 0 14 14', 'aria-hidden': true,
    'data-comparison-arrow': model, 'data-comparison-source': `${model}:answer`, 'data-comparison-target': `${model}:usefulness` },
    h('path', { d: 'M7 1V9' }),
    h('path', { 'data-arrow-head': true, d: 'M3 8L7 13L11 8Z', fill: 'currentColor', stroke: 'none' }));
}

export function ComparisonDiagram({ diagram }) {
  const sliceHeading = (number, title) => h('header', { className: 'eris-comparison-slice-heading' },
    h('span', { className: 'eris-comparison-slice-number', 'aria-hidden': true }, number),
    h('strong', { 'data-comparison-slice-title': true }, title));
  const answers = diagram.candidates.map(candidate => h('section', { key: candidate.model, className: 'eris-comparison-answer', 'data-comparison-answer': candidate.model },
    h('header', { className: 'eris-comparison-heading' },
      h('strong', { 'data-comparison-name': candidate.model }, candidate.name),
      h('span', { className: `eris-comparison-outcome is-${candidate.outcome}`, 'data-comparison-outcome': candidate.outcome }, outcomes[candidate.outcome])),
    h('p', { className: 'eris-comparison-summary', 'data-comparison-summary': candidate.model },
      h('span', { 'data-comparison-content': true }, label(candidate.summary)))));
  const candidates = diagram.candidates.map(candidate => {
    const paths = candidate.paths.map((path, index) => h('section', { key: index, className: 'eris-comparison-path', 'data-comparison-path': index },
      h('header', { className: 'eris-comparison-path-heading' },
        h('strong', { 'data-comparison-path-title': true }, path.title),
        h('span', { className: `eris-comparison-assessment is-${path.assessment}`, 'data-comparison-assessment': path.assessment }, assessments[path.assessment])),
      h('p', { className: 'eris-comparison-support', 'data-comparison-support': true, 'data-comparison-stage': 'evidence' },
        h('span', { 'data-comparison-content': true }, label(path.evidence, path.highlights?.evidence))),
      h('p', { className: 'eris-comparison-impact', 'data-comparison-stage': 'impact' },
        h('span', { 'data-comparison-content': true }, label(path.impact, path.highlights?.impact)))));
    return h('section', { key: candidate.model, className: 'eris-comparison-candidate', 'data-comparison-candidate': candidate.model },
      h('header', { className: 'eris-comparison-usefulness-heading', 'data-comparison-usefulness': candidate.model }, candidate.name),
      h('div', { className: 'eris-comparison-paths' }, paths));
  });
  return h('div', { className: 'eris-comparison-visual', 'data-comparison-visual': true },
    h('figure', { className: 'eris-comparison', 'data-analysis-comparison': true, 'aria-label': diagram.title },
      h('figcaption', { className: 'eris-comparison-conclusion', 'data-comparison-conclusion': true },
        h('strong', { 'data-comparison-verdict': true }, diagram.verdict),
        h('span', { 'data-comparison-reason': true }, label(diagram.reason, diagram.reasonHighlight))),
      h('section', { className: 'eris-comparison-slice', 'data-comparison-slice': 'question' },
        sliceHeading('01', '用户问了什么'),
        h('div', { className: 'eris-comparison-question', 'data-comparison-question': true }, diagram.title)),
      h('section', { className: 'eris-comparison-slice', 'data-comparison-slice': 'answer' },
        sliceHeading('02', '回答给了什么'),
        h('div', { className: 'eris-comparison-grid', 'data-comparison-grid': 'answer' }, answers)),
      h('div', { className: 'eris-comparison-transitions', 'aria-hidden': true },
        h('div', { className: 'eris-comparison-grid' }, diagram.candidates.map(candidate => h(AnswerArrow, { key: candidate.model, model: candidate.model })))),
      h('section', { className: 'eris-comparison-slice', 'data-comparison-slice': 'usefulness' },
        sliceHeading('03', '对用户有什么用'),
        h('div', { className: 'eris-comparison-grid', 'data-comparison-grid': 'usefulness' }, candidates))),
    diagram.caveat ? h('p', { className: 'eris-comparison-caveat', 'data-comparison-caveat': true }, diagram.caveat) : null);
}
