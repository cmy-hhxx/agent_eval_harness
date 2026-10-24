import { init,use } from 'echarts/core';
import { BarChart,LineChart } from 'echarts/charts';
import { GridComponent,LegendComponent,TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';

use([BarChart,LineChart,GridComponent,LegendComponent,TooltipComponent,SVGRenderer]);

export function mountCharts(root) {
  const charts=new Map(),win=(root.ownerDocument||root).defaultView;
  let specs=[],disposed=false;
  function render(next=specs) {
    specs=next;if(disposed)return;
    for(const spec of specs){const element=root.querySelector('#daily-chart-'+spec.id);if(spec.empty||element.hidden){charts.get(spec.id)?.dispose();charts.delete(spec.id);continue;}if(!element.clientWidth||!element.clientHeight)continue;
      if(!charts.has(spec.id))charts.set(spec.id,init(element,null,{renderer:'svg'}));
      const chart=charts.get(spec.id);chart.setOption(spec.option,{notMerge:true});chart.resize();
    }
  }
  const resize=()=>render();
  const observer=win.ResizeObserver?new win.ResizeObserver(resize):undefined;
  for(const element of root.querySelectorAll('.daily-chart'))observer?.observe(element);win.addEventListener('resize',resize);
  return {render,destroy(){disposed=true;observer?.disconnect();win.removeEventListener('resize',resize);for(const chart of charts.values())chart.dispose();charts.clear();}};
}
