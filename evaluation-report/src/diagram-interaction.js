(() => {
  'use strict';
  const mounted=new WeakMap();
  window.ReportDiagram={
    mount(root,{regions,onSwap}) {
      mounted.get(root)?.destroy();
      const listeners=[],definitions=new Map(regions.map(region=>[region.id,region]));
      const groups=[...root.querySelectorAll('[data-region]')],connections=[...root.querySelectorAll('[data-owner]')];
      const swap=root.querySelector('[data-swap-control]');
      let destroyed=false;
      const listen=(element,event,handler)=>{element.addEventListener(event,handler);listeners.push(()=>element.removeEventListener(event,handler));};
      function highlight(id){
        const related=new Set([id,...(definitions.get(id)?.related||[])]);
        connections.forEach(node=>{node.classList.toggle('active',Boolean(id&&related.has(node.dataset.owner)));});
      }
      groups.forEach(group=>{
        listen(group,'mouseenter',()=>highlight(group.dataset.region));
        listen(group,'mouseleave',()=>highlight(null));
      });
      listen(swap,'click',()=>onSwap());
      listen(swap,'keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSwap();}});
      listen(swap,'focus',()=>highlight('identity-mapping'));listen(swap,'blur',()=>highlight(null));
      const controller={destroy(){if(destroyed)return;destroyed=true;listeners.forEach(remove=>remove());highlight(null);if(mounted.get(root)===controller)mounted.delete(root);}};
      mounted.set(root,controller);return controller;
    },
  };
})();
