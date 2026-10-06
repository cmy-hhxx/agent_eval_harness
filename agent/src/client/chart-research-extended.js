import { chartTextWidth } from './chart-layout.js';
import { chartTheme as theme } from './chart-theme.js';
import { boxSummary, violinDensity, compactNumber as display } from './chart-data.js';

/** Additional templates share the same accepted data, axes and keyboard readout. */
export function extendedResearchOption(option, chart, { width, palette, axis, point }) {
  if (chart.type === 'bubble') {
    const maximum = Math.max(...chart.sizeValues.filter(v => v !== null));
    option.xAxis = { ...axis, type: 'value', scale: true, name: `${chart.xLabel} · ${chart.xUnit}`, nameLocation: 'middle', nameGap: 34 };
    option.yAxis = { ...axis, type: 'value', scale: true };
    option.grid.bottom = 28;
    option.series = chart.series.map((s, si) => ({ name: s.name, type: 'scatter',
      symbolSize: value => maximum === 0 ? 0 : 30 * Math.sqrt(value[2] / maximum),
      itemStyle: { color: palette[si], opacity: .8, borderColor: theme.royal, borderWidth: .6 },
      data: s.values.flatMap((y, ci) => y === null || chart.xValues[ci] === null || chart.sizeValues[ci] === null ? [] : [point(chart, si, ci, [chart.xValues[ci], y, chart.sizeValues[ci]])]) }));
    // Explicit size key: area, not radius, is proportional to the third metric.
    option.graphic = { type: 'text', right: 4, top: 0, style: { text: `${chart.sizeLabel} · ${chart.sizeUnit}`, fill: theme.muted, fontSize: 11 } };
  } else if (chart.type === 'bubble_matrix') {
    const maximum = Math.max(...chart.series.flatMap(s => s.values).filter(v => v !== null));
    const diameter = Math.min(26, Math.max(8, (width - 110) / chart.categories.length - 8));
    option.xAxis = { ...axis, type: 'category', data: chart.categories, splitLine: { show: false }, axisLabel: { ...axis.axisLabel, interval: 0, lineHeight: 18 } };
    option.yAxis.data = chart.series.map(s => s.name);
    option.series = [{ type: 'scatter', symbolSize: value => value[2] === null ? 7 : maximum === 0 ? 0 : diameter * Math.sqrt(value[2] / maximum),
      label: { show: true, position: 'right', color: theme.ink, fontSize: 10, formatter: p => p.value[2] === null ? '—' : display(p.value[2]) },
      data: chart.series.flatMap((s, si) => s.values.map((value, ci) => ({ ...point(chart, si, ci, [ci, si, value]),
        itemStyle: { color: value === null ? 'transparent' : palette[si], borderWidth: value === null ? 1 : 0, borderColor: theme.muted } }))) }];
  } else if (['slope', 'bump'].includes(chart.type)) {
    const ranking = chart.type === 'bump';
    option.grid = { ...option.grid, left: 10, right: 18, top: 18, bottom: 22 };
    option.xAxis = { ...axis, type: 'category', data: chart.categories, boundaryGap: false, splitLine: { show: false }, axisLabel: { ...axis.axisLabel, interval: 0, lineHeight: 18 } };
    option.yAxis = { ...axis, type: 'value', inverse: ranking, scale: !ranking, min: ranking ? 1 : undefined, minInterval: ranking ? 1 : 0 };
    option.series = chart.series.map((s, si) => ({ type: 'line', name: s.name, connectNulls: false, symbol: 'circle', symbolSize: 7,
      lineStyle: { width: 2, color: palette[si] }, itemStyle: { color: palette[si], borderColor: theme.royal, borderWidth: .6 },
      label: { show: true, color: theme.ink, fontSize: 10, formatter: p => p.value == null ? '' : display(p.value) },
      endLabel: { show: false }, labelLayout: { hideOverlap: true },
      data: s.values.map((v, ci) => ({ ...point(chart, si, ci, v) })) }));
  } else if (chart.type === 'interval') {
    const rows = chart.categories.flatMap((category, ci) => chart.series.map((s, si) => ({ category, ci, si, s })));
    option.yAxis.data = rows.map(row => chart.series.length === 1 ? row.category : `${row.category} · ${row.s.name}`);
    option.xAxis.scale = true;
    option.series = [{ type: 'custom', encode: { x: [0, 1, 2], y: 3 },
      data: rows.flatMap(({ s, ci, si }, index) => s.values[ci] === null ? [] : [point(chart, si, ci, [s.lowerValues[ci], s.upperValues[ci], s.values[ci], index])]),
      renderItem: (params, api) => {
        const y = api.value(3), low = api.coord([api.value(0), y]), high = api.coord([api.value(1), y]), center = api.coord([api.value(2), y]);
        const color = palette[rows[y].si];
        const label = `${display(api.value(2))} [${display(api.value(0))}, ${display(api.value(1))}]`;
        const half = chartTextWidth(label, 10) / 2;
        const labelX = Math.max(params.coordSys.x + half, Math.min(center[0], params.coordSys.x + params.coordSys.width - half));
        return { type: 'group', children: [
          { type: 'line', shape: { x1: low[0], y1: low[1], x2: high[0], y2: high[1] }, style: { stroke: color, lineWidth: 2 } },
          ...[low, high].map(p => ({ type: 'line', shape: { x1: p[0], y1: p[1] - 4, x2: p[0], y2: p[1] + 4 }, style: { stroke: theme.royal, lineWidth: 1 } })),
          { type: 'circle', shape: { cx: center[0], cy: center[1], r: 4 }, style: { fill: color, stroke: theme.royal, lineWidth: 1 } },
          { type: 'text', style: { x: labelX, y: center[1] - 8, text: label, align: 'center', verticalAlign: 'bottom', fill: theme.ink, fontSize: 10 } },
        ] };
      } }];
  } else if (['boxplot', 'violin'].includes(chart.type)) {
    const boxes = chart.series.map(s => boxSummary(s.values));
    option.xAxis = { ...axis, type: 'category', data: chart.series.map(s => s.name), splitLine: { show: false } };
    option.yAxis = { ...axis, type: 'value', scale: true };
    const boxSeries = { type: 'boxplot', boxWidth: [10, 22], silent: true,
      data: boxes.map((b, i) => ({ value: [b.low, b.q1, b.median, b.q3, b.high], itemStyle: { color: palette[i], borderColor: theme.navy, opacity: .8 } })) };
    const observations = chart.series.map((s, si) => ({ type: 'scatter', name: s.name, symbolSize: 4,
      data: s.values.flatMap((value, ci) => value === null ? [] : [{ ...point(chart, si, ci, [si, value]), symbolOffset: [((ci * 7) % 9 - 4) * 2.2, 0] }]),
      itemStyle: { color: theme.navy, opacity: .55 } }));
    option.series = [boxSeries, ...observations];
    if (chart.type === 'violin') {
      const density = violinDensity(chart.series);
      option.series.unshift({ type: 'custom', silent: true, encode: { x: 0, y: [1, 2] },
        data: density.groups.map((group, si) => [si, group[0].value, group.at(-1).value]),
        renderItem: (params, api) => {
          const si = params.dataIndex, center = api.coord([si, 0])[0], half = Math.min(35, api.size([1, 0])[0] * .35);
          const side = direction => density.groups[si].map(p => [center + direction * half * p.density / density.maximum, api.coord([si, p.value])[1]]);
          return { type: 'polygon', shape: { points: [...side(-1), ...side(1).reverse()] }, style: { fill: palette[si], stroke: theme.royal, opacity: .65, lineWidth: .8 } };
        } });
    }
  }
}
