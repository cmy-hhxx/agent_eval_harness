import { decimalSum, decimalSumsEqual } from './chart-data.js';

export const circularTypes = ['rose', 'concentric', 'radial_progress', 'radar', 'waffle', 'chord'];
export const structureTypes = [...circularTypes, 'sunburst', 'treemap', 'sankey', 'ecdf', 'ridgeline'];
export function validStructureChart(chart) {
  if (!structureTypes.includes(chart.type)) return true;
  if (chart.annotations?.length) return false;
  const count = chart.categories.length, groups = chart.series.length;
  if (['ecdf', 'ridgeline'].includes(chart.type)) return chart.series.every(s => s.values.filter(v => v !== null).length >= (chart.type === 'ecdf' ? 2 : 8));
  const limits = { rose: [3,10,1,1], concentric: [2,6,2,4], radial_progress: [2,6,1,1], radar: [3,8,1,4], waffle: [2,6,1,1], sunburst: [2,8,2,4], treemap: [2,8,2,4], sankey: [2,8,1,8], chord: [3,8,3,8] }[chart.type];
  if (count < limits[0] || count > limits[1] || groups < limits[2] || groups > limits[3]
    || chart.categories.some(name => Array.from(name).length > 12) || chart.series.some(s => Array.from(s.name).length > 12 || s.values.some(v => v === null || v < 0))) return false;
  if (['radar', 'radial_progress'].includes(chart.type)) return Number.isFinite(chart.maxValue) && chart.maxValue > 0 && chart.maxValue <= 1e15 && chart.series.every(s => s.values.every(v => v <= chart.maxValue));
  if (chart.series.some(s => !s.values.some(v => v > 0))) return false;
  if (chart.type === 'waffle') return chart.series[0].values.every(Number.isInteger) && decimalSum(chart.series[0].values) <= 400;
  if (['sankey', 'chord'].includes(chart.type)) {
    if (chart.series.some(s => !chart.categories.includes(s.name))) return false;
    const matrix = chart.categories.map(name => chart.series.find(s => s.name === name)?.values ?? Array(count).fill(0));
    if (matrix.some((row,i) => row[i] !== 0)) return false;
    if (chart.type === 'chord') return groups === count && matrix.every((row,i) => row.every((v,j) => v === matrix[j][i]));
    const active = new Set(), visited = new Set();
    const visit = i => {
      if (active.has(i)) return false;
      if (visited.has(i)) return true;
      active.add(i);
      for (let j = 0; j < count; j++) if (matrix[i][j] > 0 && !visit(j)) return false;
      active.delete(i); visited.add(i); return true;
    };
    if (!matrix.every((_,i) => visit(i))) return false;
    return matrix.every((row,i) => {
      const incoming = matrix.map(r => r[i]);
      return !incoming.some(v => v > 0) || !row.some(v => v > 0) || decimalSumsEqual(incoming, row);
    });
  }
  return true;
}

export const roseRadius = (value, maximum, inner = 18, outer = 100) => Math.sqrt(inner ** 2 + value / maximum * (outer ** 2 - inner ** 2));
export function chordArcs(chart, gap = .08) {
  const matrix = chart.categories.map(name => chart.series.find(s => s.name === name).values);
  const totals = matrix.map(decimalSum), total = decimalSum(totals), angle = 2 * Math.PI - gap * matrix.length;
  let start = -Math.PI / 2;
  return matrix.map((row,i) => {
    const from = start, portions = row.map(value => { const a = start; start += value / total * angle; return [a,start]; });
    const end = start; start += gap;
    return { from, end, value: totals[i], portions };
  });
}
