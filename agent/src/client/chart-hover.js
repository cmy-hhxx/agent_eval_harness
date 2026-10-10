import { chartTheme } from './chart-theme.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const markSelector = [
  '[data-structure-mark]', '[data-radial-cell]', '[data-waffle-cell]', '[data-chart-hover]',
  '[data-chart-mark="wedge"]', '[data-chart-mark="point"]', '[data-chart-mark="line"]',
  '[data-research-chart] svg path[fill]:not([fill="none"]):not([fill="transparent"]):not([fill-opacity="0"])',
  `[data-research-chart] svg path[fill="none"][stroke]:not([stroke="none"]):not([stroke="${chartTheme.grid}" i]):not([stroke-opacity="0"])`,
].join(',');
let nextMask = 0;

// Measure in screen pixels so the text clearance stays constant across SVG viewBoxes.
function boundsInSvg(rect, inverse, padding = 0) {
  const points = [[rect.left - padding, rect.top - padding], [rect.right + padding, rect.top - padding],
    [rect.right + padding, rect.bottom + padding], [rect.left - padding, rect.bottom + padding]]
    .map(([x, y]) => [inverse.a * x + inverse.c * y + inverse.e, inverse.b * x + inverse.d * y + inverse.f]);
  const x = Math.min(...points.map(p => p[0])), y = Math.min(...points.map(p => p[1]));
  return { x, y, width: Math.max(...points.map(p => p[0])) - x, height: Math.max(...points.map(p => p[1])) - y };
}

export function installChartHover(root) {
  const layers = new Map();
  let active = null;
  const element = (tag, attributes = {}) => {
    const node = root.ownerDocument.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  const findMark = target => {
    const mark = target?.closest?.(markSelector);
    return mark && root.contains(mark) && !mark.closest('[data-chart-hover-layer]') ? mark : null;
  };
  const remove = mark => {
    const entry = layers.get(mark);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.layer.remove();
    layers.delete(mark);
  };
  const leave = () => {
    const mark = active, entry = layers.get(mark);
    active = null;
    if (!entry) return;
    entry.layer.removeAttribute('data-active');
    entry.timer = setTimeout(() => remove(mark), 240);
  };
  const enter = mark => {
    if (mark === active) return;
    leave();
    if (!mark) return;
    if (layers.has(mark)) {
      const entry = layers.get(mark);
      clearTimeout(entry.timer);
      entry.layer.setAttribute('data-active', '');
      active = mark;
      return;
    }
    const svg = mark.ownerSVGElement, screen = svg?.getScreenCTM(), markScreen = mark.getScreenCTM?.();
    if (!screen || !markScreen) return;
    const rect = mark.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const inverse = screen.inverse(), matrix = inverse.multiply(markScreen);
    const viewport = boundsInSvg(svg.getBoundingClientRect(), inverse);
    const maskId = `eris-hover-mask-${++nextMask}`;
    const layer = element('g', { 'data-chart-hover-layer': '', 'aria-hidden': 'true', 'pointer-events': 'none' });
    const mask = element('mask', { id: maskId, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse', ...viewport });
    mask.append(element('rect', { ...viewport, fill: 'white' }));
    for (const label of svg.querySelectorAll('text')) {
      const box = label.getBoundingClientRect();
      if (box.width && box.height) mask.append(element('rect', { ...boundsInSvg(box, inverse, 3), fill: 'black' }));
    }
    const defs = element('defs');
    defs.append(mask);
    // The mask wraps the effect, including its shadow. Original paint and all text stay untouched.
    const protectedLayer = element('g', { mask: `url(#${maskId})` });
    const position = element('g', { transform: `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})` });
    const clone = mark.cloneNode(false);
    for (const { name } of [...clone.attributes]) {
      if (/^(id|class|transform|tabindex|role|focusable)$|^(data-|aria-)/.test(name)) clone.removeAttribute(name);
    }
    clone.classList.add('eris-chart-hover-mark');
    clone.style.pointerEvents = 'none';
    clone.style.setProperty('--eris-hover-scale', String(1 + Math.min(.04, 4 / Math.max(rect.width, rect.height))));
    position.append(clone);
    protectedLayer.append(position);
    layer.append(defs, protectedLayer);
    svg.append(layer);
    layers.set(mark, { layer, timer: null });
    active = mark;
    // Establish the starting frame before entering; hit testing always uses the original shape.
    layer.getBoundingClientRect();
    layer.setAttribute('data-active', '');
  };
  const over = event => enter(findMark(event.target));
  const out = event => { if (findMark(event.relatedTarget) !== active) enter(findMark(event.relatedTarget)); };
  root.addEventListener('pointerover', over);
  root.addEventListener('pointerout', out);
  return () => {
    root.removeEventListener('pointerover', over);
    root.removeEventListener('pointerout', out);
    for (const mark of layers.keys()) remove(mark);
  };
}
