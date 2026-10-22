import { mountAnalysis } from "./analysis.js";
import { mountBatchRuns } from './batch-runs.js';
import { mountIntake } from './intake.js';
import { mountAutomation } from './automations.js';
import { mountErrors } from './automation-errors.js';
import { mountRuns } from './dashboard.js';
import { createProblemBrowser } from './problems.js';
import { mountReference } from './reference.js';
import { mountData } from '../../../server_dashboard_ths/dashboard.js';
import { mountRecords } from '../../../server_dashboard_ths/records.js';
import { Tab } from '@tabler/core';

const assets = '/workbench-assets/';
const apiRoot = '/runtime/api/dashboard';
const texts = new Map();
function asset(name) {
  if (!texts.has(name)) texts.set(name, fetch(assets + name).then(async response => {
    if (!response.ok) throw new Error(`${name}：HTTP ${response.status}`);
    return response.text();
  }).catch(error => { texts.delete(name); throw error; }));
  return texts.get(name);
}
// Adapt the existing controllers to Tabler without duplicating their rendering logic.
function components(root) {
  const rules = [
    ['table', ['table', 'table-vcenter']],
    ['button.button, button.table-link, .source-nav button, .table-pagination button, .records-pagination button', ['btn', 'btn-sm']],
    ['.button-primary', ['btn-primary']], ['.button-danger', ['btn-danger']],
    ['select', ['form-select']], ['textarea, input:not([type=checkbox]):not([type=radio]):not([type=hidden])', ['form-control']],
    ['input[type=checkbox], input[type=radio]', ['form-check-input']],
  ];
  const decorate = node => {
    for (const [selector, classes] of rules) {
      if (node.matches?.(selector)) node.classList.add(...classes);
      node.querySelectorAll?.(selector).forEach(item => item.classList.add(...classes));
    }
  };
  decorate(root);
  const observer = new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(decorate)));
  observer.observe(root, { childList:true, subtree:true });
  return observer;
}
const observers = new Map();
// Shadow roots only scope CSS and IDs; every module stays in this document.
async function region(id, template, styles, isCurrent = () => true) {
  const host = document.getElementById(id);
  const [html, ...css] = await Promise.all([asset(template), asset('dashboard.css'), ...styles.map(asset), asset('tabler.css'), asset('workbench-region.css')]);
  if (!isCurrent()) return null;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  parsed.querySelectorAll('script, .workspace-nav, .page-tabs, .library-workspace-link, .quota-policy').forEach(node => node.remove());
  parsed.querySelectorAll('aside').forEach(node => { if (!node.querySelector('#run-list')) node.remove(); });
  const root = host.shadowRoot || host.attachShadow({ mode:'open' });
  observers.get(id)?.disconnect();
  const sheet = document.createElement('style');
  sheet.textContent = css.join('\n').replaceAll(':root', ':host');
  const content = document.createElement('div');
  content.className = parsed.body.className;
  content.append(...parsed.body.childNodes);
  root.replaceChildren(sheet, content);
  host.hidden = false;
  observers.set(id, components(root));
  return root;
}
async function attempt(id, action) {
  try { return await action(); }
  catch (error) {
    const host = document.getElementById(id), root = host.shadowRoot || host;
    const notice = document.createElement('p'); notice.className = 'mount-error'; notice.setAttribute('role','alert');
    notice.append(document.createTextNode(`读取失败：${error.message} `));
    const retry = document.createElement('button'); retry.textContent = '重试'; retry.className = 'btn btn-sm';
    retry.addEventListener('click', () => { notice.remove(); void attempt(id, action); });
    notice.append(retry); root.replaceChildren(notice);
    host.hidden = false;
  }
}
let errors, runs, batchRuns, analysis, dataController, datasetRevision = 0, samplesRevision = 0;
let currentSource = '';
async function samples(selection) {
  const revision = ++samplesRevision;
  if (revision !== samplesRevision) return;
  await attempt('samples-content', async () => {
    const root = await region('samples-content', 'records.html', ['data.css'], () => revision === samplesRevision);
    if (!root || revision !== samplesRevision) return;
    mountRecords(root, selection);
    document.getElementById('samples-content').scrollIntoView({ block:'start' });
  });
}
async function browseTask(task) {
  const revision = ++datasetRevision;
  dataController?.destroy(); samplesRevision++;
  document.getElementById('samples-content').shadowRoot?.replaceChildren();
  document.getElementById('samples-content').hidden = true;
  await attempt('catalog-content', async () => {
    const root = await region('catalog-content', 'data.html', ['data.css'], () => revision === datasetRevision);
    if (!root || revision !== datasetRevision) return;
    dataController = mountData(root, { dataset:task.dataset.slice('/data/'.length), profile:task.profile, onSamples:samples });
    document.getElementById('catalog-content').scrollIntoView({ block:'start' });
  });
}
async function data() {
  await attempt('data-content', async () => {
    const root = await region('data-content', 'intake.html', []);
    await mountIntake(root, { onBrowse:browseTask, async onEvaluate(ids) {
      await loadModule('runs'); activate('runs'); batchRuns?.select(ids);
    } }).ready;
  });
}
async function batchResults(id, location) {
  await loadModule('runs'); await runs.ready; activate('runs');
  const params = new URLSearchParams({ run:id });
  if (location) { params.set('batch', location.batch_id); params.set('case', location.case_id); }
  await runs.restoreRecall(params);
}
const loaders = {
  monitor: () => attempt('monitor-content', async () => mountAutomation(await region('monitor-content', 'automations.html', ['automations.css']), {
    onSource(id) { currentSource = id; errors?.setSource(id); },
  })),
  errors: async () => {
    await attempt('batch-errors-content', async () => mountBatchRuns(await region('batch-errors-content', 'batch-runs.html', []), { onResults:batchResults }).ready);
    return attempt('errors-content', async () => { errors = mountErrors(await region('errors-content', 'automation-errors.html', ['automations.css']), { source:currentSource }); }); },
  runs: async () => {
    await attempt('batch-runs-content', async () => { batchRuns = mountBatchRuns(await region('batch-runs-content','batch-runs.html',[]), { onResults:batchResults, async onAnalysis(id) { await loadModule("problems"); activate("problems"); await analysis.selectRun(id); } }); await batchRuns.ready; });
    return attempt('runs-content', async () => { runs = mountRuns(await region('runs-content', 'index.html', []), { apiRoot, onBatchResume: id => batchRuns.showErrors(id) }); });
  },
  problems: async () => {
    await attempt('analysis-content', async () => { analysis = mountAnalysis(await region('analysis-content','analysis.html',[]), { onResults:batchResults }); await analysis.ready; });
    return attempt('problems-content', async () => {
    const browser = createProblemBrowser(await region('problems-content', 'problems.html', ['problems.css']), fetch, {
      apiRoot, async onRecall(params) {
        await loadModule('runs');
        if (!runs) throw new Error('评测运行尚未加载');
        await runs.ready; await runs.restoreRecall(params);
        activate('runs');
        document.getElementById('runs-content').shadowRoot.getElementById('explorer').scrollIntoView({ block:'start' });
      },
    });
    await browser.load();
  }); },
  reference: () => attempt('definitions-content', async () => mountReference(await region('definitions-content', 'reference.html', ['reference.css']), { apiRoot })),
  data,
};
const loaded = new Map();
function loadModule(id) {
  if (!loaded.has(id)) {
    const panel = document.getElementById(id);
    panel.setAttribute('aria-busy', 'true');
    loaded.set(id, Promise.resolve().then(loaders[id]).finally(() => panel.setAttribute('aria-busy', 'false')));
  }
  return loaded.get(id);
}
const buttons = [...document.querySelectorAll('[data-module]')];
const scrollPositions = new Map();
let active = 'data';
function remember(id) {
  try { sessionStorage.setItem('workbench-module', id); } catch { /* Storage can be disabled. */ }
}
function activate(id) {
  if (!Object.hasOwn(loaders, id)) id = 'data';
  Tab.getOrCreateInstance(document.getElementById(`nav-${id}`)).show();
}
for (const button of buttons) {
  const id = button.dataset.module;
  Tab.getOrCreateInstance(button);
  button.addEventListener('click', () => activate(id));
  button.addEventListener('hide.bs.tab', () => scrollPositions.set(id, window.scrollY));
  button.addEventListener('shown.bs.tab', () => {
    active = id;
    for (const item of buttons) document.getElementById(item.dataset.module).hidden = item !== button;
    document.title = `${button.textContent} · 评测工作台`;
    if (location.hash !== `#${id}`) history.pushState(null, '', `#${id}`);
    remember(id);
    window.scrollTo({ top:scrollPositions.get(id) || 0, behavior:'instant' });
    void loadModule(id);
  });
}
window.addEventListener('hashchange', () => activate(location.hash.slice(1)));
document.querySelectorAll('[data-jump]').forEach(button => button.addEventListener('click', async () => {
  const module = active;
  await loadModule(module);
  if (module !== active) return;
  const [host, target] = button.dataset.jump.split(':');
  const node = document.getElementById(host).shadowRoot?.getElementById(target);
  if (node && !node.hidden) {
    node.setAttribute('tabindex', '-1');
    node.focus({ preventScroll:true });
    node.scrollIntoView({ block:'start' });
  }
}));
let initial = location.hash.slice(1);
if (!initial) { try { initial = sessionStorage.getItem('workbench-module'); } catch { /* Storage can be disabled. */ } }
if (!Object.hasOwn(loaders, initial)) initial = 'data';
activate(initial);
remember(initial);
await loadModule(initial);
async function health() {
  const node = document.getElementById('service-status');
  try {
    const response = await fetch('/health', { cache:'no-store', signal:AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    node.textContent = value.ok ? '服务在线' : '服务异常'; node.classList.toggle('error', !value.ok);
  } catch { node.textContent = '连接中断'; node.classList.add('error'); }
}
void health();
setInterval(() => { if (document.visibilityState === 'visible') void health(); }, 15000);
