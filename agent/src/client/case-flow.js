import { createElement as h, useId, useLayoutEffect, useRef, useState } from 'react';

const stages = { user_question: 'User input', llm_turn: 'Model call', reasoning: 'Reasoning', function_call: 'Tool call', tool_call: 'Tool call', function_call_output: 'Tool result', tool_result: 'Tool result', final_answer: 'Final answer' };
export const traceStage = (node, finalIndex) => node.messageIndex === finalIndex ? 'Final answer'
  : stages[node.type] ?? ({ system: 'System prompt', user: 'User input', assistant: 'Assistant message' }[node.role] ?? node.type);
export const traceLabel = (node, finalIndex) => `${traceStage(node, finalIndex)}${node.name ? ` · ${node.name}` : ''}`;
const stageColors = { 'User input': '#466B91', Reasoning: '#756181', 'Tool call': '#3C746F', 'Tool result': '#3C746F', 'Final answer': '#48665B' };

/** The centre rail records order. Only source-provided call coordinates create association edges. */
export function traceFlowLayout(nodes, heights = []) {
  let y = 4;
  const boxes = nodes.map((node, index) => {
    const box = { node, x: 4, y, width: 188, height: Math.max(32, heights[index] ?? 32) };
    y += box.height + 16;
    return box;
  });
  const byIndex = new Map(boxes.map(box => [box.node.messageIndex, box]));
  return { width: 228, height: Math.max(40, y - 12), boxes,
    order: boxes.slice(1).map((to, index) => ({ from: boxes[index], to })),
    calls: boxes.flatMap(to => {
      const from = byIndex.get(to.node.callMessageIndex);
      return from && from !== to ? [{ from, to }] : [];
    }),
  };
}

