import { createElement as h, useEffect, useRef, useState } from 'react';
import { $getRoot, $getSelection, $isRangeSelection, COMMAND_PRIORITY_HIGH, KEY_ESCAPE_COMMAND, KEY_TAB_COMMAND } from 'lexical';
import { mergeRegister } from '@lexical/utils';
import './prediction.css';

function caretAtEnd() {
  const selection = $getSelection(), end = $getRoot().getLastDescendant();
  if ($getRoot().getTextContent() === '') return selection === null || ($isRangeSelection(selection) && selection.isCollapsed());
  return $isRangeSelection(selection) && selection.isCollapsed() && end !== null
    && selection.anchor.key === end.getKey() && selection.anchor.offset === end.getTextContentSize();
}

function Prediction({ sessionId, editor, disabled, useInput, useSession, useProjection, inputActions, remote, history, t }) {
  const input = useInput(state => state);
  const pending = useSession(state => state.pendingSubmissions.length > 0 || state.openState !== 'open');
  const turn = useProjection('turnBoundary', boundary => boundary?.lastTurn ?? 0);
  const model = useProjection('modelSelection', selection => JSON.stringify(selection?.next ?? selection?.lastUsed ?? null));
  const [suggestion, setSuggestion] = useState(null);
  const [atEnd, setAtEnd] = useState(false);
  const [composing, setComposing] = useState(false);
  const live = useRef({});
  const blocked = disabled || pending || input.phase !== 'plain' || input.attachmentIds.length > 0 || input.occurrences.length > 0;
  const key = JSON.stringify([sessionId, turn, model]);
  const text = suggestion?.key === key ? suggestion.text : '';
  const visible = !blocked && !composing && atEnd && text && text.startsWith(input.draft) && text !== input.draft;
  live.current = { visible, text, draftRev: input.draftRev, draft: input.draft };

  useEffect(() => { setSuggestion(null); }, [sessionId]);
  useEffect(() => { if (blocked || (text && !text.startsWith(input.draft))) setSuggestion(null); }, [blocked, text, input.draft]);
  useEffect(() => {
    if (blocked || composing || input.draft !== '' || !turn || history.attempted === key) return;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      history.attempted = key;
      try {
        const result = await remote.predict({ sessionId, sourceTurn: turn, recentSuggestions: history.recent }, abort.signal);
        if (abort.signal.aborted) return;
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.text) {
          history.recent = [...history.recent, result.value.text].slice(-16);
          setSuggestion({ key, text: result.value.text });
        }
      } catch (error) { if (!abort.signal.aborted) console.warn('Eris prediction failed', error); }
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [sessionId, key, turn, blocked, composing, input.draft === '', remote, history]);

  useEffect(() => {
    if (editor === null) return;
    let composingUntil = 0;
    const update = () => editor.getEditorState().read(() => setAtEnd(caretAtEnd()));
    const start = () => { setComposing(true); composingUntil = Infinity; };
    const end = () => { setComposing(false); composingUntil = Date.now() + 10; };
    update();
    return mergeRegister(
      editor.registerUpdateListener(update),
      editor.registerRootListener((root, previous) => {
        previous?.removeEventListener('compositionstart', start);
        previous?.removeEventListener('compositionend', end);
        root?.addEventListener('compositionstart', start);
        root?.addEventListener('compositionend', end);
      }),
      editor.registerCommand(KEY_TAB_COMMAND, event => {
        const current = live.current;
        if (!current.visible || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
          || event.isComposing || event.keyCode === 229 || editor.isComposing() || Date.now() < composingUntil || !caretAtEnd()) return false;
        if (!inputActions.insertText(current.text.slice(current.draft.length), {
          start: current.draft.length, end: current.draft.length, draftRev: current.draftRev,
        })) return false;
        event.preventDefault();
        setSuggestion(null);
        return true;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ESCAPE_COMMAND, event => {
        if (!live.current.visible || event.isComposing || editor.isComposing() || Date.now() < composingUntil) return false;
        event.preventDefault(); setSuggestion(null); return true;
      }, COMMAND_PRIORITY_HIGH),
    );
  }, [editor, inputActions]);

  if (!visible) return null;
  return h('div', { className: 'eris-prediction', 'data-prediction': true, 'aria-label': t('accept') },
    h('span', { className: 'eris-prediction-text' },
      h('span', { style: { visibility: 'hidden' }, 'aria-hidden': true }, input.draft), text.slice(input.draft.length)),
    h('kbd', { 'aria-hidden': true }, 'Tab'));
}

export const inject = ['slots', 'remote', 'remote.assistant', 'locale'];
export function apply(ctx) {
  const namespace = 'assistant.prediction';
  const histories = new Map();
  ctx.effect(() => ctx.locale.register(namespace, {
    zh: { accept: 'Tab 补全下一问，Esc 隐藏' },
    en: { accept: 'Tab to complete, Esc to dismiss' },
  }));
  ctx.slots.inject('conversation.input.prediction', () => ctx.slots.register({
    name: 'conversation.input.prediction', locale: namespace,
    inject: sessionId => {
      if (!histories.has(sessionId)) histories.set(sessionId, { attempted: '', recent: [] });
      return { remote: ctx.remote.assistant, history: histories.get(sessionId) };
    },
  }, Prediction));
}
