// Derived display data only. Source values and accepted receipts stay unchanged.
export const researchTypes = ['dumbbell', 'heatmap', 'scatter', 'waterfall', 'histogram', 'bubble', 'bubble_matrix', 'slope', 'bump', 'interval', 'boxplot', 'violin'];
export { researchColors } from './chart-theme.js';
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
  const detail = `${series.name}：${value === null ? '未知' : `${value} ${chart.unit}`}${chart.type === 'interval' ? ` [${series.lowerValues[data.categoryIndex]}, ${series.upperValues[data.categoryIndex]}]` : ''}${chart.type === 'bubble' ? ` · ${chart.sizeLabel}：${chart.sizeValues[data.categoryIndex]} ${chart.sizeUnit}` : ''}`;
  return `${chart.categories[data.categoryIndex]} · ${['scatter', 'bubble'].includes(chart.type) ? `${chart.xLabel}：${chart.xValues[data.categoryIndex]} ${chart.xUnit} · ` : ''}${detail}`;
}

export function boxSummary(values) {
  const sorted = values.filter(v => v !== null).toSorted((a, b) => a - b);
  const q1 = quantile(sorted, .25), median = quantile(sorted, .5), q3 = quantile(sorted, .75), span = q3 - q1;
  return { count: sorted.length, q1, median, q3,
    low: sorted.find(v => v >= q1 - 1.5 * span), high: sorted.findLast(v => v <= q3 + 1.5 * span) };
}
// Gaussian KDE, common Silverman bandwidth across groups, clipped to observed support.
export function violinDensity(series) {
  const pooled = series.flatMap(s => s.values).filter(v => v !== null), n = pooled.length;
  const mean = pooled.reduce((s, v) => s + v, 0) / n;
  const sigma = Math.sqrt(pooled.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const robust = (quantile(pooled, .75) - quantile(pooled, .25)) / 1.34;
  const scale = Math.min(...[sigma, robust].filter(v => v > 0));
  const bandwidth = Number.isFinite(scale) ? .9 * scale * n ** (-.2) : Math.max(Math.abs(mean) * .01, 1);
  const groups = series.map(s => {
    const values = s.values.filter(v => v !== null), min = Math.min(...values), max = Math.max(...values);
    return Array.from({ length: min === max ? 1 : 49 }, (_, i) => {
      const value = min + (max - min) * i / 48;
      return { value, density: values.reduce((sum, v) => sum + Math.exp(-.5 * ((value - v) / bandwidth) ** 2), 0) / (values.length * bandwidth * Math.sqrt(2 * Math.PI)) };
    });
  });
  return { bandwidth, groups, maximum: Math.max(...groups.flat().map(p => p.density)) };
}