export function TraceFlow({ nodes, finalIndex, selected, onSelect, modelName }) {
  const [heights, setHeights] = useState([]);
  const layout = traceFlowLayout(nodes, heights), arrow = useId();
  const selectedNode = nodes[selected];
  const viewport = useRef(null);
  useLayoutEffect(() => {
    const labels = [...viewport.current.querySelectorAll('[data-trace-label]')];
    const measure = () => {
      if (labels.some(label => !label.offsetHeight)) return;
      const next = labels.map(label => label.offsetHeight + 14);
      setHeights(previous => previous.length === next.length && previous.every((height, index) => height === next[index]) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    labels.forEach(label => observer.observe(label));
    return () => observer.disconnect();
  }, [nodes, finalIndex]);
  useLayoutEffect(() => {
    const pane = viewport.current, box = layout.boxes[selected];
    if (!pane || !box) return;
    const reveal = () => {
      const top = box.y + 20, bottom = top + box.height + 4;
      if (top < pane.scrollTop + 20) pane.scrollTop = Math.max(0, top - 20);
      else if (bottom > pane.scrollTop + pane.clientHeight) pane.scrollTop = bottom - pane.clientHeight;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [selected, nodes, heights]);
  return h('div', { ref: viewport, 'data-trace-viewport': true, tabIndex: 0, role: 'region', 'aria-label': `${modelName}链路滚动区`, style: { minWidth: 0, minHeight: 0, height: '100%', maxHeight: `min(${layout.height + 20}px, 560px, 65vh)`, contain: 'size', overflowY: 'auto', overscrollBehaviorX: 'contain', scrollbarWidth: 'thin', scrollbarGutter: 'stable' } },
    h('div', { style: { position: 'sticky', top: 0, zIndex: 1, background: '#fff', display: 'flex', gap: 12, alignItems: 'center', fontSize: 11, lineHeight: '16px', color: '#53616E', paddingBottom: 4 } },
      h('span', null, h('span', { style: { display: 'inline-block', width: 14, borderTop: '2px solid #536574', marginRight: 4, verticalAlign: 'middle' } }), '执行顺序'),
      h('span', null, h('span', { style: { display: 'inline-block', width: 14, borderTop: '2px dashed #356A63', marginRight: 4, verticalAlign: 'middle' } }), '调用关联')),
      h('svg', { 'data-trace-flow': true, role: 'group', 'aria-label': `${modelName}链路流程图`, viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height, style: { display: 'block' } },
        h('defs', null,
          h('marker', { id: `${arrow}-order`, viewBox: '0 0 8 8', refX: 8, refY: 4, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto' }, h('path', { d: 'M 0 0 L 8 4 L 0 8 Z', fill: '#536574' })),
          h('marker', { id: `${arrow}-call`, viewBox: '0 0 8 8', refX: 8, refY: 4, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 180 }, h('path', { d: 'M 0 0 L 8 4 L 0 8 Z', fill: '#356A63' }))),
        layout.order.map(({ from, to }) => h('path', { key: `order-${to.node.messageIndex}`, 'data-flow-edge': 'order', d: `M ${from.x + from.width / 2} ${from.y + from.height + 1} V ${to.y - 3}`, fill: 'none', stroke: '#536574', strokeWidth: 2, strokeLinecap: 'round', markerEnd: `url(#${arrow}-order)` })),
        layout.calls.filter(({ from, to }) => [from.node.messageIndex, to.node.messageIndex].includes(selectedNode?.messageIndex)).map(({ from, to }) => {
          const startX = from.x + from.width + 4, endX = to.x + to.width + 6;
          const startY = from.y + from.height / 2, endY = to.y + to.height / 2;
          const rail = Math.max(startX, endX) + 12, radius = 4, direction = Math.sign(endY - startY);
          return h('path', { key: `call-${from.node.messageIndex}-${to.node.messageIndex}`, 'data-flow-edge': 'call', 'data-from': from.node.messageIndex, 'data-to': to.node.messageIndex,
            d: `M ${startX} ${startY} H ${rail - radius} Q ${rail} ${startY} ${rail} ${startY + direction * radius} V ${endY - direction * radius} Q ${rail} ${endY} ${rail - radius} ${endY} H ${endX}`,
            fill: 'none', stroke: '#356A63', strokeWidth: 2, strokeDasharray: '4 3', strokeLinecap: 'round', markerEnd: `url(#${arrow}-call)` });
        }),
        layout.boxes.map(({ node, x, y, width, height }, index) => {
          const active = selected === index, stage = traceStage(node, finalIndex), endpoint = ['User input', 'Final answer'].includes(stage);
          const color = stageColors[stage] ?? '#667480';
          return h('g', { key: node.messageIndex, className: 'eris-trace-node', role: 'button', tabIndex: 0, 'aria-label': `#${node.messageIndex} ${traceLabel(node, finalIndex)}`, 'aria-pressed': active,
            onClick: () => onSelect(index), onKeyDown: event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); onSelect(index); } }, style: { cursor: 'pointer' } },
            h('rect', { x, y, width, height, rx: endpoint ? 16 : 5, fill: 'none', pointerEvents: 'all', stroke: active ? color : '#CCD3DA', strokeWidth: active ? 1.5 : 1 }),
            h('rect', { x: x + 6, y: y + 9, width: 2, height: 14, rx: 1, fill: color, opacity: active ? 1 : 0.6, pointerEvents: 'none' }),
            h('foreignObject', { x: x + 12, y: y + 7, width: width - 40, height: height - 14, style: { pointerEvents: 'none' } },
              h('div', { 'data-trace-label': true, style: { color: '#202B36', fontSize: 13, lineHeight: '18px', fontWeight: active ? 600 : 500, whiteSpace: 'normal', overflowWrap: 'anywhere' } }, traceLabel(node, finalIndex))),
            h('text', { x: x + width - 8, y: y + 20, fill: '#606C77', fontSize: 10, textAnchor: 'end' }, `#${node.messageIndex}`));
        })));
}

export function evidenceFollowupText(answer, node) {
  const callIndex = node.callMessageIndex ?? node.messageIndex;
  const relatedMessageIndices = (answer.trace.nodes ?? []).filter(value => value.messageIndex !== node.messageIndex
    && (value.messageIndex === callIndex || value.callMessageIndex === callIndex)).map(value => value.messageIndex);
  return `请继续调查这条证据及相关上下游节点；只补充新发现、依据和影响，简洁回复，不复述图中已有信息。\n模型：${answer.modelName}\n节点：#${node.messageIndex} ${traceLabel(node, answer.trace.finalMessageIndex)}\n${JSON.stringify({ reference: node.reference, ...(relatedMessageIndices.length ? { relatedMessageIndices } : {}) }, null, 2)}`;
}
