import { createElement as h, useState } from 'react';
import { chartTheme as theme, seriesPalette, categoryPalette } from './chart-theme.js';
import { compactNumber as number, decimalSum } from './chart-data.js';
import { chartTextWidth, shortSeriesNames } from './chart-layout.js';
import { roseRadius, chordArcs } from './chart-structure-data.js';

const xy = (cx, cy, radius, angle) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
export function sectorPath(cx, cy, inner, outer, start, end) {
  if (outer <= inner || end <= start) return '';
  const points = [xy(cx,cy,outer,start), xy(cx,cy,outer,(start+end)/2), xy(cx,cy,outer,end), xy(cx,cy,inner,end), xy(cx,cy,inner,(start+end)/2), xy(cx,cy,inner,start)];
  return `M ${points[0]} A ${outer} ${outer} 0 0 1 ${points[1]} A ${outer} ${outer} 0 0 1 ${points[2]} L ${points[3]} A ${inner} ${inner} 0 0 0 ${points[4]} A ${inner} ${inner} 0 0 0 ${points[5]} Z`;
}
function outerLabels(labels, cx, cy, radius, width) {
  const entries = labels.map((label,i) => ({ ...label, index: i, side: Math.cos(label.angle) >= 0 ? 1 : -1, point: xy(cx,cy,radius+4,label.angle), y: cy + (radius+12) * Math.sin(label.angle) }));
  for (const side of [-1,1]) {
    const rows = entries.filter(e => e.side === side).sort((a,b) => a.y-b.y);
    rows.forEach((row,i) => { row.y = Math.max(row.y, i ? rows[i-1].y+19 : 14); });
    if (rows.length) { const shift = Math.max(0, rows.at(-1).y - (cy*2-14)); rows.forEach(row => { row.y -= shift; }); }
  }
  return entries.flatMap(e => {
    const x = e.side > 0 ? cx+radius+13 : cx-radius-13;
    return [h('path', { key: `leader-${e.index}`, d: `M ${e.point} L ${x-e.side*4} ${e.y}`, stroke: theme.grid, fill: 'none' }),
      h('text', { key: `label-${e.index}`, x: Math.max(4,Math.min(width-4,x)), y: e.y, fill: theme.ink, fontSize: 11, dominantBaseline: 'middle', textAnchor: e.side > 0 ? 'start' : 'end' }, e.text)];
  });
}

