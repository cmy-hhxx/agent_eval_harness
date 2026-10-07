import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { buildReport } from './build.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const stylePaths = [
  'src/tokens.css', 'src/styles.css', 'src/rules.css', 'src/prompts.css',
  'src/architecture.css', 'src/experiments.css',
];
const scriptPaths = [
  'src/data.js', 'src/case-summaries-a.js', 'src/case-summaries-b.js', 'src/motion.js', 'src/icons.js',
  'src/answer.js', 'src/details.js', 'src/flow.js', 'src/rules.js', 'src/prompt-data.js', 'src/architecture.js',
  'src/experiment-data.js', 'src/experiments.js', 'src/prompts.js', 'src/app.js',
];

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
    for (const path of ['src/data.js', 'src/prompt-data.js', 'src/experiment-data.js']) {
      const embedded = scripts.find(([, attributes]) => attributes.includes(`data-source="${path}"`))?.[2];
      assert.ok(embedded, `构建产物必须保留完整的 ${path}`);
      const source = { window: {} };
      const result = { window: {} };
      vm.runInNewContext(await readFile(join(directory, path), 'utf8'), source);
      vm.runInNewContext(embedded, result);
      assert.equal(JSON.stringify(result.window), JSON.stringify(source.window), `${path} 内联不可改变来源快照`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('导出不能覆盖页面或样式、数据、逻辑源文件', async () => {
  for (const path of ['index.html', ...stylePaths, ...scriptPaths, 'build.mjs', 'build.test.mjs', 'interaction.test.mjs', 'README.md', 'PHOSPHOR-LICENSE.txt']) {
    await assert.rejects(buildReport({ output: join(directory, path) }), /不能覆盖汇报源文件/);
  }
});

test('页面保留五个主题入口与独立挂载点，不添加下载入口', async () => {
  const dom = new JSDOM(await readFile(join(directory, 'index.html'), 'utf8'));
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

test('每一份样式都拒绝外部 URL，允许内嵌与本页片段', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'evaluation-report-css-'));
  try {
    await mkdir(join(temporary, 'src'));
    for (const path of ['build.mjs', 'index.html', ...stylePaths, ...scriptPaths]) {
      await copyFile(join(directory, path), join(temporary, path));
    }
    const { buildReport: buildFixture } = await import(pathToFileURL(join(temporary, 'build.mjs')).href);
    const output = join(temporary, 'report.html');
    for (const path of stylePaths) {
      const cssPath = join(temporary, path);
      const original = await readFile(cssPath, 'utf8');
      for (const url of ['https://example.invalid/font.woff2', '../image.png']) {
        await writeFile(cssPath, `${original}\n.offline-check { background-image: url("${url}"); }`);
        await assert.rejects(buildFixture({ output }), /仍包含外部资源/, `${path} 必须检查 ${url}`);
      }
      await writeFile(cssPath, original);
    }
    await writeFile(join(temporary, 'src/prompts.css'), '.fragment { filter: url(#local-filter); } .inline { background: url("data:image/png;base64,AA=="); }');
    await buildFixture({ output });
    assert.ok((await readFile(output, 'utf8')).includes('data:image/png;base64,AA=='));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
