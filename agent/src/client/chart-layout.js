import { battleTotals } from './chart-data.js';

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
  if (['sunburst','treemap'].includes(chart.type)) return { width: Math.max(320,width), height: chart.type==='sunburst'?300:240, labelWidth:0 };
  if (chart.type==='sankey') {
    const depths=Array(chart.categories.length).fill(0);
    for(let i=0;i<chart.categories.length;i++) for(const series of chart.series) series.values.forEach((v,j)=>{if(v>0)depths[j]=Math.max(depths[j],depths[chart.categories.indexOf(series.name)]+1);});
    const columns=Math.max(...depths)+1, maxLabel=Math.max(...chart.categories.map(name=>chartTextWidth(name)));
    return {width:Math.max(width,400,columns*(maxLabel+50)),height:Math.max(220,...depths.map(d=>depths.filter(v=>v===d).length*44+24)),labelWidth:maxLabel};
  }
  if (chart.type==='ridgeline') return {width:Math.max(width,340),height:chart.series.length*62+60,labelWidth:Math.max(...chart.series.map(s=>chartTextWidth(s.name)))};
  const matrix = ['heatmap', 'bubble_matrix'].includes(chart.type);
  const battles = battleTotals(chart);
  const delta = chart.type === 'heatmap' && chart.series.length === 2 && !battles;
  const rowNames = matrix ? [...chart.series.map((s, i) => battles?.axis === 'rows' ? `${s.name} · ${battles.totals[i].toLocaleString('zh-CN')} 场` : s.name), ...(delta ? [differenceLabel(chart, deltaUnit)] : [])]
    : chart.type === 'interval' ? chart.categories.flatMap(category => chart.series.map(s => chart.series.length === 1 ? category : `${category} · ${s.name}`))
    : chart.categories;
  const labelWidth = Math.max(30, ...rowNames.map(name => chartTextWidth(name, chart.type === 'heatmap' ? 14 : 12)));
  const longestNumber = Math.max(16, ...numbers.map(number => chartTextWidth(number, chart.type === 'heatmap' ? 14 : 11)));
  if (matrix) {
    const cell = Math.max(chart.type === 'bubble_matrix' ? 42 : 44, longestNumber + 16,
      ...(battles?.axis === 'columns' ? battles.totals.map(total => chartTextWidth(`${total.toLocaleString('zh-CN')} 场`, 14) + 12) : []),
      ...chart.categories.map(name => chartTextWidth(name, chart.type === 'heatmap' ? 14 : 12) + (chart.type === 'heatmap' ? 8 : 16)));
    const showColorScale = chart.type === 'heatmap' && (chart.categories.length > 12 || chart.series.some(series => series.values.includes(null)));
    const top = battles?.axis === 'columns' ? 48 : 28, bottom = showColorScale ? 32 : 4;
    return { width: Math.max(width, labelWidth + chart.categories.length * cell + (chart.type === 'heatmap' ? 20 : 46)),
      height: rowNames.length * 42 + (chart.type === 'heatmap' ? top + bottom : 48),
      labelWidth, showColorScale, top, bottom };
  }
  if (chart.type === 'interval') return { width: Math.max(width, labelWidth + longestNumber * 3 + 200), height: rowNames.length * 34 + 48, labelWidth };
  if (chart.type === 'slope') return { width: Math.max(width, 300, longestNumber * 2 + 180, ...chart.categories.map(name => chartTextWidth(name) * 2 + 40)), height: 220, labelWidth, endSpace: longestNumber + 24 };
  if (['waterfall', 'boxplot', 'violin'].includes(chart.type)) {
    const names = ['boxplot', 'violin'].includes(chart.type) ? chart.series.map(s => s.name) : [...chart.categories, ...(chart.type === 'waterfall' ? ['合计'] : [])];
    const cell = Math.max(50, longestNumber + 18, ...names.map(name => chartTextWidth(name) + 18));
    return { width: Math.max(width, names.length * cell + 90), height: 200, labelWidth };
  }
  return { width: Math.max(width, 300, longestNumber * 4 + 90), height: 200, labelWidth };
}