export function CircularChart({ chart, width }) {
  const [reading, setReading] = useState('');
  const mark = label => ({ tabIndex: 0, role: 'img', 'aria-label': label, 'data-structure-mark': true,
    onFocus: () => setReading(label), onClick: () => setReading(label), onBlur: () => setReading('') });
  const inspect = event => {
    if (event.key === 'Escape') { setReading(''); return; }
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    const choices = [...event.currentTarget.querySelectorAll('[data-structure-mark]')], current = choices.indexOf(event.target);
    if (!choices.length) return;
    event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length-1 : (current+(event.key==='ArrowLeft'?-1:1)+choices.length)%choices.length;
    choices[next].focus();
  };
  const labels = [], marks = [], categoryCount = chart.categories.length, colors = categoryPalette(chart.categories), groupColors = seriesPalette(chart.series.map(s=>s.name));
  const hasOuter = ['rose','radar','chord'].includes(chart.type);
  const labelWidth = Math.max(44, ...chart.categories.map((name,i) => chartTextWidth(chart.type==='radar' ? name : `${name} ${number(chart.series[0].values[i])}`,11)));
  const plotWidth = hasOuter ? Math.max(310, width, 220+labelWidth*2+32) : Math.max(270,width);
  const total = chart.type === 'waffle' ? decimalSum(chart.series[0].values) : 0;
  const columns = Math.ceil(Math.sqrt(total * 2.4)), rows = total ? Math.ceil(total / columns) : 0;
  const cell = total ? Math.min(24, (plotWidth - 16) / columns) : 0;
  const height = chart.type === 'waffle' ? rows * cell + 16 : 260, cx=plotWidth/2, cy=height/2, radius=96;
  let legend = null;
  const legendItems = (names, values, format = number) => h('div', { style: { display: 'flex', gap: 12, overflowX: 'auto', fontSize: 12, whiteSpace: 'nowrap', margin: '5px 0' } }, names.map((name,i) =>
    h('span', { key: i, style: { flexShrink: 0, color: theme.ink } }, h('i', { style: { display:'inline-block',width:7,height:7,background:names===chart.categories?colors[i%colors.length]:groupColors[i%groupColors.length],marginRight:5 } }), `${name}${values ? ` ${format(values[i])}` : ''}`)));
  if (chart.type === 'rose') {
    const values=chart.series[0].values, maximum=Math.max(...values), angle=2*Math.PI/categoryCount;
    values.forEach((value,i) => {
      const start=-Math.PI/2+i*angle+.015, end=start+angle-.03;
      marks.push(h('path', { key:i, d:sectorPath(cx,cy,18,roseRadius(value,maximum,18,radius),start,end), fill:colors[i%colors.length], 'data-rose-value':value, ...mark(`${chart.categories[i]}：${value} ${chart.unit}`) }));
      labels.push({ text:`${chart.categories[i]} ${number(value)}`, angle:(start+end)/2 });
    });
  } else if (chart.type === 'concentric') {
    const ring=(radius-30)/chart.series.length;
    chart.series.forEach((s,si) => {
      const total=decimalSum(s.values); let start=-Math.PI/2;
      s.values.forEach((value,ci) => { const end=start+value/total*2*Math.PI;
        if(value>0)marks.push(h('path', {key:`${si}-${ci}`,d:sectorPath(cx,cy,30+si*ring+1,30+(si+1)*ring-1,start,end),fill:colors[ci%colors.length],stroke:theme.paper,strokeWidth:1,...mark(`${s.name} · ${chart.categories[ci]}：${value}/${total} ${chart.unit}`)})); start=end; });
    });
    legend=h('div', null, h('div',{style:{fontSize:12,whiteSpace:'nowrap',overflowX:'auto',color:theme.muted}},`内 → 外：${shortSeriesNames(chart).map((name,i)=>`${name} (n=${number(decimalSum(chart.series[i].values))})`).join(' / ')}`),legendItems(chart.categories));
  } else if (chart.type === 'radial_progress') {
    const ring=(radius-25)/categoryCount;
    chart.series[0].values.forEach((value,i) => {
      const outer=radius-i*ring, inner=outer-ring+4, start=-Math.PI/2;
      marks.push(h('path',{key:`bg-${i}`,d:sectorPath(cx,cy,inner,outer,start,start+2*Math.PI),fill:theme.ivory}));
      if(value>0)marks.push(h('path',{key:i,d:sectorPath(cx,cy,inner,outer,start,start+value/chart.maxValue*2*Math.PI),fill:colors[i%colors.length],...mark(`${chart.categories[i]}：${value}/${chart.maxValue} ${chart.unit}`)}));
    });
    if(categoryCount===1)marks.push(h('text',{key:'center',x:cx,y:cy,textAnchor:'middle',dominantBaseline:'middle',fontSize:Math.max(12,Math.min(24,52/chartTextWidth(`${number(chart.series[0].values[0]/chart.maxValue*100)}%`,12)*12)),fontWeight:600,fill:theme.ink},`${number(chart.series[0].values[0]/chart.maxValue*100)}%`));
    legend=legendItems(chart.categories,chart.series[0].values,v=>`${number(v)}/${number(chart.maxValue)}`);
  } else if (chart.type === 'radar') {
    const angle=i=>-Math.PI/2+i*2*Math.PI/categoryCount;
    [0.25,.5,.75,1].forEach((f,i)=>marks.push(h('polygon',{key:`grid-${i}`,points:chart.categories.map((_,j)=>xy(cx,cy,radius*f,angle(j)).join(',')).join(' '),fill:'none',stroke:theme.grid})));
    chart.categories.forEach((name,i)=>{marks.push(h('line',{key:`axis-${i}`,x1:cx,y1:cy,x2:xy(cx,cy,radius,angle(i))[0],y2:xy(cx,cy,radius,angle(i))[1],stroke:theme.grid}));labels.push({text:name,angle:angle(i)});});
    chart.series.forEach((s,si)=>{
      const points=s.values.map((value,i)=>xy(cx,cy,radius*value/chart.maxValue,angle(i)));
      marks.push(h('polygon',{key:`series-${si}`,points:points.map(p=>p.join(',')).join(' '),fill:groupColors[si],fillOpacity:.08,stroke:groupColors[si],strokeWidth:1.8}));
      points.forEach((p,i)=>marks.push(h('circle',{key:`${si}-${i}`,cx:p[0],cy:p[1],r:3,fill:groupColors[si],...mark(`${s.name} · ${chart.categories[i]}：${s.values[i]}/${chart.maxValue} ${chart.unit}`)})));
    });
    legend=legendItems(chart.series.map(s=>s.name));
  } else if (chart.type === 'waffle') {
    const values=chart.series[0].values,left=(plotWidth-columns*cell)/2,top=8;
    let index=0;values.forEach((value,ci)=>{for(let i=0;i<value;i++,index++)marks.push(h('rect',{key:index,x:left+(index%columns)*cell+1,y:top+Math.floor(index/columns)*cell+1,width:cell-2,height:cell-2,rx:2,fill:colors[ci%colors.length],'data-waffle-cell':true,'aria-label':chart.categories[ci]}));});
    legend=h('div',null,legendItems(chart.categories,values),h('div',{style:{fontSize:11,color:theme.muted}},`1格 = 1${chart.unit} · n=${total}`));
  } else if (chart.type === 'chord') {
    const arcs=chordArcs(chart), r=radius-9;
    arcs.forEach((arc,i)=>{
      marks.push(h('path',{key:`arc-${i}`,d:sectorPath(cx,cy,radius-7,radius,arc.from,arc.end),fill:colors[i%colors.length]}));
      labels.push({text:`${chart.categories[i]} ${number(arc.value)}`,angle:(arc.from+arc.end)/2});
      for(let j=i+1;j<arcs.length;j++){
        const value=chart.series.find(s=>s.name===chart.categories[i]).values[j];if(!value)continue;
        const [a,b]=arc.portions[j], [c,d]=arcs[j].portions[i];
        const p=angle=>xy(cx,cy,r,angle).join(',');
        marks.push(h('path',{key:`link-${i}-${j}`,d:`M ${p(a)} A ${r} ${r} 0 ${b-a>Math.PI?1:0} 1 ${p(b)} Q ${cx} ${cy} ${p(c)} A ${r} ${r} 0 ${d-c>Math.PI?1:0} 1 ${p(d)} Q ${cx} ${cy} ${p(a)} Z`,fill:colors[i%colors.length],fillOpacity:.3,stroke:colors[i%colors.length],strokeOpacity:.5,...mark(`${chart.categories[i]} ↔ ${chart.categories[j]}：${value} ${chart.unit}`)}));
      }
    });
  }
  return h('div',{'data-circular-chart':chart.type},legend,
    h('div',{style:{overflowX:'auto',maxWidth:'100%'}},h('svg',{width:plotWidth,height,viewBox:`0 0 ${plotWidth} ${height}`,role:'group','aria-label':chart.title,'data-chart-type':chart.type,onKeyDown:inspect,style:{display:'block',margin:'0 auto',fontFamily:'inherit',fontVariantNumeric:'tabular-nums'}},...marks,...outerLabels(labels,cx,cy,radius,plotWidth))),
    h('div',{'aria-live':'polite',style:{fontSize:12,color:theme.muted,minHeight:reading?18:0}},reading));
}
