import { createElement as h, memo, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TraceFlow, traceLabel, evidenceFollowupText } from './case-flow.js';
import { EvidenceContent } from './case-evidence.js';

const summaryStyle = { cursor: 'pointer', padding: '6px 0', color: '#24262B', fontSize: 14, fontWeight: 600 };
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const sourceKey = ref => JSON.stringify([ref?.runId, ref?.taskId, ref?.inputId]);
function sourceReads(data) {
  const reads = [], seen = new Set(), pending = data.map(value => value.root);
  for (const block of pending) {
    if (!block) continue;
    if (Array.isArray(block.subCalls)) pending.push(...block.subCalls);
    if (block.kind !== 'tool-result' || block.isError || seen.has(block.callId)) continue;
    seen.add(block.callId);
    const read = block.meta?.sourceRead;
    if (read?.args?.reference && (['read_case', 'read_evidence'].includes(read.tool)
      || (read.tool === 'read_data' && read.args.reference.inputId && Number.isInteger(read.args.reference.messageIndex)))) reads.push({ callId: block.callId, ...read });
  }
  return reads;
}

/** A follow-up is matched to real answer coordinates after loading, never to the nearest topic. */
export function caseScenesFromTools(current, earlier = []) {
  const reads = sourceReads(current), cases = reads.filter(read => read.tool === 'read_case');
  const seen = new Set();
  if (cases.length) return cases.filter(read => {
    const key = sourceKey(read.args.reference);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(read => ({ key: read.callId, sources: [read] }));
  const history = sourceReads(earlier).filter(read => read.tool === 'read_case').reverse();
  return reads.filter(read => read.tool === 'read_evidence' || read.tool === 'read_data').flatMap(read => {
    const reference = read.args.reference, key = sourceKey(reference);
    if (seen.has(key)) return [];
    seen.add(key);
    const sources = history.filter(candidate => candidate.args.reference.runId === reference.runId
      && (!candidate.args.reference.inputId || candidate.args.reference.inputId === reference.inputId));
    return sources.length ? [{ key, sources, reference }] : [];
  });
}

export async function loadCaseScene(scene, read) {
  let failure;
  for (const source of scene.sources) {
    try {
      const result = await read(source.callId);
      if (!result.ok) throw new Error(result.error.message);
      const material = parse(result.value.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
      if (material?.kind !== 'case' || !Array.isArray(material.answers)) throw new Error('案例地图数据无效');
      const answers = scene.reference ? material.answers.filter(answer => {
        const ref = answer.reference ?? answer.answer?.reference;
        return ref?.runId === scene.reference.runId && ref.inputId === scene.reference.inputId;
      }) : material.answers;
      if (answers.length) return { ...material, answers };
    } catch (error) { failure = error; }
  }
  throw failure ?? new Error('未找到该回答的案例地图');
}

function EvidenceLocation({ answer, node }) {
  const [status, setStatus] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(evidenceFollowupText(answer, node)); setStatus('copied'); }
    catch { setStatus('error'); }
  };
  return h('div', { style: { marginTop: 6 } },
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 } },
      h('details', { ...(status === 'error' ? { open: true } : {}), style: { minWidth: 0, flex: 1 } },
        h('summary', { style: { cursor: 'pointer', fontSize: 12, color: '#737373' } }, '证据位置'),
        h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11, color: '#737373' } }, JSON.stringify(node.reference, null, 2))),
      h('button', { type: 'button', onClick: copy, style: { cursor: 'pointer', flexShrink: 0, padding: '2px 0', border: 0, borderRadius: 0, boxShadow: 'none', background: 'none', color: '#444', fontSize: 12 } }, status === 'copied' ? '已复制' : '复制给 Eris')),
    status === 'error' ? h('div', { role: 'alert', style: { marginTop: 8, fontSize: 12, color: '#944' } }, '复制失败，请手动复制证据位置。') : null);
}

