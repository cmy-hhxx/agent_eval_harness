import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { buildReport } from '../scripts/build.mjs';

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const template = await readFile(join(directory, 'src/template.html'), 'utf8');
const templateDOM = new JSDOM(template);
const stylePaths = [...templateDOM.window.document.querySelectorAll('link[rel="stylesheet"]')].map(link => `src/${link.getAttribute('href')}`);
const scriptPaths = [...templateDOM.window.document.querySelectorAll('script[src]')].map(script => `src/${script.getAttribute('src')}`);
const snapshotPaths = [...templateDOM.window.document.querySelectorAll('script[data-snapshot]')].map(script => `src/${script.getAttribute('src')}`);
templateDOM.window.close();

async function createFixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'evaluation-report-build-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const path of ['scripts/build.mjs', 'src/template.html', ...stylePaths, ...scriptPaths]) {
    await mkdir(dirname(join(temporary, path)), { recursive: true });
    await copyFile(join(directory, path), join(temporary, path));
  }
  const { buildReport: buildFixture } = await import(pathToFileURL(join(temporary, 'scripts/build.mjs')).href);
  return { temporary, buildFixture, output: join(temporary, 'report.html') };
}

test('离线导出内联全部展示资源，并完整保留内容快照', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'evaluation-report-'));
  try {
    const output = await buildReport({ output: join(temporary, '汇报.html') });
    const html = await readFile(output, 'utf8');
    assert.match(html, /<html\b[^>]*data-standalone="true"/);
    assert.doesNotMatch(html, /<(?:script|link)\b[^>]*(?:src|href)=["']src\//);
    const styles = [...html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)];
    assert.deepEqual(styles.map(([, attributes]) => attributes.match(/data-source="([^"]+)"/)?.[1]), stylePaths);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    assert.deepEqual(scripts.map(([, attributes]) => attributes.match(/data-source="([^"]+)"/)?.[1]), scriptPaths);
    for (const [, , script] of scripts) new vm.Script(script);
    for (const path of scriptPaths.filter(path => path.startsWith('src/data/'))) {
      const embedded = scripts.find(([, attributes]) => attributes.includes(`data-source="${path}"`))?.[2];
      assert.ok(embedded, `构建产物必须保留完整的 ${path}`);
      const source = { window: {} };
      const result = { window: {} };
      vm.runInNewContext(await readFile(join(directory, path), 'utf8'), source);
      vm.runInNewContext(embedded, result);
      assert.equal(JSON.stringify(result.window), JSON.stringify(source.window), `${path} 内联不可改变来源快照`);
      if (snapshotPaths.includes(path)) assert.equal(embedded.trim().split('\n').length, 1, `${path} 只压缩格式化空白`);
    }
    for (const path of scriptPaths.filter(path => !snapshotPaths.includes(path))) {
      const embedded = scripts.find(([, attributes]) => attributes.includes(`data-source="${path}"`))?.[2];
      const original = await readFile(join(directory, path), 'utf8');
      assert.equal(embedded.trim(), original.replace(/<\/script/gi, closing => closing.replace('</', '<\\/')).trim(), `${path} 保持源码格式`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('导出不能覆盖页面或样式、数据、逻辑源文件', async () => {
  for (const path of ['src/template.html', ...stylePaths, ...scriptPaths, 'scripts/build.mjs', 'tests/build.test.mjs', 'tests/interaction.test.mjs', 'README.md', 'licenses/PHOSPHOR-LICENSE.txt']) {
    await assert.rejects(buildReport({ output: join(directory, path) }), /不能覆盖汇报源文件/);
  }
});

test('页面保留五个主题入口与独立挂载点，不添加下载入口', async () => {
  const dom = new JSDOM(await readFile(join(directory, 'src/template.html'), 'utf8'));
  try {
    const { document } = dom.window;
    assert.equal(document.querySelector('[download],#downloadPromptsBtn,#exportHtmlBtn'), null);
    for (const control of document.querySelectorAll('button,a')) assert.doesNotMatch(control.textContent, /下载|导出/);
    assert.deepEqual([...document.querySelectorAll('[data-page]')].map(button => button.dataset.page), ['flow', 'architecture', 'rules', 'prompts', 'experiments']);
    for (const page of ['flow', 'architecture', 'rules', 'prompts', 'experiments']) {
      assert.ok(document.querySelector(`#page-${page} #${page}Body`), `${page} 需要对应的独立渲染入口`);
    }
  } finally {
    dom.window.close();
  }
});

test('每一份样式都拒绝外部 URL，允许内嵌与本页片段', async t => {
  const { temporary, buildFixture, output } = await createFixture(t);
  for (const path of stylePaths) {
    const cssPath = join(temporary, path);
    const original = await readFile(cssPath, 'utf8');
    for (const url of ['https://example.invalid/font.woff2', '../image.png']) {
      await writeFile(cssPath, `${original}\n.offline-check { background-image: url("${url}"); }`);
      await assert.rejects(buildFixture({ output }), /仍包含外部资源/, `${path} 必须检查 ${url}`);
    }
    await writeFile(cssPath, original);
  }
  await writeFile(join(temporary, 'src/pages/prompts/styles.css'), '.fragment { filter: url(#local-filter); } .inline { background: url("data:image/png;base64,AA=="); }');
  await buildFixture({ output });
  assert.ok((await readFile(output, 'utf8')).includes('data:image/png;base64,AA=='));
});

test('模板新增资源自动内联并保持顺序，重复和越界引用明确失败', async t => {
  const { temporary, buildFixture, output } = await createFixture(t);
  const templatePath = join(temporary, 'src/template.html');
  await writeFile(join(temporary, 'src/extra.js'), 'window.extra = "<$&>";');
  await writeFile(join(temporary, 'src/extra.css'), '.extra { color: black; }');
  await writeFile(templatePath, template.replace('</head>', '<link rel="stylesheet" href="extra.css"></head>').replace('</body>', '<script id="extra" src="extra.js"></script></body>'));
  await buildFixture({ output });
  const dom = new JSDOM(await readFile(output, 'utf8'));
  try {
    assert.equal(dom.window.document.querySelector('style:last-of-type').textContent.trim(), '.extra { color: black; }');
    assert.equal(dom.window.document.querySelector('script:last-of-type').textContent.trim(), 'window.extra = "<$&>";');
    assert.equal(dom.window.document.querySelector('script:last-of-type').id, 'extra');
  } finally {
    dom.window.close();
  }
  for (const [path, error] of [
    ['data/../data/cases.js', /不可重复引用/],
    ['../outside.js', /必须位于 src/],
    ['https://example.invalid/extra.js', /必须位于 src/],
  ]) {
    await writeFile(templatePath, template.replace('</body>', `<script src="${path}"></script></body>`));
    await assert.rejects(buildFixture({ output }), error);
  }
});

test('快照压缩保留特殊文本且不执行快照中的代码', async t => {
  const { temporary, buildFixture, output } = await createFixture(t);
  const snapshot = { text: '</ScRiPt><script>throw new Error("unsafe")</script> <$&> 中文\n  空白', nested: [null, false, 1.5] };
  const sourcePath = join(temporary, 'src/data/prompts.js');
  await writeFile(sourcePath, `// 快照\nwindow.ReportPromptData = ${JSON.stringify(snapshot, null, 2)};\n`);
  await buildFixture({ output });
  const dom = new JSDOM(await readFile(output, 'utf8'));
  try {
    const script = dom.window.document.querySelector('#report-prompt-data').textContent;
    const context = { window: {} };
    vm.runInNewContext(script, context);
    assert.equal(JSON.stringify(context.window.ReportPromptData), JSON.stringify(snapshot));
    assert.equal(dom.window.document.scripts.length, scriptPaths.length);
  } finally {
    dom.window.close();
  }
  for (const invalid of ['window.ReportPromptData = { get text() { throw new Error("executed"); } };', 'window.ReportPromptData = {}; throw new Error("executed");']) {
    await writeFile(sourcePath, invalid);
    await assert.rejects(buildFixture({ output }), /不是有效的 JSON 数据快照/);
  }
});
