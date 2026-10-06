// Conservative single-line widths. Plots gain space before labels lose readability.
export const chartTextWidth = (value, size = 12) => Array.from(String(value)).reduce((sum, c) =>
  sum + (/\s/.test(c) ? 4 : /[MWm@]/.test(c) ? 11 : /[\x00-\x7f]/.test(c) ? 7 : 12), 0) * size / 12;

/** Only shorten explicit group names when the resulting labels stay distinct. */
export function shortSeriesNames(chart) {
  const names = chart.series.map(s => s.name);
  const shortened = names.map(name => /^([A-D])\s*组(?:Fast|Expert)?$/i.exec(name.trim())?.[1]?.toUpperCase() ?? name);
  return new Set(shortened).size === names.length ? shortened : names;
}

export function differenceLabel(chart, unit) {
  const names = shortSeriesNames(chart);
  return `Δ ${names[1]}−${names[0]}${['%', '％'].includes(chart.unit) ? ` · ${unit}` : ''}`;
}

export function researchLayout(chart, width, deltaUnit, numbers) {
  const matrix = ['heatmap', 'bubble_matrix'].includes(chart.type);
  const delta = chart.type === 'heatmap' && chart.series.length === 2;
  const rowNames = matrix ? [...chart.series.map(s => s.name), ...(delta ? [differenceLabel(chart, deltaUnit)] : [])]
    : chart.type === 'interval' ? chart.categories.flatMap(category => chart.series.map(s => chart.series.length === 1 ? category : `${category} · ${s.name}`))
    : chart.categories;
  const labelWidth = Math.max(30, ...rowNames.map(name => chartTextWidth(name)));
  const longestNumber = Math.max(16, ...numbers.map(number => chartTextWidth(number, 11)));
  if (matrix) {
    const cell = Math.max(chart.type === 'bubble_matrix' ? 42 : 32, longestNumber + 14,
      ...chart.categories.map(name => chartTextWidth(name) + 16));
    return { width: Math.max(width, labelWidth + 28 + chart.categories.length * cell + 18),
      height: rowNames.length * (chart.type === 'bubble_matrix' ? 42 : 30) + (chart.type === 'heatmap' ? 70 : 48), labelWidth };
  }
  if (chart.type === 'dumbbell') return { width: Math.max(width, labelWidth + longestNumber * 3 + 220), height: chart.categories.length * 28 + 48, labelWidth };
  if (chart.type === 'interval') return { width: Math.max(width, labelWidth + longestNumber * 3 + 200), height: rowNames.length * 34 + 48, labelWidth };
  if (['slope', 'bump', 'waterfall', 'boxplot', 'violin'].includes(chart.type)) {
    const names = ['boxplot', 'violin'].includes(chart.type) ? chart.series.map(s => s.name) : [...chart.categories, ...(chart.type === 'waterfall' ? ['合计'] : [])];
    const cell = Math.max(50, longestNumber + 18, ...names.map(name => chartTextWidth(name) + 18));
    return { width: Math.max(width, names.length * cell + 90), height: 200, labelWidth };
  }
  return { width: Math.max(width, 300, longestNumber * 4 + 90), height: 200, labelWidth };
}