function ModelScene({ answer, question, group }) {
  const [expanded, setExpanded] = useState(false), [selected, setSelected] = useState(() => Math.max(0, answer.trace?.nodes.findIndex(node => node.type === 'user_question' || node.role === 'user') ?? 0));
  const trace = answer.trace, nodes = trace?.nodes ?? [], node = nodes[selected];
  const content = node?.messageIndex === trace?.finalMessageIndex ? answer.answer?.text ?? answer.answer?.preview
    : node?.type === 'user_question' || node?.role === 'user' ? question : node?.preview;
  const callIndex = nodes.findIndex(value => value.messageIndex === node?.callMessageIndex);
  const evidence = useRef(null);
  useLayoutEffect(() => { if (evidence.current) evidence.current.scrollTop = 0; }, [selected]);
  return h('details', { name: group, 'data-case-model': answer.modelName, onToggle: event => setExpanded(event.currentTarget.open), style: { borderTop: '1px solid #E9E9E9' } },
    h('summary', { style: summaryStyle }, answer.modelName,
      h('span', { style: { marginLeft: 10, fontSize: 11, fontWeight: 400, color: '#888' } }, `${nodes.length} 个节点 · ${trace?.toolCalls ?? 0} 次工具调用`)),
    expanded && node ? h('div', { 'data-case-workspace': true, style: { display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', gap: 10, paddingBottom: 6, alignItems: 'start' } },
      h(TraceFlow, { nodes, finalIndex: trace.finalMessageIndex, selected, onSelect: setSelected, modelName: answer.modelName }),
      h('div', { ref: evidence, 'data-case-evidence': true, tabIndex: 0, role: 'region', 'aria-label': `${answer.modelName}节点证据滚动区`, style: { minWidth: 0, minHeight: 0, alignSelf: 'stretch', contain: 'size', overflowY: 'auto', overscrollBehaviorX: 'contain', scrollbarGutter: 'stable', color: '#202B36', paddingRight: 3 } },
        h('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.6 } }, `#${node.messageIndex} · ${traceLabel(node, trace.finalMessageIndex)}`),
        h(EvidenceLocation, { key: node.messageIndex, answer, node }),
        callIndex >= 0 ? h('button', { type: 'button', onClick: () => setSelected(callIndex), style: { cursor: 'pointer', marginTop: 6, padding: 0, color: '#666', background: 'none', border: 0, textDecoration: 'underline', fontSize: 12 } }, `来自调用 #${node.callMessageIndex}`) : null,
        (node.messageIndex === trace.finalMessageIndex ? !answer.answer?.complete : node.previewTruncated)
          ? h('div', { style: { marginTop: 12, color: '#888', fontSize: 12 } }, `预览已截断 · 已显示 ${content?.length ?? 0} 字符`) : null,
        content ? h(EvidenceContent, { key: `content-${node.messageIndex}`, content })
          : h('div', { style: { marginTop: 8, color: '#888', fontSize: 12 } }, node.type === 'reasoning' ? '源记录未提供推理正文或摘要' : '源记录未提供可展示的正文'))) : null);
}

function CaseScene({ scene, remote, sessionId }) {
  const group = useId();
  const [material, setMaterial] = useState(null), [loading, setLoading] = useState(false), [failure, setFailure] = useState('');
  const load = async () => {
    if (material || loading) return;
    setLoading(true); setFailure('');
    try { setMaterial(await loadCaseScene(scene, callId => remote.toolResult({ sessionId, callId }))); }
    catch (error) { setFailure(error.message); }
    finally { setLoading(false); }
  };
  return h('details', { 'data-case-scene': true, onToggle: event => { if (event.currentTarget.open) void load(); }, style: {
    margin: '8px 0', padding: 0, border: 0, borderTop: '1px solid #E1E2E4', borderRadius: 0, background: 'none', boxShadow: 'none', color: '#333', width: '100%', boxSizing: 'border-box',
  } }, h('summary', { style: summaryStyle }, '链路小现场'),
  loading ? h('div', { role: 'status', style: { paddingBottom: 12 } }, '正在读取案例地图…') : null,
  failure ? h('div', { role: 'alert', style: { paddingBottom: 12 } }, failure, ' ', h('button', { type: 'button', onClick: load }, '重试')) : null,
  material?.answers.map(answer => h(ModelScene, { key: sourceKey(answer.reference ?? answer.answer?.reference), group, answer, question: material.question })));
}

export const TurnCaseScenes = memo(function TurnCaseScenes({ turn, useChat, remote, sessionId }) {
  const nodes = useChat(snapshot => snapshot.nodes);
  const source = useMemo(() => nodes.turnDataSource(turn.turn, 'tool-call'), [nodes, turn.turn]);
  const data = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const scenes = useMemo(() => caseScenesFromTools(data, nodes.values()
    .filter(node => node.kind === 'tool-call' && node.location.turn?.turn < turn.turn)
    .sort((a, b) => a.anchorSeq - b.anchorSeq).map(node => node.data)), [data, nodes, turn.turn]);
  return scenes.length ? h('div', { 'data-turn-case-scenes': turn.turn }, scenes.map(scene => h(CaseScene, { key: scene.key, scene, remote, sessionId }))) : null;
});
