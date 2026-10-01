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
  try {
    const before = object(await call('describe'));
    assert.equal(before.writable, true);
    assert.deepEqual(section(before, 'ui-theme').value, {preference: 'light', fontSize: 14});
    assert.equal(object(section(before, 'ui-chat').value).transcriptView, 'detailed');
    const write = (ns: string, field: string, value: unknown, expectedRevision: number) => call('mutate', {ns, ops: [{op: 'set', path: [field], value}], expectedRevision});
    await write('ui-theme', 'fontSize', 16, 0);
    await assert.rejects(write('ui-theme', 'fontSize', 15, 0), /另一窗口/);
    await write('locale', 'preference', 'en', 0);
    await write('ui-conversation', 'busyEnter', 'steer', 0);
    await write('ui-chat', 'transcriptView', 'verbose', 0);
    await write('ui-chat', 'performanceUsage', 'compact', 1);
    await assert.rejects(write('ui-chat', 'transcriptView', 'unknown', 2), /Unsupported/);
    await write('ui-theme', 'fontSize', 10, 1);
    await write('ui-theme', 'fontSize', 22, 2);
    for (const invalid of [9, 23, 14.5]) await assert.rejects(write('ui-theme', 'fontSize', invalid, 3));
    await assert.rejects(write('ui-theme', 'preference', 'dark', 3), /Unsupported/);
    await assert.rejects(write('locale', 'preference', 'unknown', 1), /Unsupported/);
    await assert.rejects(write('ui-settings', 'enabled', false, 0), /Invalid/);
    const restored = await replica.settings('alice');
    assert.deepEqual(section(restored, 'ui-theme').value, {preference: 'light', fontSize: 22});
    assert.deepEqual(section(restored, 'locale').value, {preference: 'en'});
    assert.deepEqual(section(restored, 'ui-conversation').value, {busyEnter: 'steer'});
    assert.deepEqual(section(restored, 'ui-chat').value, {transcriptView: 'verbose', performanceUsage: 'compact', linkOpening: 'new-tab'});
    assert.equal(section(restored, 'ui-theme').revision, 3);
    assert.deepEqual(section(await replica.settings('bob'), 'ui-theme').value, {preference: 'light', fontSize: 14});
  } finally { await sessions.dispose(); await replica.dispose(); await rm(directory, {recursive: true, force: true}); }
});
