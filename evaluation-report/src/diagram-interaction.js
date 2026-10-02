(() => {
  'use strict';

  const mounted = new WeakMap();

  window.ReportDiagram = {
    mount(root, { regions, onSwap }) {
      mounted.get(root)?.destroy();
      const svg = root.querySelector('#evaluationMechanism');
      const scene = svg?.querySelector('#mechanismScene');
      const resetButton = root.querySelector('[data-reset-diagram]');
      const status = root.querySelector('[data-diagram-status]');
      if (!scene || !resetButton || !status) throw new Error('流程图缺少交互容器或状态控件。');

      const definitions = new Map();
      const elements = new Map();
      const triggers = new Map();
      for (const region of regions) {
        if (definitions.has(region.id)) throw new Error(`流程区域重复：${region.id}`);
        const matches = [...scene.querySelectorAll('[data-region]')].filter(element => element.dataset.region === region.id);
        if (matches.length !== 1) throw new Error(`流程区域必须存在且唯一：${region.id}`);
        if (!Array.isArray(region.bounds) || region.bounds.length !== 4
          || !region.bounds.every(Number.isFinite) || region.bounds[2] <= 0 || region.bounds[3] <= 0) {
          throw new Error(`流程区域边界无效：${region.id}`);
        }
        definitions.set(region.id, region);
        elements.set(region.id, matches[0]);
        const trigger = matches[0].querySelector('.region-hit[role="button"]');
        if (!trigger) throw new Error(`流程区域缺少操作目标：${region.id}`);
        triggers.set(region.id, trigger);
      }

      const targets = [...scene.querySelectorAll('[data-region], [data-owner]')];
      const listeners = [];
      let selected = null;
      let restoringFocus = false;
      let destroyed = false;

      function listen(element, event, handler) {
        element.addEventListener(event, handler);
        listeners.push(() => element.removeEventListener(event, handler));
      }

      function highlight(id) {
        const related = new Set(definitions.get(id)?.related || []);
        for (const element of targets) {
          const owner = element.dataset.region || element.dataset.owner;
          element.classList.toggle('active', Boolean(id && owner === id));
          element.classList.toggle('related', Boolean(id && owner !== id && related.has(owner)));
          element.classList.toggle('muted', Boolean(id && owner !== id && !related.has(owner)));
        }
      }

      function reset(restoreFocus = true, announce = true) {
        const previous = triggers.get(selected);
        selected = null;
        scene.style.removeProperty('transform');
        scene.style.removeProperty('transform-origin');
        scene.style.removeProperty('transform-box');
        root.classList.remove('is-zoomed');
        resetButton.hidden = true;
        for (const [id, element] of triggers) {
          if (definitions.get(id).action !== 'swap') element.setAttribute('aria-pressed', 'false');
        }
        highlight(null);
        status.textContent = announce ? '已返回完整流程图' : '';
        if (restoreFocus && previous?.isConnected) {
          restoringFocus = true;
          previous.focus({ preventScroll: true });
          restoringFocus = false;
        }
      }

      function activate(id) {
        if (destroyed) return;
        const region = definitions.get(id);
        if (region.action === 'swap') {
          onSwap?.();
          status.textContent = '匿名映射已交换';
          return;
        }
        if (selected === id) {
          reset();
          return;
        }
        selected = id;
        root.classList.add('is-zoomed');
        const [x, y, width, height] = region.bounds;
        const viewport = svg.getBoundingClientRect();
        const [viewX, viewY, viewWidth, viewHeight] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
        const unitScale = viewport.width && viewport.height ? Math.min(viewport.width / viewWidth, viewport.height / viewHeight) : 1;
        const visibleWidth = viewport.width ? viewport.width / unitScale : viewWidth;
        const visibleHeight = viewport.height ? viewport.height / unitScale : viewHeight;
        const scale = Math.max(1, Math.min(2.5, (visibleWidth - 70) / width, (visibleHeight - 70) / height));
        const translateX = viewX + viewWidth / 2 - (x + width / 2) * scale;
        const translateY = viewY + viewHeight / 2 - (y + height / 2) * scale;
        const rounded = value => Math.round(value * 1000) / 1000;
        scene.style.transformOrigin = '0 0';
        scene.style.transformBox = 'view-box';
        scene.style.transform = `translate(${rounded(translateX)}px, ${rounded(translateY)}px) scale(${rounded(scale)})`;
        resetButton.hidden = false;
        for (const [key, element] of triggers) {
          if (definitions.get(key).action !== 'swap') element.setAttribute('aria-pressed', String(key === id));
        }
        highlight(id);
        status.textContent = `已放大${region.label}`;
      }

      // Exported HTML may contain a previous selection; mounting always starts at the full diagram.
      reset(false, false);
      for (const [id, element] of elements) {
        listen(element, 'mouseenter', () => highlight(selected || id));
        listen(element, 'mouseleave', () => highlight(selected));
        listen(triggers.get(id), 'focus', () => { if (!restoringFocus) highlight(id); });
        listen(triggers.get(id), 'blur', () => highlight(selected));
        listen(element, 'click', () => activate(id));
      }
      listen(root, 'keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          reset();
          return;
        }
        const element = event.target.closest?.('[data-region]');
        if (!element || !scene.contains(element) || !elements.has(element.dataset.region)) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate(element.dataset.region);
          return;
        }
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const index = regions.findIndex(region => region.id === element.dataset.region);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? regions.length - 1
          : Math.max(0, Math.min(regions.length - 1, index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)));
        triggers.get(regions[next].id).focus({ preventScroll: true });
      });
      listen(resetButton, 'click', () => reset());
      listen(window, 'beforeprint', () => reset(false, false));
      listen(window, 'afterprint', () => reset(false, false));

      const controller = {
        reset,
        destroy() {
          if (destroyed) return;
          destroyed = true;
          listeners.forEach(remove => remove());
          reset(false, false);
          if (mounted.get(root) === controller) mounted.delete(root);
        },
      };
      mounted.set(root, controller);
      return controller;
    },
  };
})();
