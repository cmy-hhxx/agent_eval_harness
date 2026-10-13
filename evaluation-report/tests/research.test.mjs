import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { test } from 'node:test';

test('行业图的连接不穿过其他节点，节点与引用完整', async t => {
  const dom = new JSDOM('<div id="research"></div>', { runScripts:'outside-only' });
  t.after(() => dom.window.close());
  for (const file of ['data/research.js','pages/research/flows.js','pages/research/index.js']) {
    dom.window.eval(await readFile(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8'));
  }
  const { document } = dom.window;
  const style = document.createElement('style');
  style.textContent = await readFile(fileURLToPath(new URL('../src/pages/research/styles.css', import.meta.url)), 'utf8');
  document.head.append(style);
  dom.window.ReportResearch.render(document.querySelector('#research'), dom.window.EvaluationResearchData);
  const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length, '图的标题、描述与箭头引用不能重名');
  const tableStyle = dom.window.getComputedStyle(document.querySelector('.research-repository-table'));
  assert.equal(tableStyle.tableLayout,'fixed','列宽按容器分配');
  assert.equal(parseFloat(tableStyle.minWidth) || 0,0,'表格不强制超出视口的最小宽度');

  for (const figure of document.querySelectorAll('.research-flow')) {
    const name = figure.dataset.flowId;
    const graph = dom.window.ReportResearchFlows.workflows.flatMap(flow => flow.graphs).find(graph => graph.id === name);
    const labels = [...figure.querySelectorAll('.research-edge text')].map(text => text.textContent);
    assert.deepEqual(labels,Array.from(graph.edges.filter(edge => edge.label), edge => edge.label),`${name}: 只显示原始分支标签，不显示布局坐标`);
    const description = figure.querySelector('desc').textContent;
    for (const label of labels) assert.ok(description.includes(`（${label}）`),`${name}: 辅助阅读包含分支条件`);
    assert.doesNotMatch(description,/\d+,\d+,(start|middle|end)/,`${name}: 辅助阅读不包含布局坐标`);
    const svg = figure.querySelector('svg');
    const [, , width, height] = svg.getAttribute('viewBox').split(' ').map(Number);
    assert.ok(parseFloat(svg.style.getPropertyValue('--diagram-width')) <= width,'图按内容宽度限制尺寸，不放大填满页面');
    assert.equal(parseFloat(dom.window.getComputedStyle(svg).minWidth) || 0,0,'流程图不强制超出视口的最小宽度');
    const rectangles = [...figure.querySelectorAll('.research-node')].map(group => {
      const rect = group.querySelector('rect');
      return {id:group.dataset.nodeId, x:+rect.getAttribute('x'), y:+rect.getAttribute('y'), w:+rect.getAttribute('width'), h:+rect.getAttribute('height')};
    });
    for (const r of rectangles) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height, `${name}: ${r.id} 不可裁掉`);
    const labelBounds = [];
    for (const text of figure.querySelectorAll('svg text')) {
      assert.ok(['none','rgba(0, 0, 0, 0)'].includes(dom.window.getComputedStyle(text).stroke),`${name}: 文字不使用会遮住选区的描边`);
      if (!text.closest('.research-edge')) continue;
      // 保守估计文字范围；真实 SVG 选区绘制仍需浏览器检查。
      const fontSize = parseFloat(dom.window.getComputedStyle(text).fontSize);
      const w = [...text.textContent].reduce((sum,c) => sum + (/^[\x00-\x7f]$/.test(c) ? 0.6 : 1) * fontSize,0);
      const anchor = text.getAttribute('text-anchor');
      const x = +text.getAttribute('x') - (anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0);
      const box = {id:`标签「${text.textContent}」`,x,y:+text.getAttribute('y') - fontSize,w,h:fontSize + 4};
      assert.ok(box.x >= 0 && box.x + box.w <= width && box.y >= 0 && box.y + box.h <= height,`${name}: ${box.id} 不可裁掉`);
      for (const r of [...rectangles,...labelBounds]) {
        assert.equal(box.x < r.x + r.w && box.x + box.w > r.x && box.y < r.y + r.h && box.y + box.h > r.y,false,`${name}: ${box.id} 不可重叠 ${r.id}`);
      }
      labelBounds.push(box);
    }
    for (const path of figure.querySelectorAll('.research-edge path')) {
      assert.ok(rectangles.some(r => r.id === path.dataset.from));
      assert.ok(rectangles.some(r => r.id === path.dataset.to));
      const points = [...path.getAttribute('d').matchAll(/[ML] ([\d.]+) ([\d.]+)/g)].map(match => [+match[1],+match[2]]);
      for (let index = 1; index < points.length; index++) {
        const [a,b] = [points[index - 1],points[index]];
        assert.ok(a[0] === b[0] || a[1] === b[1], `${name}: 连接保持正交`);
        for (const r of [...rectangles.filter(r => r.id !== path.dataset.from && r.id !== path.dataset.to),...labelBounds]) {
          const crosses = a[0] === b[0]
            ? a[0] > r.x && a[0] < r.x + r.w && Math.max(a[1],b[1]) > r.y && Math.min(a[1],b[1]) < r.y + r.h
            : a[1] > r.y && a[1] < r.y + r.h && Math.max(a[0],b[0]) > r.x && Math.min(a[0],b[0]) < r.x + r.w;
          assert.equal(crosses,false,`${name}: ${path.dataset.from} → ${path.dataset.to} 穿过 ${r.id}`);
        }
      }
    }
    assert.ok(figure.querySelector('figcaption a'), `${name}: 图下缺少依据`);
    for (const link of figure.querySelectorAll('figcaption a')) {
      assert.equal(new URL(link.href).protocol,'https:');
      assert.equal(link.rel,'noopener noreferrer');
    }
  }
});
