// Derived display data only. Source values and accepted receipts stay unchanged.
export const researchTypes = ['bar', 'heatmap', 'scatter', 'waterfall', 'histogram', 'bubble', 'bubble_matrix', 'slope', 'interval', 'boxplot', 'violin', 'sunburst', 'treemap', 'sankey', 'ecdf', 'ridgeline'];
export { researchColors } from './chart-theme.js';
export const differenceUnit = (chart, english = false) => /^(?:× \S+ )?[%％]$/.test(chart.unit)
  ? chart.unit.replace(/[%％]$/, english ? 'pp' : '百分点') : chart.unit;
export const compactNumber = value => {
  const rounded = Number(value.toPrecision(6)), magnitude = Math.abs(rounded);
  return magnitude !== 0 && (magnitude < 0.0001 || magnitude >= 1e7)
    ? rounded.toExponential().replace('e+', 'E').replace('e', 'E')
    : rounded.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
};
export const signedNumber = value => `${value > 0 ? '+' : ''}${compactNumber(value)}`;

// ECharts rounds numeric ticks to finite decimal precision. Scale only drawing coordinates;
// the receipt and accessible observations retain the original measurements.
export function researchDrawing(chart) {
  const factor = values => {
    const known = values.filter(v => v !== null), maximum = Math.max(0, ...known.map(Math.abs));
    const span = known.length ? Math.max(...known) - Math.min(...known) : 0;
    return maximum > 0 && (maximum < 1e-12 || (span > 0 && span < 1e-12))
      ? 10 ** Math.floor(Math.log10(maximum)) || maximum : 1;
  };
  const valueFactor = factor(chart.series.flatMap(s => [...s.values, ...(s.lowerValues ?? []), ...(s.upperValues ?? [])]));
  const xFactor = factor(chart.xValues ?? []);
  if (valueFactor === 1 && xFactor === 1) return { chart, scales: [] };
  const scaled = (values, divisor) => values.map(value => value === null ? null : value / divisor);
  const unit = (unit, divisor) => divisor === 1 ? unit : `× ${divisor.toExponential().replace('e', 'E')} ${unit}`;
  return { chart: { ...chart, unit: unit(chart.unit, valueFactor),
    series: chart.series.map(s => ({ ...s, values: scaled(s.values, valueFactor),
      ...(s.lowerValues ? { lowerValues: scaled(s.lowerValues, valueFactor), upperValues: scaled(s.upperValues, valueFactor) } : {}) })),
    ...(chart.xValues ? { xValues: scaled(chart.xValues, xFactor), xUnit: unit(chart.xUnit, xFactor) } : {}) },
    scales: [valueFactor === 1 ? null : `数值 ${unit(chart.unit, valueFactor)}`,
      xFactor === 1 ? null : `${chart.xLabel} ${unit(chart.xUnit, xFactor)}`].filter(Boolean) };
}
function decimalParts(values) {
  if (!values.length) return { integer: 0n, exponent: 0 };
  const parts = values.map(value => {
    const [coefficient, power = '0'] = String(value).split('e');
    const decimals = coefficient.split('.')[1]?.length ?? 0;
    return { integer: BigInt(coefficient.replace('.', '')), exponent: Number(power) - decimals };
  });
  const exponent = Math.min(...parts.map(p => p.exponent));
  const integer = parts.reduce((sum, p) => sum + p.integer * 10n ** BigInt(p.exponent - exponent), 0n);
  return { integer, exponent };
}
export function decimalSum(values) {
  const { integer, exponent } = decimalParts(values);
  return Number(`${integer}e${exponent}`);
}

