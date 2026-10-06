import { chartTheme as theme, researchColors, heatTextColor } from './chart-theme.js';
import { chartHierarchy, chartLinks, decimalSum, empiricalCdf, violinDensity, quantile, compactNumber as number } from './chart-data.js';

export function structuralResearchOption(option, chart, palette) {
  if (['sunburst','treemap'].includes(chart.type)) {
    delete option.grid; delete option.xAxis; delete option.yAxis;
    const data = chartHierarchy(chart).map((parent,i) => ({ ...parent, itemStyle:{color:palette[i]}, label:{color:heatTextColor(palette[i])}, upperLabel:{color:heatTextColor(palette[i])}, children:parent.children.map(child=>({...child,itemStyle:{color:palette[i]},label:{color:heatTextColor(palette[i])}})) }));
    option.series = [{ type:chart.type, data, animation:false, nodeClick:false, roam:false,
      ...(chart.type==='sunburst' ? { radius:['15%','83%'], sort:null, minAngle:3, levels:[{}, {r0:'15%',r:'46%',label:{rotate:0,fontWeight:600}}, {r0:'48%',r:'83%',label:{rotate:0}}] }
        : { left:4,right:4,top:4,bottom:4,breadcrumb:{show:false}, leafDepth:2, squareRatio:1, upperLabel:{show:true,height:22,color:theme.ink,fontSize:11}, levels:[{itemStyle:{borderWidth:3,gapWidth:3,borderColor:theme.paper}},{itemStyle:{borderWidth:2,gapWidth:2,borderColor:theme.paper}}] }),
      itemStyle:{borderColor:theme.paper,borderWidth:2},
      label:{show:true,fontSize:11,overflow:'truncate',formatter: p => `${p.name} ${number(p.value)}`},
      labelLayout:{hideOverlap:true}, emphasis:{disabled:true},
    }];
  } else if (chart.type==='sankey') {
    delete option.grid; delete option.xAxis; delete option.yAxis;
    const links=chartLinks(chart), maximumName=Math.max(...chart.categories.map(name=>name.length*12));
    option.series=[{type:'sankey',left:8,right:maximumName+18,top:12,bottom:12,nodeWidth:10,nodeGap:20,nodeAlign:'justify',draggable:false,
      data:chart.categories.map((name,i)=>({name,itemStyle:{color:researchColors[i%researchColors.length]},value:Math.max(decimalSum(links.filter(l=>l.source===name).map(l=>l.value)),decimalSum(links.filter(l=>l.target===name).map(l=>l.value)))})),links,
      lineStyle:{color:'gradient',opacity:.35,curveness:.55},label:{show:true,color:theme.ink,fontSize:11},labelLayout:{hideOverlap:true},emphasis:{disabled:true}}];
  } else if(chart.type==='ecdf') {
    option.xAxis={...option.xAxis,type:'value',scale:true};
    option.yAxis={...option.xAxis,type:'value',min:0,max:100,scale:false,axisLabel:{...option.xAxis.axisLabel,formatter:'{value}%'},name:''};
    option.series=chart.series.map((s,si)=>({type:'line',name:s.name,step:'end',symbol:'circle',symbolSize:4,itemStyle:{color:palette[si]},lineStyle:{width:2,color:palette[si]},
      data:empiricalCdf(s.values).map(p=>({value:[p.value,p.percent],count:p.count,total:p.total,derived:'cdf',sourceSeries:si}))}));
  } else if(chart.type==='ridgeline') {
    const density=violinDensity(chart.series);
    option.xAxis={...option.xAxis,type:'value',scale:true};
    option.yAxis={...option.yAxis,data:chart.series.map(s=>s.name),inverse:true};
    option.grid.top=30;
    option.series=[{type:'custom',encode:{x:[0,1],y:2},
      data:density.groups.map((group,si)=>({value:[group[0].value,group.at(-1).value,si],derived:'density',sourceSeries:si,count:chart.series[si].values.filter(v=>v!==null).length,median:quantile(chart.series[si].values.filter(v=>v!==null),.5)})),
      renderItem:(params,api)=>{
        const si=params.dataIndex, group=density.groups[si], baseline=api.coord([group[0].value,si])[1], span=Math.abs(api.size([0,1])[1])*.66;
        const points=group.map(p=>[api.coord([p.value,si])[0],baseline-span*p.density/density.maximum]);
        return {type:'group',children:[{type:'polygon',shape:{points:[[points[0][0],baseline],...points,[points.at(-1)[0],baseline]]},style:{fill:palette[si],opacity:.5,stroke:theme.navy,lineWidth:1}},
          ...chart.series[si].values.filter(v=>v!==null).map(value=>({type:'line',shape:{x1:api.coord([value,si])[0],y1:baseline,x2:api.coord([value,si])[0],y2:baseline+4},style:{stroke:theme.navy,lineWidth:1}}))]};
      }}];
  }
}
