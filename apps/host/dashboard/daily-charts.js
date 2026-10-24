import { init,use } from 'echarts/core';
import { BarChart,LineChart } from 'echarts/charts';
import { GridComponent,LegendComponent,TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

use([BarChart,LineChart,GridComponent,LegendComponent,TooltipComponent,SVGRenderer]);

export function mountCharts(root) {
  const charts=new Map(),win=(root.ownerDocument||root).defaultView;
  let specs=[],disposed=false,frame;
  // SVG auto-sizing hides its viewport, which can change ancestor scrollbars.
  const fit=chart=>{const element=chart.getDom();if(element.clientWidth&&element.clientHeight)chart.resize({width:element.clientWidth,height:element.clientHeight});};
  function render(next=specs) {
    specs=next;if(disposed)return;
    for(const spec of specs){const element=root.querySelector('#daily-chart-'+spec.id);if(spec.empty||element.hidden){charts.get(spec.id)?.dispose();charts.delete(spec.id);continue;}if(!element.clientWidth||!element.clientHeight)continue;
      if(!charts.has(spec.id))charts.set(spec.id,init(element,null,{renderer:'svg'}));
      const chart=charts.get(spec.id);chart.setOption(spec.option,{notMerge:true});fit(chart);
    }
  }
  const resize=()=>{if(disposed||frame)return;frame=win.requestAnimationFrame(()=>{frame=undefined;if(!disposed)for(const chart of charts.values())fit(chart);});};
  const observer=win.ResizeObserver?new win.ResizeObserver(resize):undefined;
  for(const element of root.querySelectorAll('.daily-chart'))observer?.observe(element);win.addEventListener('resize',resize);
  return {render,destroy(){disposed=true;observer?.disconnect();if(frame)win.cancelAnimationFrame(frame);win.removeEventListener('resize',resize);for(const chart of charts.values())chart.dispose();charts.clear();}};
}
