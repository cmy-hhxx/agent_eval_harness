// Scientific palette supplied in the user's reference. Identity and magnitude are separate channels.
export const chartTheme = {
  navy: '#0B1F54', royal: '#1E4E8C', denim: '#4776A8', coral: '#F25F3B', terracotta: '#AA4A2F', ivory: '#EDE7DB', earth: '#6B7F6A',
  paper: '#FFFFFF', ink: '#0B1F54', muted: '#526079', grid: '#DEDACF',
};
export const researchColors = [chartTheme.royal, chartTheme.coral, chartTheme.earth, chartTheme.denim];
export function seriesPalette(names) {
  const identities = names.map(name => /^([A-D])(?=$|[\s:：·/(_-]|组|組)/i.exec(name.trim())?.[1].toUpperCase());
  const reserved = identities.map(id => id ? id.charCodeAt(0)-65 : null), available = [0,1,2,3].filter(i => !reserved.includes(i));
  return names.map((_,i) => researchColors[reserved[i] ?? available.shift() ?? i%4]);
}
export function categoryPalette(names) {
  const fixed = name => new Map(Object.entries({'通过':chartTheme.earth,'完成':chartTheme.earth,'失败':chartTheme.terracotta,'退回':chartTheme.terracotta,'待核':chartTheme.denim,'双方均好':chartTheme.denim,'双方均差':chartTheme.navy,'双方都答得好':chartTheme.denim,'双方都答得差':chartTheme.navy})).get(name)
    ?? (/^([A-D])(?=$|[\s:：·/(_-]|组|組)/i.test(name.trim()) ? researchColors[name.trim()[0].toUpperCase().charCodeAt(0)-65] : null);
  const reserved = new Set(names.map(fixed).filter(Boolean));
  const pool = [chartTheme.royal,chartTheme.coral,chartTheme.earth,chartTheme.denim,chartTheme.terracotta,chartTheme.navy].filter(c=>!reserved.has(c));
  const generic = names.filter(name=>!fixed(name)).toSorted();
  return names.map(name=>fixed(name) ?? (pool.length ? pool[generic.indexOf(name)%pool.length] : chartTheme.ivory));
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
export const heatColors = minimum => minimum < 0
  ? [chartTheme.coral, chartTheme.ivory, chartTheme.navy]
  : [chartTheme.ivory, chartTheme.denim, chartTheme.navy];
export function heatColor(value, minimum, maximum) {
  const colors = heatColors(minimum), position = maximum === minimum ? 0 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum))) * 2;
  const index = Math.min(1, Math.floor(position)), weight = position - index;
  const from = rgb(colors[index]), to = rgb(colors[index + 1]);
  return '#' + from.map((v, i) => Math.round(v + (to[i] - v) * weight).toString(16).padStart(2, '0')).join('');
}
const luminance = hex => rgb(hex).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
export function heatTextColor(background) {
  const level = luminance(background);
  if ((level + .05) / (luminance(chartTheme.ink) + .05) >= 4.6) return chartTheme.ink;
  if (1.05 / (level + .05) >= 4.6) return chartTheme.paper;
  return '#000000';
}
