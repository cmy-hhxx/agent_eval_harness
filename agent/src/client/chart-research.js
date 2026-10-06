import { createElement as h, memo, useEffect, useRef, useState } from 'react';
import { init, use } from 'echarts/core';
import { BarChart, ScatterChart, HeatmapChart, CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, VisualMapComponent, MarkPointComponent, AriaComponent, MarkLineComponent, MarkAreaComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { histogramBins, waterfallSteps, researchColors, chartReading, pairedDifferences, differenceUnit, quantile, compactNumber, signedNumber } from './chart-data.js';
use([BarChart, ScatterChart, HeatmapChart, CustomChart, GridComponent, TooltipComponent, VisualMapComponent, MarkPointComponent, AriaComponent, MarkLineComponent, MarkAreaComponent, SVGRenderer]);

const ink = '#191919', muted = '#676767', grid = '#e5e5e5';
const display = compactNumber;
const identity = name => /^([ABC])(?=$|[\s:：·/(_-]|组|組)/i.test(name.trim()) ? name.trim()[0].toUpperCase().charCodeAt(0) - 65 : null;
const axis = { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 12 }, splitLine: { lineStyle: { color: grid } }, nameTextStyle: { color: muted, fontSize: 12 } };
const point = (chart, seriesIndex, categoryIndex, value) => ({ value, name: chart.categories[categoryIndex], categoryIndex, sourceSeries: seriesIndex });
export function researchOption(chart, width = 560) {
  const compact = width < 480;
  const indices = chart.series.map(s => identity(s.name)), available = [0, 1, 2, 3].filter(i => !indices.includes(i));
  const palette = indices.map(i => researchColors[i ?? available.shift()]);
  const option = { animation: false, color: researchColors, textStyle: { fontFamily: 'system-ui, sans-serif' },
    aria: { enabled: true, label: { description: `${chart.title}。${chart.scope}。${chart.unit}。${chart.source}。方向键查看数值，Escape收起。` } },
    grid: { left: 4, right: 18, top: 18, bottom: 22, outerBoundsMode: 'same', outerBoundsContain: 'all' },
    tooltip: { show: false, triggerOn: 'none' },
    xAxis: { ...axis, type: 'value', name: chart.unit, nameLocation: 'middle', nameGap: 20 },
    yAxis: { ...axis, type: 'category', data: chart.categories, inverse: true, splitLine: { show: false }, axisLabel: { ...axis.axisLabel, width: compact ? 78 : 105, overflow: 'break' } }, series: [],
  };
  if (chart.type === 'dumbbell') {
    option.xAxis.scale = true;
    option.xAxis.min = ({ min, max }) => min - (max === min ? Math.max(1, Math.abs(min) * .05) : (max - min) * .12);
    option.xAxis.max = ({ min, max }) => max + (max === min ? Math.max(1, Math.abs(max) * .05) : (max - min) * .12);
    option.grid.right = 75;
    const deltas = pairedDifferences(chart);
    option.series = [{ type: 'custom', silent: true, tooltip: { show: false }, encode: { x: [0, 2], y: 1 },
      data: chart.categories.flatMap((_, i) => chart.series.every(s => s.values[i] !== null) ? [[chart.series[0].values[i], i, chart.series[1].values[i]]] : []),
      renderItem: (params, api) => { const a = api.coord([api.value(0), api.value(1)]), b = api.coord([api.value(2), api.value(1)]), delta = deltas[api.value(1)].value;
        return { type: 'group', children: [
          { type: 'line', shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style: { stroke: '#c6b7bb', lineWidth: 2 } },
          { type: 'text', style: { x: params.coordSys.x + params.coordSys.width + 16, y: a[1], text: `Δ ${signedNumber(delta)}`, verticalAlign: 'middle', fill: delta > 0 ? '#774143' : '#676767', font: '600 11px system-ui' } },
        ] };
      },
    }, ...chart.series.map((s, si) => ({ name: s.name, type: 'scatter', symbol: si === 0 ? 'circle' : 'diamond', symbolSize: 8, itemStyle: { color: palette[si], borderWidth: 1.5, borderColor: '#fff' },
      label: { show: true, distance: 4, fontSize: 10, color: palette[si], formatter: p => display(p.value[0]) },
      data: s.values.flatMap((value, ci) => { if (value === null) return []; const other = chart.series[1 - si].values[ci]; return [{ ...point(chart, si, ci, [value, ci]), label: { position: other === null ? si === 0 ? 'left' : 'right' : value < other || (value === other && si === 0) ? 'left' : 'right' } }]; }),
    }))];
  } else if (chart.type === 'heatmap') {
    const values = chart.series.flatMap(s => s.values).filter(v => v !== null), hasNegative = values.some(v => v < 0), extent = Math.max(...values.map(Math.abs));
    const min = hasNegative ? -extent : 0, max = hasNegative ? extent : Math.max(...values);
    option.grid.bottom = 44;
    const differences = pairedDifferences(chart), hasDifferences = differences.length > 0;
    option.xAxis = { ...axis, type: 'category', data: chart.categories, splitArea: { show: false }, axisLabel: { ...axis.axisLabel, interval: 0, rotate: chart.categories.length > 5 ? 35 : 0, width: Math.min(78, Math.max(28, (width - 110) / chart.categories.length - 4)), lineHeight: 16, overflow: 'break' } };
    option.yAxis.data = [...chart.series.map(s => s.name), ...(hasDifferences ? [`Δ ${chart.series[1].name}−${chart.series[0].name}\n${differenceUnit(chart)}`] : [])];
    option.visualMap = { type: 'continuous', min, max: max === min ? min + 1 : max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: Math.min(120, width - 80), itemWidth: 5, text: [display(max), display(min)], textStyle: { color: muted }, inRange: { color: min < 0 ? ['#676767', '#f5f3f1', '#774143'] : ['#f5f3f1', '#bb9899', '#774143'] }, seriesIndex: 0 };
    option.series = [{ type: 'heatmap', name: chart.unit,
      data: chart.series.flatMap((s, si) => s.values.flatMap((value, ci) => value === null ? [] : [{ ...point(chart, si, ci, [ci, si, value]), label: { color: Math.abs(value) / Math.max(Number.MIN_VALUE, value < 0 ? Math.abs(min) : max) > .6 ? '#fff' : ink } }])),
      itemStyle: { borderWidth: 2, borderColor: '#fff' }, label: { show: chart.categories.length <= 12, fontSize: 12, formatter: p => display(p.value[2]) }, emphasis: { itemStyle: { borderColor: ink, borderWidth: 2 } },
    }, { type: 'scatter', symbolSize: 0, itemStyle: { color: 'transparent' }, label: { show: true, formatter: '—', color: '#999', opacity: 1, fontSize: 14, position: 'inside' },
      data: chart.series.flatMap((s, si) => s.values.flatMap((value, ci) => value === null ? [point(chart, si, ci, [ci, si])] : [])),
    }];
    if (hasDifferences) option.series.push({ type: 'custom', name: `${chart.series[1].name} − ${chart.series[0].name}`,
      data: differences.map(d => ({ value: [d.index, chart.series.length], categoryIndex: d.index, derived: 'difference', name: d.name })),
      renderItem: (_, api) => {
        const ci = api.value(0), center = api.coord([ci, api.value(1)]), size = api.size([1, 1]), value = differences[ci].value;
        return { type: 'group', children: [
          { type: 'rect', shape: { x: center[0] - size[0] / 2 + 1, y: center[1] - size[1] / 2 + 2, width: size[0] - 2, height: size[1] - 4 }, style: { fill: '#f6f2f3' } },
          { type: 'text', style: { x: center[0], y: center[1], text: value === null ? '—' : signedNumber(value), align: 'center', verticalAlign: 'middle', fill: value > 0 ? '#774143' : '#676767', font: '600 11px system-ui' } },
        ] };
      },
    });
  } else if (chart.type === 'scatter') {
    option.xAxis = { ...axis, type: 'value', scale: true, name: `${chart.xLabel} · ${chart.xUnit}`, nameLocation: 'middle', nameGap: 24 };
    option.yAxis = { ...axis, type: 'value', scale: true, name: chart.unit };
    option.grid = { ...option.grid, left: 4, bottom: 28 };
    option.series = chart.series.map((s, si) => ({ type: 'scatter', name: s.name, symbolSize: 8, itemStyle: { color: palette[si], opacity: .8, borderColor: '#fff', borderWidth: 1 },
      emphasis: { scale: 1.4 }, data: s.values.flatMap((value, ci) => value === null || chart.xValues[ci] === null ? [] : [point(chart, si, ci, [chart.xValues[ci], value])]),
    }));
    const paired = option.series.flatMap(s => s.data.map(d => d.value));
    option.series[0].markLine = { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: '#bda7ae', type: 'dashed', width: 1 },
      data: [{ xAxis: quantile(paired.map(p => p[0]), .5) }, { yAxis: quantile(paired.map(p => p[1]), .5) }],
    };
  } else if (chart.type === 'waterfall') {
    const steps = waterfallSteps(chart);
    option.xAxis = { ...axis, type: 'category', data: steps.map(s => s.name), splitLine: { show: false }, axisLabel: { ...axis.axisLabel, interval: 0, rotate: steps.length > 5 ? 30 : 0, width: compact ? 60 : 95, overflow: 'break' } };
    option.yAxis = { ...axis, type: 'value', name: chart.unit };
    option.series = [{ type: 'custom', encode: { x: 0, y: [1, 2] }, data: steps.map((s, i) => [i, s.start, s.end]),
      renderItem: (params, api) => {
        const step = steps[params.dataIndex], a = api.coord([api.value(0), api.value(1)]), b = api.coord([api.value(0), api.value(2)]), barWidth = Math.min(32, api.size([1, 0])[0] * .5);
        return { type: 'group', children: [
          ...(params.dataIndex < steps.length - 1 ? [{ type: 'line', shape: { x1: a[0] + barWidth / 2, y1: b[1], x2: api.coord([params.dataIndex + 1, step.end])[0] - barWidth / 2, y2: b[1] }, style: { stroke: '#c8bbbf', lineWidth: 1, lineDash: [3, 3] } }] : []),
          { type: 'rect', shape: { x: a[0] - barWidth / 2, y: Math.min(a[1], b[1]), width: barWidth, height: Math.max(1, Math.abs(a[1] - b[1])) }, style: { fill: step.total ? '#191919' : step.value < 0 ? '#774143' : '#969696' } },
          { type: 'text', style: { x: a[0], y: Math.min(a[1], b[1]) - 8, text: `${params.dataIndex > 0 && step.value > 0 && !step.total ? '+' : ''}${display(step.value)}`, align: 'center', verticalAlign: 'bottom', fill: ink, fontSize: 11 } },
        ] };
      },
    }];
  } else if (chart.type === 'histogram') {
    const samples = chart.series[0].values, bins = histogramBins(samples), median = quantile(samples, .5);
    option.xAxis = { ...axis, type: 'value', min: Math.min(...samples), max: Math.max(...samples) === Math.min(...samples) ? Math.max(...samples) + 1 : Math.max(...samples), name: chart.unit, nameLocation: 'middle', nameGap: 22, splitLine: { show: false } };
    option.yAxis = { ...axis, type: 'value', name: '样本数', minInterval: 1 };
    option.grid.bottom = 30;
    option.series = [{ type: 'custom', encode: { x: [0, 1], y: 2 }, data: bins.map(b => [b.low, b.high, b.count]),
      renderItem: (_, api) => { const left = api.coord([api.value(0), 0]), right = api.coord([api.value(1), api.value(2)]);
        return { type: 'group', children: [{ type: 'rect', shape: { x: left[0] + 1, y: right[1], width: Math.max(2, right[0] - left[0] - 2), height: Math.max(0, left[1] - right[1]) }, style: { fill: '#817176', opacity: .82 } }, { type: 'text', style: { x: (left[0] + right[0]) / 2, y: right[1] - 5, text: String(api.value(2)), align: 'center', verticalAlign: 'bottom', fill: ink, fontSize: 10 } }] };
      },
      markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: '#774143', width: 1.5 }, data: [{ xAxis: median }] },
      markArea: { silent: true, itemStyle: { color: 'rgba(119,65,67,.07)' }, data: [[{ xAxis: quantile(samples, .25) }, { xAxis: quantile(samples, .75) }]] },
    }, { type: 'scatter', silent: true, symbol: 'rect', symbolSize: [2, 6], symbolOffset: [0, 5], itemStyle: { color: '#774143', opacity: .7 }, data: samples.map(v => [v, 0]) }];
  }
  // Numbered markers point to real values; the full notes stay legible below the plot.
  (chart.annotations ?? []).forEach((a, index) => {
    const value = chart.series[a.seriesIndex].values[a.categoryIndex];
    let seriesIndex = a.seriesIndex, coord;
    if (chart.type === 'heatmap') {
      option.series.push({ type: 'scatter', silent: true, z: 20, symbol: 'circle', symbolSize: 15, symbolOffset: [-24, -7],
        itemStyle: { color: '#fff', borderColor: '#774143', borderWidth: 1.5 }, label: { show: true, formatter: String(index + 1), position: 'inside', color: '#774143', opacity: 1, fontSize: 11 },
        data: [[a.categoryIndex, a.seriesIndex]],
      });
      return;
    }
    if (chart.type === 'scatter') coord = [chart.xValues[a.categoryIndex], value];
    if (chart.type === 'dumbbell') { seriesIndex++; coord = [value, a.categoryIndex]; }
    if (chart.type === 'waterfall') { seriesIndex = 0; coord = [a.categoryIndex, waterfallSteps(chart)[a.categoryIndex].end]; }
    if (chart.type === 'histogram') { seriesIndex = 0; const bins = histogramBins(chart.series[0].values); coord = [value, bins.find(b => value >= b.low && (value < b.high || b.last)).count]; }
    const series = option.series[seriesIndex];
    if (series && coord) { series.markPoint ??= { symbol: 'circle', symbolSize: 16, symbolOffset: [8, -11], itemStyle: { color: '#774143' }, label: { color: '#fff', fontSize: 11 }, data: [] }; series.markPoint.data.push({ coord, value: index + 1, name: a.note }); }
  });
  for (const series of option.series) series.emphasis = { ...series.emphasis, label: { ...series.emphasis?.label, show: series.label?.show === true } };
  return option;
}

