import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 将 four-knowns 导出器的正文嵌入既有单文件汇报，保留项目自己的导航与样式。
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--html') throw new Error('用法：node evaluation-report/scripts/research.mjs --html /临时目录/研究导出.html');
const markdown = await readFile(resolve(directory, 'agent-evaluation-research-2026.md'), 'utf8');
const exported = await readFile(resolve(args[1]), 'utf8');
const date = markdown.match(/数据获取时间：(\d{4}-\d{2}-\d{2})/)?.[1];
const main = exported.match(/<main>([\s\S]*?)<\/main>/)?.[1];
if (!date || !main) throw new Error('研究日期或 four-knowns 导出正文缺失。');
const sourceIds = ['meituan', 'aws', 'bytedance', 'bytedanceMirror', 'harbor', 'harborVerifier', 'harborJobs', 'anthropic', 'openai', 'google', 'inspect', 'promptfoo', 'deepeval', 'langsmith', 'ragas', 'pi'];
const sources = [...markdown.matchAll(/^(\d+)\. \[([^\]]+)\]\((https:\/\/[^)]+)\)，([^\n]+)$/gm)].map(([, number, title, url, description]) => {
  const [date, ...notes] = description.split('。');
  return { id: sourceIds[Number(number) - 1], number: Number(number), title, url, date, note: notes.join('。').replace(/。$/, '') };
});
if (sources.length !== sourceIds.length || sources.some((source, index) => source.number !== index + 1 || !source.id)) throw new Error('来源目录须与已维护的编号及标识逐项对应。');
const attribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const reportHtml = main.trim().replace(/\[(\d+)\]/g, (reference, number) => {
  const source = sources[Number(number) - 1];
  if (!source) throw new Error(`缺少来源 ${reference}`);
  return `<a class="research-cite" href="${attribute(source.url)}" target="_blank" rel="noopener noreferrer">${reference}</a>`;
});
await writeFile(resolve(directory, 'src/data/research.js'), `// 由 scripts/research.mjs 从研究 Markdown 与 four-knowns 导出正文生成。\nwindow.EvaluationResearchData = ${JSON.stringify({ date, sources, reportHtml }, null, 2)};\n`);
console.log(`已嵌入研究全文与 ${sources.length} 条来源。`);