/** Only the complete, disjoint battle outcomes have an additive match denominator. */
export function battleTotals(chart) {
  if (chart.type !== 'heatmap' || chart.unit !== '场'
    || chart.series.some(s => s.values.some(v => !Number.isSafeInteger(v) || v < 0))) return null;
  const outcomes = names => {
    const keys = names.map(name => name.replace(/\s+/g, '').replace(/双方(?:均|都)(?:答得)?好|双方答好/, 'both_good')
      .replace(/双方(?:均|都)(?:答得)?差|双方答差/, 'both_bad'));
    return keys.length === 4 && ['A组胜', 'B组胜', 'both_good', 'both_bad'].every(key => keys.includes(key));
  };
  const tiers = names => names.every(name => /^(Fast|Expert)$/i.test(name.trim()))
    && new Set(names.map(name => name.trim().toLowerCase())).size === names.length;
  const columns = outcomes(chart.series.map(s => s.name)) && tiers(chart.categories);
  const rows = outcomes(chart.categories) && tiers(chart.series.map(s => s.name));
  if (!columns && !rows) return null;
  const totals = columns ? chart.categories.map((_, i) => decimalSum(chart.series.map(s => s.values[i])))
    : chart.series.map(s => decimalSum(s.values));
  const total = decimalSum(totals);
  return Number.isSafeInteger(total) ? { axis: columns ? 'columns' : 'rows', totals, total } : null;
}
export function decimalSumsEqual(left, right) {
  const a = decimalParts(left), b = decimalParts(right), exponent = Math.min(a.exponent, b.exponent);
  return a.integer * 10n ** BigInt(a.exponent - exponent) === b.integer * 10n ** BigInt(b.exponent - exponent);
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
  if (data?.derived === 'branch') return `${data.name}：${data.value} ${chart.unit}`;
  if (data?.derived === 'cdf') return `${chart.series[data.sourceSeries].name} · ≤${data.value[0]} ${chart.unit}：${data.count}/${data.total}（${compactNumber(data.value[1])}%）`;
  if (data?.derived === 'density') return `${chart.series[data.sourceSeries].name} · ${data.count} 条观测 · 中位 ${compactNumber(data.median)} ${chart.unit}`;
  if (chart.type === 'sankey') return `${data.source} → ${data.target}：${data.value} ${chart.unit}`;
  const series = chart.series[data.sourceSeries], value = series.values[data.categoryIndex];
  const detail = `${series.name}：${value === null ? '未知' : `${value} ${chart.unit}`}${chart.type === 'interval' ? ` [${series.lowerValues[data.categoryIndex]}, ${series.upperValues[data.categoryIndex]}]` : ''}${chart.type === 'bubble' ? ` · ${chart.sizeLabel}：${chart.sizeValues[data.categoryIndex]} ${chart.sizeUnit}` : ''}`;
  const battles = battleTotals(chart), total = battles?.totals[battles.axis === 'columns' ? data.categoryIndex : data.sourceSeries];
  const share = total > 0 ? ` · 占本档 ${(value / total * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` : '';
  return `${chart.categories[data.categoryIndex]} · ${['scatter', 'bubble'].includes(chart.type) ? `${chart.xLabel}：${chart.xValues[data.categoryIndex]} ${chart.xUnit} · ` : ''}${detail}${share}`;
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

export function empiricalCdf(values) {
  const sorted = values.filter(v => v !== null).toSorted((a,b) => a - b);
  return sorted.flatMap((value,i) => i + 1 < sorted.length && sorted[i + 1] === value ? [] : [{ value, count: i + 1, total: sorted.length, percent: (i + 1) / sorted.length * 100 }]);
}
export function chartHierarchy(chart) {
  return chart.series.map((s,si) => ({ name: s.name, value: decimalSum(s.values), derived: 'branch', sourceSeries: si,
    children: s.values.flatMap((value,ci) => value === 0 ? [] : [{ name: chart.categories[ci], value, sourceSeries: si, categoryIndex: ci }]) }));
}
export function chartLinks(chart) {
  return chart.series.flatMap((s,si) => s.values.flatMap((value,ci) => value > 0 ? [{ source: s.name, target: chart.categories[ci], value, sourceSeries: si, categoryIndex: ci }] : []));
}
