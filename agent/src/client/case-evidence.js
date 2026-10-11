import { createElement as h, lazy, Suspense, useLayoutEffect, useMemo, useRef } from 'react';

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' };
const Markdown = lazy(async () => {
  const { MarkdownText, MarkdownDelegateProvider } = await import('@deepseek-ai/dsh-client-ui-primitives');
  return { default: function EvidenceMarkdown({ text }) {
    const root = useRef(null);
    useLayoutEffect(() => {
      const tables = [...root.current.querySelectorAll('table')].filter(table => {
        const cells = table.tHead?.rows[0]?.cells;
        return cells?.length > 2 && /(?:代码|code|ticker|symbol)$/iu.test(cells[0].textContent.trim()) && /(?:名称|简称|name)$/iu.test(cells[1].textContent.trim());
      });
      const measure = () => tables.forEach(table => {
        const cells = [...table.rows[0].cells], codeWidth = cells[0].getBoundingClientRect().width;
        table.style.setProperty('--eris-name-column-width', `${Math.max(96, table.parentElement.clientWidth - codeWidth - 180 - 16)}px`);
        const frozen = codeWidth + cells[1].getBoundingClientRect().width, available = table.parentElement.clientWidth - frozen;
        table.style.setProperty('--eris-code-column-width', `${codeWidth}px`);
        table.style.setProperty('--eris-scroll-column-width', `${Math.max(0, available - 24)}px`);
        table.parentElement.style.setProperty('--eris-frozen-columns-width', `${frozen}px`);
        const widths = cells.map(cell => cell.getBoundingClientRect().width);
        // End on the first whole column that fits with all remaining columns.
        let last = cells.length - 1, remaining = widths[last];
        while (last > 2 && remaining + widths[last - 1] <= available) remaining += widths[--last];
        table.style.marginRight = `${last > 2 ? Math.max(0, available - remaining) : 0}px`;
        cells.forEach((cell, index) => cell.toggleAttribute('data-evidence-snap', index >= 2 && index <= last));
      });
      const observer = new ResizeObserver(measure);
      for (const table of tables) {
        table.setAttribute('data-evidence-identifiers', '');
        table.parentElement.setAttribute('data-evidence-scroll', '');
        observer.observe(table.parentElement);
        for (const cell of table.rows[0].cells) observer.observe(cell);
      }
      measure();
      return () => {
        observer.disconnect();
        for (const table of tables) {
          table.removeAttribute('data-evidence-identifiers');
          table.style.removeProperty('--eris-code-column-width');
          table.style.removeProperty('--eris-name-column-width');
          table.style.removeProperty('--eris-scroll-column-width');
          table.style.removeProperty('margin-right');
          table.parentElement.removeAttribute('data-evidence-scroll');
          table.parentElement.style.removeProperty('--eris-frozen-columns-width');
          for (const cell of table.rows[0].cells) cell.removeAttribute('data-evidence-snap');
        }
      };
    }, [text]);
    return h('div', { ref: root }, h(MarkdownDelegateProvider, { externalLinks: false }, h(MarkdownText, { text, labels, variant: 'compact' })));
  } };
});
const textTypes = new Set(['text', 'input_text', 'output_text']);
const codePart = value => ({ kind: 'code', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

/** Decode only real JSON and known text containers; keep unknown fields visible. */
function partsOf(value, depth = 0) {
  if (depth > 12) return [codePart(value)];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string' || (parsed && typeof parsed === 'object')) return partsOf(parsed, depth + 1);
    } catch { /* Plain text and incomplete JSON retain their source characters. */ }
    return [{ kind: /^\s*(?:\{\s*"|\[\s*[{"])/u.test(value) ? 'code' : 'text', text: value }];
  }
  if (Array.isArray(value)) return value.length ? value.flatMap(part => partsOf(part, depth + 1)) : [codePart(value)];
  if (!value || typeof value !== 'object') return [codePart(value)];
  const bodyKeys = ['text', 'content', 'output'].filter(key => typeof value[key] === 'string' || Array.isArray(value[key]));
  if (!bodyKeys.length) return [codePart(value)];
  const parts = bodyKeys.flatMap(key => partsOf(value[key], depth + 1));
  const other = Object.fromEntries(Object.entries(value).filter(([key]) => !bodyKeys.includes(key) && !(key === 'type' && textTypes.has(value.type))));
  if (Object.keys(other).length) parts.push(codePart(other));
  return parts;
}

export function evidenceParts(raw) {
  const parts = [];
  for (const part of partsOf(raw)) {
    if (part.kind === 'text') part.text = part.text.replace(/^[\t ]*<\/?referencable-result>[\t ]*(?:\r?\n|$)/gmu, '');
    if (!part.text?.trim()) continue;
    const previous = parts.at(-1);
    if (part.kind === 'text' && previous?.kind === 'text') previous.text += '\n' + part.text;
    else parts.push(part);
  }
  return parts;
}

export function EvidenceContent({ content }) {
  const parts = useMemo(() => evidenceParts(content), [content]);
  return h('div', { className: 'eris-evidence-content' },
    h('div', { 'data-evidence-preview': true }, parts.map((part, index) => part.kind === 'code'
      ? h('pre', { key: index }, part.text)
      : h(Suspense, { key: index, fallback: h('pre', null, part.text) }, h(Markdown, { text: part.text })))),
    h('details', { 'data-evidence-raw': true },
      h('summary', null, '原始数据'),
      h('pre', null, content)));
}
