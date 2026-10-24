import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantSessions, serveAssistant } from '@eval/runtime/assistant';
import { assistantEndpoints } from '@eval/assistant/server';

const directory = await mkdtemp(tmpdir() + '/eris-prediction-browser-');
const shots = process.cwd() + '/.artifacts/agent-prediction';
await mkdir(shots, { recursive: true });
const question = 'A与B的统计口径哪里不同？';
const acceptedQuestion = 'B回答是否遗漏了关键原文证据？';
const requests = [], turns = [], errors = [];
let delayed;
const server = await serveAssistant({ port: 0, userId: 'local', webDirectory: process.cwd() + '/dist/agent/web',
  endpoints: url => assistantEndpoints(new AssistantSessions({ directory, url, model: { provider: 'test', model: 'test' },
    systemPrompt: 'test', predictionPrompt: 'predict', tools: [],
    predictor: async options => {
      requests.push(options);
      if (turns.at(-1) === '慢请求') { delayed = Promise.withResolvers(); return delayed.promise; }
      if (turns.at(-1) === '换个证据角度') return acceptedQuestion;
      if (turns.at(-1) === acceptedQuestion) return '统计口径统一后，结论会改变吗？';
      if (turns.at(-1) === '再次核对') return '重新核对后，胜负结论会改变吗？';
      return question;
    },
    driver: async ({ event }) => ({ async prompt(text) {
      turns.push(text);
      await event({ type: 'turn_start' });
      await event({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
      await event({ type: 'message_end', message: { role: 'assistant', provider: 'test', model: 'test', content: [{ type: 'text', text: '已核对原文，两份回答的统计口径不同。' }], stopReason: 'stop' } });
      await event({ type: 'agent_end' });
    }, async steer() {}, async abort() {}, async dispose() {} }),
  })),
});
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error' || (message.type() === 'warning' && message.text().includes('prediction'))) errors.push(message.text()); });
  await page.goto(server.url);
  const input = page.locator('[data-composer-input][contenteditable=true]');
  const ghost = page.locator('[data-prediction]');
  await input.waitFor(); await delay(450);
  assert.equal(requests.length, 0, 'blank chats must not invoke prediction');
  await input.fill('比较两份回答的证据'); await input.press('Enter');
  await ghost.waitFor();
  assert.equal(await ghost.locator('.eris-prediction-text').innerText(), question);
  assert.equal(await input.innerText(), '', 'ghost text is not part of the draft');
  assert.equal(requests.length, 1);
  await page.screenshot({ path: shots + '/desktop.png' });
  await page.setViewportSize({ width: 375, height: 812 });
  assert(await ghost.evaluate(node => node.getBoundingClientRect().right <= innerWidth));
  await page.screenshot({ path: shots + '/mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await input.press('Shift+Tab');
  assert.equal(await input.innerText(), '');
  assert.equal(await input.evaluate(node => document.activeElement === node), false, 'Shift+Tab keeps native navigation');
  await input.click(); await input.press('Escape');
  await ghost.waitFor({ state: 'hidden' });
  await input.press('Tab');
  assert.equal(await input.innerText(), '', 'Tab without a visible suggestion must not insert text');

  await input.click(); await input.fill('换个证据角度'); await input.press('Enter'); await ghost.waitFor();
  assert(requests.at(-1).recentSuggestions.includes(question));
  await input.pressSequentially('B回答'); await ghost.waitFor();
  await input.press('Tab');
  assert.equal(await input.innerText(), acceptedQuestion);
  assert.equal(turns.length, 2, 'Tab fills without submitting');
  await input.press('Enter'); await ghost.waitFor();
  assert.equal(turns.at(-1), acceptedQuestion);

  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Tab', code: 'Tab', isComposing: true, keyCode: 229 });
  assert.equal((await input.innerText()).replaceAll('\u200b', ''), '', 'IME padding may exist, but candidate selection does not accept a prediction');
  await input.dispatchEvent('compositionend'); await delay(30);
  await input.fill('慢请求'); await input.press('Enter');
  for (let i = 0; i < 500 && !delayed; i++) await delay(20);
  assert(delayed, 'slow prediction started');
  await input.fill('我自己输入的问题');
  for (let i = 0; i < 500 && !requests.at(-1).signal.aborted; i++) await delay(20);
  assert(requests.at(-1).signal.aborted, 'typing aborts the model request through HTTP');
  delayed.resolve('过期的补全不应该出现？'); await delay(100);
  assert.equal(await input.innerText(), '我自己输入的问题');
  assert.equal(await ghost.count(), 0);
  await input.fill('再次核对'); await input.press('Enter'); await ghost.waitFor();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.waitForFunction(() => document.title === '新对话 — Eris');
  await ghost.waitFor({ state: 'hidden' });
  assert.equal(await input.innerText(), '');
  const calls = requests.length; await delay(450); assert.equal(requests.length, calls);
  assert.deepEqual(errors, []);
  console.log('Prediction browser checks passed; artifacts: ' + shots);
} catch (error) { console.error({ errors, turns, predictionRequests: requests.length }); throw error;
} finally { delayed?.resolve(null); await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
