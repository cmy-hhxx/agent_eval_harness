import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {AssistantSessions} from '@eval/runtime/assistant';
import {assistantEndpoints} from '@eval/assistant/server';
import {object, type JsonObject, type ModelConfig} from '@eval/contracts';

test('upstream settings mutations persist per user and reject stale or unsupported writes', async () => {
  const directory = await mkdtemp(tmpdir() + '/assistant-settings-');
  const options = {directory, url: 'http://127.0.0.1:1', model: {} as ModelConfig, systemPrompt: 'test', tools: []};
  const sessions = new AssistantSessions(options), replica = new AssistantSessions(options);
  const endpoints = assistantEndpoints(sessions);
  const call = (method: string, args: JsonObject = {}) => endpoints.call('alice', 'settings/' + method, {args}, new AbortController().signal);
  const section = (document: JsonObject, ns: string) => (document.namespaces as JsonObject[]).find(view => view.ns === ns)!;
  const themeDefaults = {preference: 'light', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    textFontFamily: '', codeFontFamily: '', terminalFontFamily: ''};
  try {
    const before = object(await call('describe'));
    assert.equal(before.writable, true);
    assert.deepEqual(section(before, 'ui-theme').value, themeDefaults);
    assert.equal(object(section(before, 'ui-chat').value).transcriptView, 'detailed');
    const write = (ns: string, field: string, value: unknown, expectedRevision: number) => call('mutate', {ns, ops: [{op: 'set', path: [field], value}], expectedRevision});
    await write('ui-theme', 'fontSize', 16, 0);
    await assert.rejects(write('ui-theme', 'fontSize', 15, 0), /另一窗口/);
    await write('locale', 'preference', 'en', 0);
    await write('locale', 'preference', 'ja', 1);
    await write('ui-conversation', 'busyEnter', 'steer', 0);
    await write('ui-chat', 'transcriptView', 'verbose', 0);
    await write('ui-chat', 'performanceUsage', 'compact', 1);
    await assert.rejects(write('ui-chat', 'transcriptView', 'unknown', 2), /Unsupported/);
    await write('ui-chat', 'collapseTiming', 'next-input', 2);
    await write('ui-chat', 'foldedReplies', 'final', 3);
    await assert.rejects(write('ui-chat', 'collapseTiming', 'unknown', 4));
    await assert.rejects(write('ui-chat', 'foldedReplies', 'none', 4));
    await write('ui-theme', 'fontSize', 10, 1);
    await write('ui-theme', 'fontSize', 22, 2);
    for (const invalid of [9, 23, 14.5]) await assert.rejects(write('ui-theme', 'fontSize', invalid, 3));
    await assert.rejects(write('ui-theme', 'preference', 'dark', 3), /Unsupported/);
    await write('ui-theme', 'codeFontSize', 14, 3);
    await write('ui-theme', 'terminalFontSize', 18, 4);
    await write('ui-theme', 'textFontFamily', 'Inter', 5);
    await assert.rejects(write('ui-theme', 'codeFontSize', 17, 6));
    await assert.rejects(write('ui-theme', 'terminalFontSize', 21, 6));
    await assert.rejects(write('ui-theme', 'textFontFamily', 42, 6));
    await assert.rejects(write('locale', 'preference', 'invalid_language!', 2));
    await assert.rejects(write('ui-settings', 'enabled', false, 0), /Invalid/);
    const restored = await replica.settings('alice');
    assert.deepEqual(section(restored, 'ui-theme').value, {...themeDefaults, fontSize: 22, codeFontSize: 14, terminalFontSize: 18, textFontFamily: 'Inter'});
    assert.deepEqual(section(restored, 'locale').value, {preference: 'ja'});
    assert.deepEqual(section(restored, 'ui-conversation').value, {busyEnter: 'steer'});
    assert.deepEqual(section(restored, 'ui-chat').value, {transcriptView: 'verbose', performanceUsage: 'compact', linkOpening: 'new-tab', collapseTiming: 'next-input', foldedReplies: 'final'});
    assert.equal(section(restored, 'ui-theme').revision, 6);
    assert.deepEqual(section(await replica.settings('bob'), 'ui-theme').value, themeDefaults);
  } finally { await sessions.dispose(); await replica.dispose(); await rm(directory, {recursive: true, force: true}); }
});
