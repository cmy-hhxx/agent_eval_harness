// Derived display data only. Source values and accepted receipts stay unchanged.
export const researchTypes = ['dumbbell', 'heatmap', 'scatter', 'waterfall', 'histogram'];
export const researchColors = ['#676767', '#774143', '#424242', '#A97073'];
export const differenceUnit = (chart, english = false) => ['%', '％'].includes(chart.unit) ? english ? 'pp' : '百分点' : chart.unit;
export const compactNumber = value => {
  const rounded = Number(value.toPrecision(6)), magnitude = Math.abs(rounded);
  return magnitude !== 0 && (magnitude < 0.0001 || magnitude >= 1e7)
    ? rounded.toExponential().replace('e+', 'E').replace('e', 'E')
    : rounded.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
};
export const signedNumber = value => `${value > 0 ? '+' : ''}${compactNumber(value)}`;
export function decimalSum(values) {
  const parts = values.map(value => {
    const [coefficient, power = '0'] = String(value).split('e');
    const decimals = coefficient.split('.')[1]?.length ?? 0;
    return { integer: BigInt(coefficient.replace('.', '')), exponent: Number(power) - decimals };
  });
  const exponent = Math.min(...parts.map(p => p.exponent));
  const integer = parts.reduce((sum, p) => sum + p.integer * 10n ** BigInt(p.exponent - exponent), 0n);
  return Number(`${integer}e${exponent}`);
}
export function histogramBins(values) {
  const minimum = Math.min(...values), maximum = Math.max(...values);
  if (minimum === maximum) return [{ low: minimum, high: maximum, count: values.length, last: true }];
  let count = Math.min(12, Math.max(2, Math.ceil(Math.sqrt(values.length))));
  while (count > 1 && Array.from({ length: count + 1 }, (_, i) => minimum + (maximum - minimum) * i / count).some((v, i, a) => i > 0 && v <= a[i - 1])) count--;
  const step = (maximum - minimum) / count;
  const bins = Array.from({ length: count }, (_, index) => ({ low: minimum + index * step, high: index === count - 1 ? maximum : minimum + (index + 1) * step, count: 0, last: index === count - 1 }));
  values.forEach(value => { bins[Math.min(count - 1, Math.floor((value - minimum) / step))].count++; });
  return bins;
}
export function waterfallSteps(chart) {
  let total = 0;
  const steps = chart.series[0].values.map((value, index) => {
    const start = total; total = decimalSum(chart.series[0].values.slice(0, index + 1));
    return { name: chart.categories[index], start, end: total, value, total: false };
  });
  return [...steps, { name: '合计', start: 0, end: total, value: total, total: true }];
}
export function pairedDifferences(chart) {
  if (chart.series.length !== 2) return [];
  return chart.categories.map((name, index) => ({ name, index, value: chart.series.every(s => s.values[index] !== null)
    ? decimalSum([chart.series[1].values[index], -chart.series[0].values[index]]) : null }));
}
/** Linear interpolation between adjacent ranks (R7); used only on observed values. */
export function quantile(values, probability) {
  const sorted = values.toSorted((a, b) => a - b), position = (sorted.length - 1) * probability, lower = Math.floor(position);
  return decimalSum([sorted[lower], (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower)]);
}
export function chartSummary(chart, english = false) {
  if (chart.type === 'dumbbell') {
    const pairs = pairedDifferences(chart).filter(p => p.value !== null), peak = pairs.toSorted((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
    return [{ label: english ? 'Paired' : '有效配对', value: `${pairs.length}/${chart.categories.length}` },
      ...(peak ? [{ label: `${english ? 'Max Δ' : '最大差值'} · ${chart.series[1].name}−${chart.series[0].name}`, value: `${peak.name} ${signedNumber(peak.value)} ${differenceUnit(chart, english)}` }] : [])];
  }
  if (chart.type === 'heatmap') {
    const values = chart.series.flatMap(s => s.values), known = values.filter(v => v !== null);
    return [{ label: english ? 'Matrix' : '矩阵', value: `${chart.series.length} × ${chart.categories.length}` }, { label: english ? 'Recorded' : '有记录', value: `${known.length}/${values.length}` }];
  }
  if (chart.type === 'scatter') {
    const pairs = chart.series.flatMap(s => s.values.flatMap((y, i) => y !== null && chart.xValues[i] !== null ? [{ x: chart.xValues[i], y }] : []));
    return [{ label: english ? 'Points' : '观测点', value: String(pairs.length) },
      { label: `${chart.xLabel}${english ? ' median' : '中位'}`, value: `${compactNumber(quantile(pairs.map(p => p.x), .5))} ${chart.xUnit}` },
      { label: english ? 'Y median' : '纵轴中位', value: `${compactNumber(quantile(pairs.map(p => p.y), .5))} ${chart.unit}` }];
  }
  if (chart.type === 'histogram') {
    const values = chart.series[0].values;
    return [{ label: english ? 'Observations' : '观测数', value: String(values.length) }, { label: english ? 'Median' : '中位数', value: `${compactNumber(quantile(values, .5))} ${chart.unit}` },
      { label: 'Q1–Q3', value: `${compactNumber(quantile(values, .25))}–${compactNumber(quantile(values, .75))} ${chart.unit}` }];
  }
  if (chart.type === 'waterfall') {
    const steps = waterfallSteps(chart);
    return [{ label: english ? 'Start → End' : '起点 → 合计', value: `${compactNumber(steps[0].value)} → ${compactNumber(steps.at(-1).value)} ${chart.unit}` },
      { label: english ? 'Net change' : '净变动', value: `${signedNumber(decimalSum(chart.series[0].values.slice(1)))} ${chart.unit}` }];
  }
  return [];
}
export function chartTable(chart, english = false) {
  const columns = [english ? 'Item' : '项目'];
  if (chart.type === 'scatter') columns.push(`${chart.xLabel} · ${chart.xUnit}`);
  columns.push(...chart.series.map(s => `${s.name} · ${chart.unit}`));
  const difference = ['dumbbell', 'heatmap'].includes(chart.type) && chart.series.length === 2;
  if (difference) columns.push(`${chart.series[1].name} − ${chart.series[0].name} · ${differenceUnit(chart, english)}`);
  if (chart.type === 'waterfall') columns.push(english ? 'Cumulative' : `累计 · ${chart.unit}`);
  const rows = chart.categories.map((category, index) => {
    const row = [category];
    if (chart.type === 'scatter') row.push(chart.xValues[index]);
    row.push(...chart.series.map(s => s.values[index]));
    if (difference) row.push(pairedDifferences(chart)[index].value);
    if (chart.type === 'waterfall') row.push(waterfallSteps(chart)[index].end);
    return row;
  });
  return { columns, rows };
}
export function chartReading(chart, data, index) {
  if (data?.derived === 'difference') {
    const pair = pairedDifferences(chart)[data.categoryIndex];
    return `${pair.name} · ${chart.series[1].name} − ${chart.series[0].name}：${pair.value === null ? '未知' : `${signedNumber(pair.value)} ${differenceUnit(chart)}`}`;
  }
  if (chart.type === 'histogram') {
    const bin = histogramBins(chart.series[0].values)[index];
    return `${bin.low} ≤ x ${bin.last ? '≤' : '<'} ${bin.high} ${chart.unit} · ${bin.count} 个样本`;
  }
  if (chart.type === 'waterfall') {
    const step = waterfallSteps(chart)[index];
    return `${step.name} · ${step.value} ${chart.unit} · 累计 ${step.end} ${chart.unit}`;
  }
  const series = chart.series[data.sourceSeries], value = series.values[data.categoryIndex];
  const detail = `${series.name}：${value === null ? '未知' : `${value} ${chart.unit}`}`;
  return `${chart.categories[data.categoryIndex]} · ${chart.type === 'scatter' ? `${chart.xLabel}：${chart.xValues[data.categoryIndex]} ${chart.xUnit} · ` : ''}${detail}`;
}
