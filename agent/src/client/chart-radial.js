import { createElement as h, useState } from 'react';
import { chartTheme, heatColor, heatColors, heatTextColor } from './chart-theme.js';
import { compactNumber } from './chart-data.js';

const glyphWidth = text => Array.from(text).reduce((sum, c) => sum + (/[\x00-\x7f]/.test(c) ? 6 : 11), 0);
const round = value => Number(value.toFixed(3));
const position = (radius, angle, center) => [round(center + radius * Math.cos(angle)), round(center + radius * Math.sin(angle))];

export function radialCells(chart, size) {
  const margin = Math.min(58, Math.max(30, ...chart.categories.map(label => Math.min(54, glyphWidth(label)) + 8)));
  const center = size / 2, outer = center - margin, inner = 26, thickness = (outer - inner) / chart.series.length;
  const values = chart.series.flatMap(s => s.values).filter(v => v !== null);
  const extent = Math.max(...values.map(Math.abs)), minimum = values.some(v => v < 0) ? -extent : 0, maximum = extent;
  const angle = 2 * Math.PI / chart.categories.length;
  const cells = chart.series.flatMap((series, si) => series.values.map((value, ci) => {
    const start = -Math.PI / 2 + ci * angle + .01, end = start + angle - .02;
    const r0 = inner + si * thickness + 1, r1 = inner + (si + 1) * thickness - 1;
    const a = position(r1, start, center), b = position(r1, end, center), c = position(r0, end, center), d = position(r0, start, center);
    const middle = (start + end) / 2, radius = (r0 + r1) / 2;
    const label = value === null ? '—' : compactNumber(value);
    const fill = value === null ? '#E7E7E7' : heatColor(value, minimum, maximum);
    return { value, categoryIndex: ci, seriesIndex: si, label, position: position(radius, middle, center),
      showLabel: glyphWidth(label) < 2 * radius * Math.sin(angle / 2) - 5 && thickness >= 16,
      fill, ink: heatTextColor(fill),
      path: `M ${a} A ${r1} ${r1} 0 0 1 ${b} L ${c} A ${r0} ${r0} 0 0 0 ${d} Z` };
  }));
  return { cells, minimum, maximum, outer, center, angle };
}

export function RadialHeatmap({ chart, width, english }) {
  const [reading, setReading] = useState('');
  const size = Math.min(300, width), { cells, minimum, maximum, outer, center, angle } = radialCells(chart, size);
  const readingFor = cell => `${chart.categories[cell.categoryIndex]} · ${chart.series[cell.seriesIndex].name}：${cell.value === null ? english ? 'Unknown' : '未知' : `${cell.value} ${chart.unit}`}`;
  const identities = chart.series.map(s => /^([A-D])组(Fast|Expert)$/.exec(s.name));
  const commonTier = identities.every(Boolean) && new Set(identities.map(m => m[2])).size === 1;
  const ringNames = commonTier ? `${identities[0][2]} · ${english ? 'Inner → outer' : '内 → 外'}：${identities.map(m => m[1]).join(' / ')}`
    : `${english ? 'Inner → outer' : '内 → 外'}：${chart.series.map(s => s.name).join(' / ')}`;
  return h('div', { 'data-radial-heatmap': true },
    h('div', { style: { fontSize: 12, lineHeight: 1.5, color: chartTheme.muted, marginBottom: 2, whiteSpace: 'nowrap', overflowX: 'auto' } }, ringNames),
    h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'group', 'aria-label': chart.title,
      'data-chart-type': 'radial_heatmap', style: { display: 'block', maxWidth: '100%', margin: '0 auto', fontFamily: 'inherit' } },
      cells.map((cell, index) => h('g', { key: index },
        h('path', { d: cell.path, fill: cell.fill, stroke: cell.value === null ? '#aaa' : '#fff', strokeDasharray: cell.value === null ? '2 2' : undefined,
          'data-radial-cell': true, 'data-value': cell.value, 'data-category': chart.categories[cell.categoryIndex], 'data-series': chart.series[cell.seriesIndex].name,
          tabIndex: 0, role: 'img', 'aria-label': readingFor(cell), onFocus: () => setReading(readingFor(cell)),
          onBlur: () => setReading(''), onKeyDown: event => {
            if (event.key === 'Escape') { setReading(''); return; }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? cells.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + cells.length) % cells.length;
            event.currentTarget.ownerSVGElement.querySelectorAll('[data-radial-cell]')[next].focus();
          } }),
        cell.showLabel ? h('text', { x: cell.position[0], y: cell.position[1], fill: cell.ink, fontSize: 11, textAnchor: 'middle', dominantBaseline: 'central', pointerEvents: 'none', 'data-radial-value': true }, cell.label) : null,
        (chart.annotations ?? []).flatMap((a, i) => a.seriesIndex === cell.seriesIndex && a.categoryIndex === cell.categoryIndex
          ? [h('text', { key: i, x: cell.position[0] + 8, y: cell.position[1] - 7, fontSize: 9, fill: cell.ink, pointerEvents: 'none', 'data-chart-annotation-marker': true }, String(i + 1))] : []))),
      chart.categories.map((category, index) => {
        const a = -Math.PI / 2 + (index + .5) * angle, [x, y] = position(outer + 9, a, center);
        return h('text', { key: index, x, y, fontSize: 11, fill: chartTheme.muted, textAnchor: Math.cos(a) > .3 ? 'start' : Math.cos(a) < -.3 ? 'end' : 'middle', dominantBaseline: 'central', 'data-radial-label': true },
          category);
      })),
    h('div', { 'data-radial-scale': true, style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, fontSize: 11, color: chartTheme.muted } },
      compactNumber(minimum), h('span', { 'aria-hidden': true, style: { width: 96, height: 5, background: maximum === 0 ? chartTheme.ivory : `linear-gradient(90deg,${heatColors(minimum).join(',')})` } }), compactNumber(maximum)),
    h('div', { 'aria-live': 'polite', className: 'eris-chart-sr-reading' }, reading));
}