export const ResearchChart = memo(function ResearchChart({ chart, width, english }) {
  const ref = useRef(null), instance = useRef(null), active = useRef(-1);
  const [reading, setReading] = useState('');
  const height = chart.type === 'heatmap' ? Math.max(168, (chart.series.length + (chart.series.length === 2 ? 1 : 0)) * 30 + 62) : chart.type === 'dumbbell' ? Math.max(170, chart.categories.length * 34 + 52) : 220;
  useEffect(() => {
    const engine = init(ref.current, null, { renderer: 'svg' }); instance.current = engine;
    const observer = new ResizeObserver(() => { if (ref.current?.clientWidth > 0) engine.resize(); }); observer.observe(ref.current);
    return () => { observer.disconnect(); engine.dispose(); instance.current = null; };
  }, []);
  useEffect(() => {
    instance.current?.setOption(researchOption(chart, width), { notMerge: true });
    active.current = -1; setReading('');
  }, [chart, width]);
  const inspect = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const engine = instance.current; if (!engine) return;
    if (event.key === 'Escape') { engine.dispatchAction({ type: 'downplay' }); setReading(''); return; }
    const option = researchOption(chart, width), choices = option.series.flatMap((s, si) => s.silent ? [] : s.data.map((data, di) => ({ si, di, data })));
    if (!choices.length) return;
    active.current = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (active.current + (event.key === 'ArrowLeft' ? -1 : 1) + choices.length) % choices.length;
    const selected = choices[active.current]; engine.dispatchAction({ type: 'downplay' }); engine.dispatchAction({ type: 'highlight', seriesIndex: selected.si, dataIndex: selected.di });
    setReading(chartReading(chart, selected.data, selected.di));
  };
  return h('div', { 'data-research-chart': chart.type }, h('div', { ref, tabIndex: 0, role: 'group', 'aria-label': `${chart.title} · ${english ? 'Use arrow keys to inspect' : '方向键查看数据'}`, onKeyDown: inspect, style: { width: '100%', height } }),
    h('div', { 'aria-live': 'polite', style: { minHeight: reading ? 20 : 0, fontSize: 12, color: muted } }, reading));
});
