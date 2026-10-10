import { createElement as h, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CircularChart } from './chart-circular.js';
import { circularTypes, validStructureChart } from './chart-structure-data.js';
import { RadialHeatmap } from './chart-radial.js';
import { researchTypes } from './chart-data.js';
import { ComparisonDiagram, comparisonFromToolOutput } from './comparison-diagram.js';

import { chartTheme, researchColors } from './chart-theme.js';
const colors = researchColors;
const categoryColors = [chartTheme.denim, chartTheme.earth, chartTheme.terracotta, chartTheme.coral, chartTheme.royal, chartTheme.navy, chartTheme.ivory];
const bothGoodColor = chartTheme.denim;
const bothBadColor = chartTheme.navy;
const primaryColor = chartTheme.ink;
const textColor = chartTheme.muted;
const borderColor = chartTheme.grid;
const paperColor = chartTheme.paper;
const chartMaxWidth = 540;
const visuallyHidden = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 };
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 20 });
const percentFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const scientificNumber = value => value.toExponential().replace(/e\+?/, 'E');
const formatNumber = value => {
  if (Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < 1e-6)) return scientificNumber(value);
  const formatted = numberFormat.format(value);
  return Number(formatted.replaceAll(',', '')) === value ? formatted : scientificNumber(value);
};
const formatPercentage = value => value > 0 && value < 0.01 ? '<0.01%' : `${percentFormat.format(value)}%`;
const numberText = value => {
  const [mantissa, exponent] = value.split('E');
  return exponent === undefined ? value : [h('span', { key: 'mantissa', style: { whiteSpace: 'nowrap' } }, mantissa),
    h('wbr', { key: 'break' }), h('span', { key: 'exponent', style: { whiteSpace: 'nowrap' } }, `E${exponent}`)];
};
const coordinates = value => Number(value.toFixed(3));
// Identity colours only recognise explicitly labelled groups, never a model tier or a result.
const identityIndex = name => {
  const identity = /^([ABC])(?=$|[\s:：·/(_-]|组|組)/i.exec(name.trim());
  return identity ? identity[1].toUpperCase().charCodeAt(0) - 65 : null;
};
const seriesColor = (name, index) => colors[identityIndex(name) ?? index % colors.length];
const lineDash = (name, index) => [undefined, undefined, '6 4', '2 4'][identityIndex(name) ?? index % colors.length];
const lineStyle = (name, index) => lineDash(name, index) === '6 4' ? 'dashed' : lineDash(name, index) ? 'dotted' : 'solid';
function seriesIndexes(chart) {
  const reserved = new Set(chart.series.map(series => identityIndex(series.name)).filter(index => index !== null));
  const available = colors.map((_, index) => index).filter(index => !reserved.has(index));
  return chart.series.map(series => identityIndex(series.name) ?? available.shift());
}
const resultColor = name => {
  const label = name.replace(/\s+/g, '').toLowerCase();
  if (['双方均好', '双方都好', '双方都答得好', 'bothgood'].includes(label)) return bothGoodColor;
  if (['双方均差', '双方都差', '双方都答得差', 'bothbad'].includes(label)) return bothBadColor;
  return null;
};
const dotColor = (chart, category, seriesIndex, colorIndex) => chart.series.length === 1
  ? resultColor(category) ?? colors[identityIndex(category) ?? 0]
  : seriesColor(chart.series[seriesIndex].name, colorIndex);
function compositionColors(categories) {
  const generic = categories.filter(name => identityIndex(name) === null && resultColor(name) === null).toSorted();
  const reserved = new Set(categories.map(name => resultColor(name) ?? (identityIndex(name) === null ? null : colors[identityIndex(name)])).filter(Boolean));
  const available = categoryColors.filter(color => !reserved.has(color));
  return categories.map(name => resultColor(name) ?? (identityIndex(name) === null
    ? available[generic.indexOf(name)] : colors[identityIndex(name)]));
}
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const strings = (values, maximum = 30) => Array.isArray(values) && values.length > 0 && values.length <= maximum
  && values.every(value => text(value, 120)) && new Set(values).size === values.length;
function dateTime(value) {
  if (!/^[1-9]\d{3}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return NaN;
  const [year, month = '01', day = '01'] = value.split('-');
  const calendarDate = `${year}-${month}-${day}`, time = Date.parse(`${calendarDate}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === calendarDate ? time : NaN;
}

/** Render only the successful, structured chart receipt, never tool arguments or arbitrary markup. */
export function chartFromToolOutput(output, state) {
  if (state !== 'ok' || typeof output !== 'string') return null;
  let receipt;
  try { receipt = JSON.parse(output); } catch { return null; }
  const chart = receipt?.kind === 'chart' ? receipt.chart : null;
  if (!chart || !['dot', 'line', 'pie', 'radial_heatmap', ...circularTypes, ...researchTypes].includes(chart.type)
    || !['title', 'scope', 'source'].every(key => text(chart[key], 500)) || !text(chart.unit, 40)
    || !strings(chart.categories, ['scatter', 'histogram', 'bubble', 'boxplot', 'violin', 'ecdf', 'ridgeline'].includes(chart.type) ? 200 : 30) || !Array.isArray(chart.series) || chart.series.length === 0 || chart.series.length > (['sankey','chord'].includes(chart.type) ? 8 : 4)
    || !chart.series.every(series => series && text(series.name, 120)
      && Array.isArray(series.values) && series.values.length === chart.categories.length
      && series.values.every(value => value === null || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15)))
    || !chart.series.some(series => series.values.some(value => value !== null))
    || new Set(chart.series.map(series => series.name)).size !== chart.series.length) return null;
  if (!validStructureChart(chart)) return null;
  if (['scatter', 'bubble'].includes(chart.type) && (!Array.isArray(chart.xValues) || chart.xValues.length !== chart.categories.length
    || !text(chart.xLabel, 80) || !text(chart.xUnit, 40)
    || chart.xValues.some(v => v !== null && (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e15))
    || chart.series.reduce((sum, s) => sum + s.values.filter((v, i) => v !== null && chart.xValues[i] !== null).length, 0) < 3)) return null;
  if (chart.type === 'bubble' && (!Array.isArray(chart.sizeValues) || chart.sizeValues.length !== chart.categories.length
    || !text(chart.sizeLabel, 80) || !text(chart.sizeUnit, 40) || chart.sizeValues.some(v => v !== null && (!Number.isFinite(v) || v < 0 || v > 1e15))
    || chart.series.reduce((sum, s) => sum + s.values.filter((v, i) => v !== null && chart.xValues[i] !== null && chart.sizeValues[i] !== null).length, 0) < 3)) return null;
  if (chart.type === 'bubble_matrix' && chart.series.some(s => s.values.some(v => v !== null && v < 0))) return null;
  if (chart.type === 'slope' && (chart.categories.length !== 2 || !chart.series.some(s => s.values.every(v => v !== null)))) return null;
  if (chart.type === 'bump' && (chart.categories.length < 2 || chart.categories.length > 12 || chart.series.some(s => s.values.some(v => v !== null && (!Number.isInteger(v) || v < 1))))) return null;
  if (chart.type === 'interval' && chart.series.some(s => !Array.isArray(s.lowerValues) || !Array.isArray(s.upperValues)
    || s.lowerValues.length !== chart.categories.length || s.upperValues.length !== chart.categories.length
    || s.values.some((v, i) => v === null ? s.lowerValues[i] !== null || s.upperValues[i] !== null
      : !Number.isFinite(s.lowerValues[i]) || !Number.isFinite(s.upperValues[i]) || Math.abs(s.lowerValues[i]) > 1e15 || Math.abs(s.upperValues[i]) > 1e15 || s.lowerValues[i] > v || s.upperValues[i] < v))) return null;
  if (['boxplot', 'violin'].includes(chart.type) && chart.series.some(s => s.values.filter(v => v !== null).length < (chart.type === 'violin' ? 8 : 5))) return null;
  if (chart.type === 'radial_heatmap' && (chart.series.length < 2 || chart.categories.length < 3 || chart.categories.length > 12 || chart.categories.some(label => Array.from(label).length > 12))) return null;
  if (chart.type === 'dumbbell' && (chart.series.length !== 2 || chart.categories.length < 2)) return null;
  if (['histogram', 'waterfall'].includes(chart.type) && (chart.series.length !== 1 || chart.categories.length < 2 || chart.series[0].values.includes(null))) return null;
  if (chart.annotations !== undefined && (!Array.isArray(chart.annotations) || chart.annotations.length > 3 || chart.annotations.some(a => !a
    || !Number.isInteger(a.categoryIndex) || a.categoryIndex < 0 || !Number.isInteger(a.seriesIndex) || a.seriesIndex < 0
    || !text(a.note, 100) || !chart.categories[a.categoryIndex] || !chart.series[a.seriesIndex]
    || chart.series[a.seriesIndex].values[a.categoryIndex] === null || (['scatter', 'bubble'].includes(chart.type) && chart.xValues[a.categoryIndex] === null) || (chart.type === 'bubble' && chart.sizeValues[a.categoryIndex] === null)))) return null;
  if (chart.type === 'pie') {
    if (chart.series.length !== 1 || chart.categories.length > 6
      || chart.series[0].values.some(value => value === null || value < 0)) return null;
    const total = chart.series[0].values.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) return null;
  }
  if (chart.type === 'line') {
    if (chart.categories.length < 2) return null;
    const times = chart.categories.map(dateTime);
    if (times.some((value, index) => !Number.isFinite(value) || (index > 0 && value <= times[index - 1]))) return null;
  }
  return chart;
}

/** A Turn's accepted receipts are the only chart source; deduplicate by the recorded call identity. */
export function chartsFromToolData(data) {
  const charts = [], seen = new Set(), pending = data.map(value => value.root);
  for (const block of pending) {
    if (!block) continue;
    if (Array.isArray(block.subCalls)) pending.push(...block.subCalls);
    if (block.kind !== 'tool-result' || !['show_chart', 'show_comparison'].includes(block.call?.name) || block.isError || !Array.isArray(block.content) || seen.has(block.callId)) continue;
    const output = block.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
    const chart = block.call.name === 'show_chart' ? chartFromToolOutput(output, 'ok') : null;
    const diagram = block.call.name === 'show_comparison' ? comparisonFromToolOutput(output, 'ok') : null;
    if (chart || diagram) {
      seen.add(block.callId); charts.push({ callId: block.callId, ...(chart ? { chart } : { diagram }) });
    }
  }
  return charts;
}

function useTurnCharts(turn, useChat) {
  const nodes = useChat(snapshot => snapshot.nodes);
  const source = useMemo(() => nodes.turnDataSource(turn, 'tool-call'), [nodes, turn]);
  const data = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return useMemo(() => chartsFromToolData(data), [data]);
}

/** The final response displays its Turn's accepted receipts, independent of Markdown. */
export const TurnCharts = memo(function TurnCharts({ turn, useChat }) {
  const charts = useTurnCharts(turn, useChat);
  return charts.length ? h('div', { 'data-turn-charts': turn }, charts.map(({ callId, chart, diagram }) => diagram
    ? h(ComparisonDiagram, { key: callId, diagram })
    : h(AnalysisChart, { key: callId, chart, language: typeof document === 'undefined' ? 'zh' : document.documentElement.lang }))) : null;
});

/** An interrupted or failed Turn can have accepted charts without a final response. */
export const TurnChartFallback = memo(function TurnChartFallback({ turn, useChat }) {
  const nodes = useChat(snapshot => snapshot.nodes);
  const source = useMemo(() => nodes.turnDataSource(turn.turn, 'turn-process'), [nodes, turn.turn]);
  const processes = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  return processes.at(-1)?.answerStep != null ? null
    : h('div', { 'data-turn-chart-fallback': turn.turn }, h(TurnCharts, { turn: turn.turn, useChat }));
});

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(chartMaxWidth - 26);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) { const style = element.ownerDocument.defaultView.getComputedStyle(element); setWidth(Math.min(element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0), chartMaxWidth)); } };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function niceStep(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude;
}

/** The contract bounds every value; preserve their actual span before aligning readable ticks. */
function numericScale(chart, start, end, includeZero, tickCount = 5) {
  const values = chart.series.flatMap(series => series.values).filter(value => value !== null);
  let lower = Math.min(...values, ...(includeZero ? [0] : [])), upper = Math.max(...values, ...(includeZero ? [0] : []));
  if (lower === upper) {
    if (includeZero) upper = 1;
    else { const padding = Math.max(Math.abs(lower) * 0.1, lower === 0 ? 1 : Number.MIN_VALUE * 10); lower -= padding; upper += padding; }
  }
  const actualLower = lower, actualUpper = upper, span = upper - lower;
  const rawStep = span / Math.max(1, tickCount - 1) || span;
  let step = niceStep(values.every(Number.isInteger) ? Math.max(1, rawStep) : rawStep);
  if (!Number.isFinite(step) || step <= 0) step = span;
  const alignedLower = Math.floor(lower / step + 1e-10) * step, alignedUpper = Math.ceil(upper / step - 1e-10) * step;
  if (Number.isFinite(alignedLower) && Number.isFinite(alignedUpper) && alignedUpper > alignedLower) {
    lower = Math.min(actualLower, alignedLower); upper = Math.max(actualUpper, alignedUpper);
  }
  const position = value => start + (value - lower) / (upper - lower) * (end - start);
  const ticks = [], seen = new Set();
  const addTick = raw => {
    const clean = Number(raw.toPrecision(12));
    const value = Math.abs(clean - raw) <= step * 1e-6 && clean >= lower && clean <= upper ? clean : raw;
    if (value < lower || value > upper || seen.has(value)) return;
    seen.add(value); ticks.push({ position: coordinates(position(value)), value });
  };
  for (let index = 0, count = Math.min(30, Math.round((upper - lower) / step) + 1); index < count; index++) addTick(lower + index * step);
  if (ticks.length < 2) { addTick(lower); addTick(upper); }
  ticks.sort((a, b) => a.value - b.value);
  return { position, ticks };
}

// A conservative glyph estimate wraps labels instead of truncating them or shrinking the font.
function labelWidth(value, fontSize = 14) {
  return Array.from(value).reduce((sum, character) => sum + (/\s/.test(character) ? 5 : /[MWm@]/.test(character) ? 12 : /[\x00-\x7f]/.test(character) ? 9 : 14), 0) * fontSize / 14;
}
function wrappedLines(value, width, fontSize = 14) {
  const lines = []; let line = '', length = 0;
  for (const character of Array.from(value)) {
    const size = labelWidth(character, fontSize);
    if (line && length + size > width) { lines.push(line); line = ''; length = 0; }
    line += character; length += size;
  }
  if (line) lines.push(line);
  return lines;
}
function svgLabel(value, x, y, width, props = {}) {
  const fontSize = props.fontSize ?? 14;
  return h('text', { x: coordinates(x), y: coordinates(y), fill: primaryColor, fontSize: 14, ...props },
    wrappedLines(value, Math.max(fontSize, width), fontSize).map((line, index) => h('tspan', { key: index, x: coordinates(x), dy: index ? fontSize * 1.4 : 0 }, line)));
}
function svg(chart, width, height, marks, template, interaction = {}) {
  return h('svg', { role: template === 'trend' ? 'group' : 'img', 'aria-label': `${chart.title}，${chart.unit}`, 'data-chart-type': chart.type,
    'data-chart-template': template, width, height, viewBox: `0 0 ${width} ${height}`,
    style: { display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums', maxWidth: template === 'trend' ? undefined : '100%', flexShrink: 0 },
    ...interaction,
  }, marks);
}

function annotationMarkers(chart, categoryIndex, seriesIndex, x, y) {
  return (chart.annotations ?? []).flatMap((a, index) => a.categoryIndex === categoryIndex && a.seriesIndex === seriesIndex
    ? [h('g', { key: `annotation-${index}`, 'data-chart-annotation-marker': true },
      h('circle', { cx: x, cy: y, r: 7, fill: primaryColor }),
      h('text', { x, y: y + 3, textAnchor: 'middle', fontSize: 10, fill: paperColor }, String(index + 1)))] : []);
}

function ComparisonChart({ chart, width, english }) {
  const identities = seriesIndexes(chart);
  const plotWidth = Math.max(1, width), compact = plotWidth < 500, marks = [], rows = [];
  const valueWidth = Math.min(220, Math.max(44, ...chart.series.flatMap(series => series.values.map(value => labelWidth(value === null ? (english ? 'Unknown' : '未知') : formatNumber(value), 16) + 8))));
  const labelColumn = compact ? 0 : Math.min(180, Math.max(100, plotWidth * 0.26));
  const left = compact ? 6 : labelColumn + 16, right = compact ? plotWidth - 6 : plotWidth - valueWidth - 12;
  const { position: x, ticks } = numericScale(chart, left, right, true, Math.max(2, Math.min(5, Math.floor((right - left) / 70) + 1)));
  let offset = 4;
  chart.categories.forEach((category, categoryIndex) => {
    if (compact) {
      if (chart.series.length > 1) {
        marks.push(svgLabel(category, 0, offset + 15, plotWidth, { key: `category-${categoryIndex}`, 'data-chart-label': 'category', fontWeight: 600 }));
        offset += wrappedLines(category, plotWidth).length * 20 + 4;
      }
      chart.series.forEach((series, seriesIndex) => {
        const value = series.values[categoryIndex], valueText = value === null ? (english ? 'Unknown' : '未知') : formatNumber(value);
        const label = chart.series.length === 1 ? category : series.name;
        const numberColumn = Math.min(valueWidth, plotWidth * 0.6), labelSpace = Math.max(14, plotWidth - numberColumn - 12);
        const headerHeight = Math.max(wrappedLines(label, labelSpace).length * 20, wrappedLines(valueText, numberColumn, 16).length * 23);
        marks.push(svgLabel(label, 0, offset + 15, labelSpace, { key: `label-${categoryIndex}-${seriesIndex}`, 'data-chart-label': chart.series.length === 1 ? 'category' : 'series' }));
        marks.push(svgLabel(valueText, plotWidth, offset + 16, numberColumn, { key: `value-${categoryIndex}-${seriesIndex}`,
          textAnchor: 'end', fontSize: 16, fontWeight: 500, 'data-chart-value': value === null ? undefined : true, 'data-chart-unknown': value === null ? true : undefined }));
        rows.push({ category, series, categoryIndex, seriesIndex, value, top: offset + headerHeight + 2, height: 10 });
        offset += headerHeight + 20;
      });
      offset += 4;
    } else {
      const categoryLines = wrappedLines(category, labelColumn), groupHeight = Math.max(categoryLines.length * 20 + 8,
        chart.series.length * Math.max(30, ...chart.series.map(series => wrappedLines(series.values[categoryIndex] === null ? (english ? 'Unknown' : '未知') : formatNumber(series.values[categoryIndex]), valueWidth, 16).length * 23 + 7)));
      marks.push(svgLabel(category, 0, offset + (groupHeight - categoryLines.length * 20) / 2 + 15, labelColumn,
        { key: `category-${categoryIndex}`, 'data-chart-label': 'category' }));
      chart.series.forEach((series, seriesIndex) => {
        const value = series.values[categoryIndex], valueText = value === null ? (english ? 'Unknown' : '未知') : formatNumber(value);
        const center = offset + groupHeight * (seriesIndex + 0.5) / chart.series.length;
        const valueLines = wrappedLines(valueText, valueWidth, 16);
        marks.push(svgLabel(valueText, right + 12, center - (valueLines.length - 1) * 11.5 + 5, valueWidth,
          { key: `value-${categoryIndex}-${seriesIndex}`, fontSize: 16, fontWeight: 500, 'data-chart-value': value === null ? undefined : true,
            'data-chart-unknown': value === null ? true : undefined }));
        rows.push({ category, series, categoryIndex, seriesIndex, value, top: center - 5, height: 10 });
      });
      offset += groupHeight + 8;
    }
  });
  const bottom = offset + 2;
  const backgrounds = [];
  for (const tick of ticks) {
    const spans = compact ? rows.map(row => [row.top - 3, row.top + row.height + 3]) : [[0, bottom - 8]];
    spans.forEach(([top, end], index) => backgrounds.push(h('line', { key: `grid-${tick.value}-${index}`, 'data-zero-baseline': tick.value === 0 ? true : undefined,
      x1: tick.position, x2: tick.position, y1: coordinates(top), y2: coordinates(end), stroke: tick.value === 0 ? textColor : borderColor,
      strokeWidth: tick.value === 0 ? 1.25 : 1 })));
    backgrounds.push(h('text', { key: `tick-${tick.value}`, 'data-axis-tick': true, x: tick.position, y: bottom + 16, fontSize: 13, fill: textColor,
      textAnchor: tick.position === coordinates(left) ? 'start' : tick.position === coordinates(right) ? 'end' : 'middle' }, formatNumber(tick.value)));
  }
  rows.forEach(({ category, series, categoryIndex, seriesIndex, value, top, height }) => {
    if (value === null) return;
    const end = coordinates(x(value));
    marks.push(h('circle', { key: `dot-${categoryIndex}-${seriesIndex}`, 'data-chart-mark': 'dot', 'data-series': series.name, 'data-category': category,
      'data-value': value, cx: end, cy: coordinates(top + height / 2), r: 4,
      fill: dotColor(chart, category, seriesIndex, identities[seriesIndex]) }));
    marks.push(...annotationMarkers(chart, categoryIndex, seriesIndex, Math.max(8, Math.min(plotWidth - 8, end + 10)), top - 4));
  });
  return svg(chart, plotWidth, bottom + 24, [...backgrounds, ...marks], compact ? 'comparison-compact' : 'comparison');
}

function separatedLabels(labels, top, bottom, spacing) {
  const ordered = labels.toSorted((a, b) => a.y - b.y);
  ordered.forEach((label, index) => { label.labelY = Math.max(label.y, index
    ? ordered[index - 1].labelY + (ordered[index - 1].height + label.height) / 2 + spacing : top + label.height / 2); });
  const overflow = ordered.length ? ordered.at(-1).labelY + ordered.at(-1).height / 2 - bottom : 0;
  if (overflow > 0) {
    ordered.at(-1).labelY -= overflow;
    for (let index = ordered.length - 2; index >= 0; index--) ordered[index].labelY = Math.min(ordered[index].labelY,
      ordered[index + 1].labelY - (ordered[index].height + ordered[index + 1].height) / 2 - spacing);
  }
  return ordered;
}

function TrendChart({ chart, width, english }) {
  const [activeKey, setActiveKey] = useState(null);
  const [focused, setFocused] = useState(null);
  const identities = seriesIndexes(chart);
  const marks = [], paths = [], hits = [], labels = [], observations = [];
  const top = 22, compact = width < 500;
  const known = chart.series.flatMap(series => series.values).filter(value => value !== null);
  const tickSpace = Math.min(compact ? Infinity : 110, Math.max(44, ...known.map(value => labelWidth(formatNumber(value)) + 10)));
  const tailSpace = compact ? 12 : Math.max(100, ...chart.series.map(series => {
    const value = series.values.findLast(value => value !== null);
    return value === undefined ? 0 : Math.max(Math.min(180, labelWidth(series.name) + 18), labelWidth(formatNumber(value), 15) + 18);
  }));
  const labelHeights = chart.series.map(series => series.values.some(value => value !== null)
    ? compact ? 44 : wrappedLines(series.name, tailSpace - 18).length * 20 + 24 : 0);
  const bottom = top + (compact ? 168 : Math.max(168, labelHeights.reduce((sum, height) => sum + height, 0) + 8 * (labelHeights.filter(Boolean).length - 1)));
  const sameYear = chart.categories.every(date => date.slice(0, 4) === chart.categories[0].slice(0, 4));
  const dateLabels = chart.categories.map(date => compact && date.length > 4
    ? sameYear ? [date.slice(5)] : [date.slice(0, 4), date.slice(5)] : [date]);
  const dateWidth = lines => Math.max(...lines.map(line => labelWidth(line)));
  const minimumPlot = Math.max(compact ? 100 : 180, dateWidth(dateLabels[0]) + dateWidth(dateLabels.at(-1)) + 24);
  const plotWidth = Math.max(width, tickSpace + minimumPlot + tailSpace);
  const plotHeight = bottom + (dateLabels.some(lines => lines.length > 1) ? 56 : 38);
  const left = tickSpace, right = plotWidth - tailSpace;
  const { position: y, ticks } = numericScale(chart, bottom, top, false);
  const times = chart.categories.map(dateTime), start = times[0], duration = times.at(-1) - start;
  const x = index => left + (times[index] - start) / duration * (right - left);
  ticks.forEach(tick => {
    marks.push(h('line', { key: 'grid-' + tick.value, x1: left, x2: right, y1: tick.position, y2: tick.position, stroke: borderColor }));
    marks.push(svgLabel(formatNumber(tick.value), left - 10, tick.position + 5, tickSpace - 10, { key: 'tick-' + tick.value, 'data-axis-tick': true, textAnchor: 'end', fill: textColor, fontSize: 13 }));
  });
  let previousLabel = -Infinity;
  dateLabels.forEach((lines, index) => {
    const position = x(index), last = index === dateLabels.length - 1, labelSize = dateWidth(lines);
    if (index !== 0 && !last && (position - previousLabel < labelSize + 28 || right - position < dateWidth(dateLabels.at(-1)) + 24)) return;
    marks.push(h('text', { key: 'date-' + index, x: coordinates(position), y: bottom + 28, 'data-chart-label': 'date', 'data-date': chart.categories[index], fill: textColor, fontSize: 13,
      textAnchor: index === 0 ? 'start' : last ? 'end' : 'middle' }, lines.map((line, row) => h('tspan', { key: row, x: coordinates(position), dy: row ? 18 : 0 }, line))));
    previousLabel = position;
  });
  chart.series.forEach((series, seriesIndex) => {
    const segments = []; let segment = [], last = null;
    const color = seriesColor(series.name, identities[seriesIndex]);
    series.values.forEach((value, index) => {
      if (value === null) { if (segment.length) segments.push(segment); segment = []; return; }
      const point = [coordinates(x(index)), coordinates(y(value))], key = `${seriesIndex}-${index}`;
      const observation = { key, date: chart.categories[index], series: series.name, value, color, x: point[0], y: point[1] };
      observations.push(observation);
      segment.push(point); last = { x: point[0], y: point[1], value, series, seriesIndex, color, height: labelHeights[seriesIndex] };
      const highlighted = activeKey === key || focused === key;
      marks.push(h('circle', { key: `point-${seriesIndex}-${index}`, 'data-chart-mark': 'point', 'data-series': series.name, 'data-value': value,
        cx: point[0], cy: point[1], r: highlighted ? 5 : 2.75, fill: highlighted ? paperColor : color, stroke: color, strokeWidth: highlighted ? 2 : 0 }));
      marks.push(...annotationMarkers(chart, index, seriesIndex, point[0] + 8, point[1] - 12));
      hits.push(h('circle', { key: `hit-${key}`, 'data-chart-hit': true, 'data-chart-point-key': key, 'data-series': series.name, 'data-date': chart.categories[index], 'data-value': value,
        role: 'img', tabIndex: 0, focusable: 'true', 'aria-label': `${chart.categories[index]} · ${series.name}：${formatNumber(value)} ${chart.unit}`,
        cx: point[0], cy: point[1], r: 22, fill: 'transparent', style: { cursor: 'crosshair', outline: 'none' },
        onFocus: () => { setFocused(key); setActiveKey(key); }, onBlur: () => { setFocused(null); setActiveKey(null); }, onKeyDown: event => {
          if (event.key === 'Escape') setActiveKey(null);
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActiveKey(key); }
        } }));
    });
    if (segment.length) segments.push(segment);
    segments.forEach((points, index) => {
      if (points.length > 1) paths.push(h('polyline', { key: `line-${seriesIndex}-${index}`, 'data-chart-mark': 'line', 'data-series': series.name,
        points: points.map(point => point.join(',')).join(' '), fill: 'none', stroke: color, strokeWidth: 2.25,
        strokeDasharray: lineDash(series.name, identities[seriesIndex]), strokeLinejoin: 'round' }));
    });
    if (last) labels.push(last);
  });
  if (!compact) separatedLabels(labels, top, bottom, 8).forEach(label => {
    marks.push(h('path', { key: 'leader-' + label.seriesIndex, 'data-chart-leader': true, 'data-series': label.series.name,
      d: `M ${label.x} ${label.y} L ${coordinates(right + 6)} ${coordinates(label.labelY)} L ${coordinates(right + 10)} ${coordinates(label.labelY)}`,
      stroke: label.color, strokeWidth: 1, fill: 'none' }));
    marks.push(svgLabel(label.series.name, right + 14, label.labelY - label.height / 2 + 14, tailSpace - 18, { key: 'tail-name-' + label.seriesIndex,
      'data-chart-tail-name': true, 'data-series': label.series.name, fill: primaryColor, fontSize: 14 }));
    marks.push(svgLabel(formatNumber(label.value), right + 14, label.labelY + label.height / 2 - 4, tailSpace - 18, { key: 'tail-' + label.seriesIndex,
      'data-chart-value': true, 'data-series': label.series.name, 'data-endpoint-x': label.x, 'data-endpoint-y': label.y,
      fill: primaryColor, fontSize: 15, fontWeight: 600 }));
  });
  const unknown = chart.series.filter(series => series.values.every(value => value === null));
  const selectPoint = event => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = (event.clientX - bounds.left) * plotWidth / bounds.width;
    const pointerY = (event.clientY - bounds.top) * plotHeight / bounds.height;
    let nearest = null, distance = 22;
    for (const point of observations) {
      const candidate = Math.hypot(point.x - pointerX, point.y - pointerY);
      if (candidate <= distance && (!nearest || candidate < distance)) { nearest = point; distance = candidate; }
    }
    if (event.type === 'pointerdown') {
      event.preventDefault();
      if (nearest) event.currentTarget.querySelector(`[data-chart-point-key="${nearest.key}"]`)?.focus();
    }
    setActiveKey(nearest?.key ?? null);
  };
  const active = observations.find(point => point.key === activeKey);
  const readout = active ? `${active.date} · ${observations.filter(point => point.x === active.x && point.y === active.y)
    .map(point => `${point.series} · ${formatNumber(point.value)} ${chart.unit}`).join(' / ')}` : '';
  return h('div', { style: { position: 'relative' } },
    h('div', { style: { overflowX: 'auto', maxWidth: '100%' } }, svg(chart, plotWidth, plotHeight,
      [...marks.filter(mark => mark.type !== 'circle'), ...paths, ...marks.filter(mark => mark.type === 'circle'), ...hits], 'trend', {
        onPointerDown: selectPoint,
        onPointerLeave: event => { if (event.pointerType !== 'touch') setActiveKey(null); },
      })),
    compact ? h('div', { 'data-chart-tails': true, style: { display: 'grid', gap: 6, marginTop: 6 } }, labels.map(label => {
      const valueText = formatNumber(label.value), stack = labelWidth(valueText, 15) > width * .45;
      return h('div', {
      key: label.seriesIndex, style: { display: 'grid', gridTemplateColumns: stack ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, .8fr)', gap: stack ? 4 : 12, alignItems: 'baseline' },
    }, h('span', { 'data-chart-tail-name': true, 'data-series': label.series.name, style: { color: primaryColor, fontSize: 14, overflowWrap: 'anywhere' } },
      h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 18, marginRight: 8, verticalAlign: 'middle',
        borderTopWidth: 2, borderTopStyle: lineStyle(label.series.name, identities[label.seriesIndex]), borderTopColor: label.color } }), label.series.name),
    h('strong', { 'data-chart-value': true, 'data-series': label.series.name, 'data-endpoint-x': label.x, 'data-endpoint-y': label.y,
      style: { color: primaryColor, fontSize: 15, fontWeight: 600, maxWidth: '100%', overflowWrap: 'anywhere', textAlign: stack ? 'left' : 'right' } }, valueText)); })) : null,
    h('div', { 'data-chart-readout': true, role: 'status', 'aria-live': 'polite', style: { position: 'absolute', top: 0, left: 0, maxWidth: '100%', boxSizing: 'border-box',
      zIndex: 1, padding: '3px 6px', border: `1px solid ${borderColor}`, background: paperColor, color: primaryColor, pointerEvents: 'none',
      fontSize: 13, lineHeight: 1.6, fontVariantNumeric: 'tabular-nums', visibility: active ? 'visible' : 'hidden' } },
    readout),
    unknown.length ? h('div', { 'data-chart-no-values': true, style: { marginTop: 4, color: textColor, fontSize: 13 } },
      unknown.map(series => `${series.name}：${english ? 'Unknown' : '未知'}`).join(' · ')) : null);
}

function CompositionChart({ chart, width, english }) {
  const values = chart.series[0].values, total = values.reduce((sum, value) => sum + value, 0);
  const outer = 92, inner = 64;
  const palette = compositionColors(chart.categories), totalText = formatNumber(total);
  const ringSize = 132, centerInset = 28, totalFontSize = totalText.length > 4 ? 20 : 26;
  const compact = width < 500, longTotal = labelWidth(totalText, totalFontSize) > ringSize - centerInset * 2;
  // A divider wider than a small arc erases real data; omit dividers for the whole ring in that case.
  const divider = values.some(value => value > 0 && value / total * Math.PI * 2 * outer < 3) ? 0 : 1.5;
  const point = (radius, angle) => `${coordinates(100 + radius * Math.cos(angle))} ${coordinates(100 + radius * Math.sin(angle))}`;
  let angle = -Math.PI / 2;
  const wedges = values.map((value, index) => {
    const fraction = value / total, end = angle + fraction * Math.PI * 2;
    // Adjacent sectors share exact radial edges; browser stroke dashes do not define their geometry.
    const path = fraction === 1
      ? `M 100 ${100 - outer} A ${outer} ${outer} 0 1 1 100 ${100 + outer} A ${outer} ${outer} 0 1 1 100 ${100 - outer} Z M 100 ${100 - inner} A ${inner} ${inner} 0 1 1 100 ${100 + inner} A ${inner} ${inner} 0 1 1 100 ${100 - inner} Z`
      : fraction > 0.5
        // Two arcs retain a near-complete sector even when its two radial edges round to the same pixel.
        ? `M ${point(outer, angle)} A ${outer} ${outer} 0 0 1 ${point(outer, (angle + end) / 2)} A ${outer} ${outer} 0 0 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 0 0 ${point(inner, (angle + end) / 2)} A ${inner} ${inner} 0 0 0 ${point(inner, angle)} Z`
        : `M ${point(outer, angle)} A ${outer} ${outer} 0 0 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 0 0 ${point(inner, angle)} Z`;
    angle = end;
    return value === 0 ? null : h('path', { key: index, 'data-chart-mark': 'wedge', 'data-category': chart.categories[index], 'data-value': value,
      d: path, fill: palette[index], fillRule: 'evenodd', stroke: paperColor, strokeWidth: divider });
  });
  const columns = compact ? 'minmax(0, 1fr) minmax(56px, max-content)' : 'minmax(0, 1fr) minmax(0, .7fr) minmax(56px, .55fr)';
  const totalValue = h('strong', { 'data-chart-total': true, style: { display: 'block', color: primaryColor, fontWeight: 500,
    fontSize: longTotal ? 14 : totalFontSize, lineHeight: longTotal ? 1.6 : 1.15,
    maxWidth: '100%', overflowWrap: 'anywhere', textAlign: 'center', fontVariantNumeric: 'tabular-nums' } }, numberText(totalText));
  return h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px 20px', margin: 0 } },
    h('div', { style: { width: ringSize, flex: `0 0 ${ringSize}px`, maxWidth: '100%' } }, h('div', { style: { position: 'relative', height: ringSize } },
      h('svg', { role: 'img', 'aria-label': `${chart.title}，总数 ${formatNumber(total)} ${chart.unit}`, 'data-chart-type': 'pie', 'data-chart-template': compact ? 'composition-compact' : 'composition',
        width: ringSize, height: ringSize, viewBox: '0 0 200 200', style: { display: 'block', maxWidth: '100%' } }, wedges),
      h('div', { 'data-chart-denominator': true, style: { position: 'absolute', inset: centerInset, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, textAlign: 'center', fontVariantNumeric: 'tabular-nums' } },
        h('span', { style: { color: textColor, fontSize: 12 } }, english ? 'Total' : '合计'),
        longTotal ? null : totalValue)), longTotal ? totalValue : null),
    h('div', { style: { flex: '1 1 220px', minWidth: 0, fontVariantNumeric: 'tabular-nums' } },
      h('div', { 'aria-hidden': true, style: { display: 'grid', gridTemplateColumns: columns, gap: 12, paddingBottom: 6, fontSize: 12, color: textColor } },
        compact ? null : h('span', null, english ? 'Category' : '类别'), h('span', { style: { textAlign: compact ? 'left' : 'right' } }, chart.unit), h('span', { style: { textAlign: 'right' } }, english ? 'Share' : '占比')),
      h('ul', { 'data-chart-composition': true, style: { listStyle: 'none', margin: 0, padding: 0 } }, chart.categories.map((category, index) => h('li', {
        key: index, style: { display: 'grid', gridTemplateColumns: columns, gap: '4px 12px', alignItems: 'baseline', padding: '6px 0', borderTop: `1px solid ${borderColor}` },
      }, h('span', { style: { gridColumn: compact ? '1 / -1' : undefined, color: primaryColor, overflowWrap: 'anywhere', fontSize: 14 } }, h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 7, height: 7, marginRight: 8, background: palette[index] } }), category, ...(chart.annotations ?? []).flatMap((a, i) => a.categoryIndex === index ? [h('sup', { key: i, 'data-chart-annotation-marker': true, style: { marginLeft: 3 } }, String(i + 1))] : [])),
      h('strong', { 'data-chart-composition-value': true, style: { color: primaryColor, fontSize: formatNumber(values[index]).length > 12 ? 14 : 16,
        textAlign: compact ? 'left' : 'right', paddingLeft: compact ? 15 : 0, gridColumn: compact && labelWidth(formatNumber(values[index]), 14) > width * .55 ? '1 / -1' : undefined,
        fontWeight: 500, overflowWrap: 'anywhere' } }, numberText(formatNumber(values[index]))),
      h('span', { 'data-chart-share': true, style: { color: textColor, fontSize: 14, gridColumn: compact ? 2 : undefined, textAlign: 'right', whiteSpace: 'nowrap' } }, formatPercentage(values[index] / total * 100)))))));
}

const actionStyle = { border: `1px solid ${borderColor}`, borderRadius: 5, background: paperColor, color: textColor, padding: '5px 9px', minHeight: 28, font: 'inherit', fontSize: 12, cursor: 'pointer' };
// Exact observations remain available to screen readers without a second visual representation.
function AccessibleValues({ chart, english }) {
  const valueText = value => value === null ? (english ? 'Unknown' : '未知') : formatNumber(value);
  const total = chart.type === 'pie' ? chart.series[0].values.reduce((sum, value) => sum + value, 0) : null;
  return h('dl', { 'data-chart-accessible-data': true, style: visuallyHidden }, chart.categories.map((category, index) =>
    h('div', { key: index }, h('dt', null, category), h('dd', null,
      ['scatter', 'bubble'].includes(chart.type) ? `${chart.xLabel}：${valueText(chart.xValues[index])} ${chart.xUnit} · ` : '',
      chart.series.map(series => `${series.name}：${valueText(series.values[index])} ${chart.unit}${chart.type === 'interval' ? ` [${valueText(series.lowerValues[index])}, ${valueText(series.upperValues[index])}]` : ''}`).join(' · '),
      chart.type === 'bubble' ? ` · ${chart.sizeLabel}：${valueText(chart.sizeValues[index])} ${chart.sizeUnit}` : '',
      total === null ? '' : ` · ${formatPercentage(chart.series[0].values[index] / total * 100)} (${formatNumber(chart.series[0].values[index])}/${formatNumber(total)})`))));
}
let researchModule;
function AdvancedChart(props) {
  const [component, setComponent] = useState(() => researchModule?.ResearchChart), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (component) return;
    let active = true;
    import('./chart-research.js').then(module => { researchModule = module; if (active) { setComponent(() => module.ResearchChart); setError(''); } }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [component, retry]);
  return component ? h(component, props) : h('div', { role: error ? 'alert' : 'status', style: { minHeight: 200, display: 'grid', placeContent: 'center', fontSize: 12 } },
    error ? h('button', { className: 'eris-chart-action', style: actionStyle, onClick: () => { setError(''); setRetry(value => value + 1); } }, '重新载入图表') : '图表载入中…');
}
export const AnalysisChart = memo(function AnalysisChart({ chart, language = 'zh' }) {
  const [ref, width] = useWidth();
  const identities = seriesIndexes(chart), advanced = researchTypes.includes(chart.type);
  const english = !language.startsWith('zh');
  const legend = chart.series.length > 1 && ['dot', 'scatter', 'bubble', 'dumbbell', 'slope', 'bump', 'ecdf'].includes(chart.type);
  return h('figure', { ref, className: 'eris-analysis-chart', 'data-analysis-chart': chart.type, style: {
    position: 'relative', margin: '14px auto', minWidth: 0, width: '100%', maxWidth: chartMaxWidth, padding: '12px', boxSizing: 'border-box', background: paperColor,
    border: `1px solid ${borderColor}`, borderRadius: 8, color: textColor, fontSize: 'var(--dsh-content-font-size, 14px)', overflowWrap: 'anywhere',
  } }, h('figcaption', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 12px' } },
    h('h3', { style: { margin: 0, color: primaryColor, fontSize: 15, lineHeight: 1.4, fontWeight: 600 } }, chart.title),
    h('span', { 'data-chart-unit': true, style: { fontSize: 14, lineHeight: 1.45 } }, chart.unit)),
  h('p', { 'data-chart-metadata': true, style: visuallyHidden }, `${chart.scope} · ${english ? 'Source' : '来源'}：${chart.source}`),
  legend ? h('div', { 'data-chart-legend': true, style: { display: 'flex', overflowX: 'auto', gap: 14, marginTop: 6, fontSize: 14 } }, chart.series.map((series, index) => h('span', { key: index, style: { color: primaryColor, whiteSpace: 'nowrap', flexShrink: 0 } },
    h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 8, height: 8, marginRight: 6, verticalAlign: 'middle', background: seriesColor(series.name, identities[index]) } }), series.name))) : null,
  h('div', { 'data-chart-plot': true, style: { marginTop: 6 } }, advanced ? h(AdvancedChart, { chart, width, english }) : circularTypes.includes(chart.type) ? h(CircularChart, { chart, width, english }) : chart.type === 'radial_heatmap' ? h(RadialHeatmap, { chart, width, english }) : chart.type === 'pie' ? h(CompositionChart, { chart, width, english })
    : chart.type === 'dot' ? h(ComparisonChart, { chart, width, english }) : h(TrendChart, { chart, width, english })),
  h(AccessibleValues, { chart, english }),
  chart.annotations?.length ? h('ol', { 'data-chart-annotations': true, style: { margin: '4px 0 0', padding: '0 0 0 18px', fontSize: 14, lineHeight: 1.45, color: primaryColor } }, chart.annotations.map((a, i) => h('li', { key: i }, a.note))) : null);
});
