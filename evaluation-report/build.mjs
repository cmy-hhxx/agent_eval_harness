import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const assets = [
  { path: 'src/tokens.css', tag: 'link', attribute: 'href', kind: 'style' },
  { path: 'src/styles.css', tag: 'link', attribute: 'href', kind: 'style' },
  { path: 'src/rules.css', tag: 'link', attribute: 'href', kind: 'style' },
  { path: 'src/prompts.css', tag: 'link', attribute: 'href', kind: 'style' },
  { path: 'src/data.js', tag: 'script', attribute: 'src', kind: 'script' },
  { path: 'src/motion.js', tag: 'script', attribute: 'src', kind: 'script' },
  { path: 'src/icons.js', tag: 'script', attribute: 'src', kind: 'script' },
  { path: 'src/diagram-interaction.js', tag: 'script', attribute: 'src', kind: 'script' },
  { path: 'src/flow.js', tag: 'script', attribute: 'src', kind: 'script' },
  { path: 'src/rules.js', tag: 'script', attribute: 'src', kind: 'script' },
  { path: 'src/prompts.js', tag: 'script', attribute: 'src', kind: 'script' },
  { path: 'src/app.js', tag: 'script', attribute: 'src', kind: 'script' },
];

function attributeValue(tag, attribute) {
  return tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
}

function inlineAsset(html, asset, content) {
  const pattern = asset.tag === 'link' ? /<link\b[^>]*>/gi : /<script\b[^>]*>\s*<\/script\s*>/gi;
  let replacements = 0;
  const result = html.replace(pattern, tag => {
    if (attributeValue(tag, asset.attribute) !== asset.path) return tag;
    replacements++;
    const id = attributeValue(tag, 'id');
    const idAttribute = id ? ` id="${id}"` : '';
    if (asset.kind === 'style') {
      if (/<\/style\b/i.test(content) || /@import\b/i.test(content)) {
        throw new Error(`${asset.path} 包含不支持的样式引用或闭合标签。`);
      }
      return `<style${idAttribute} data-source="${asset.path}">\n${content}\n</style>`;
    }
    return `<script${idAttribute} data-source="${asset.path}">\n${content.replace(/<\/script/gi, closing => closing.replace('</', '<\\/'))}\n</script>`;
  });
  if (replacements !== 1) throw new Error(`${asset.path} 必须在 index.html 中引用一次，实际为 ${replacements} 次。`);
  return result;
}

export async function buildReport({ output = resolve(directory, 'report.html') } = {}) {
  const outputPath = resolve(output);
  const sourcePaths = ['index.html', ...assets.map(asset => asset.path)].map(path => resolve(directory, path));
  const protectedPaths = [...sourcePaths, ...['build.mjs', 'build.test.mjs', 'interaction.test.mjs', 'README.md', 'PHOSPHOR-LICENSE.txt'].map(path => resolve(directory, path))];
  if (protectedPaths.includes(outputPath)) throw new Error('导出路径不能覆盖汇报源文件。');

  const contents = await Promise.all(sourcePaths.map(path => readFile(path, 'utf8')));
  let html = contents[0];
  if (!/<html\b[^>]*\bdata-standalone=["']false["']/i.test(html)) {
    throw new Error('index.html 必须声明 data-standalone="false"。');
  }
  for (const [index, asset] of assets.entries()) html = inlineAsset(html, asset, contents[index + 1]);
  html = html.replace(/(<html\b[^>]*\bdata-standalone=)["']false["']/i, '$1"true"');

  // 检查页面标签，避免将脚本字符串中的 HTML 模板误当成资源引用。
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>');
  const styles = assets.flatMap((asset, index) => asset.kind === 'style' ? [contents[index + 1]] : []);
  if (/<link\b[^>]*\brel=["']stylesheet["']/i.test(markup)
      || /<script\b[^>]*\bsrc\s*=/i.test(markup)
      || /<(?:img|iframe|audio|video|source)\b[^>]*\bsrc\s*=\s*["'](?!data:)/i.test(markup)
      || styles.some(style => /url\(\s*["']?(?!data:|#)[^\s"')]/i.test(style))) {
    throw new Error('导出仍包含外部资源；离线汇报必须把所有展示资源放进 HTML。');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
  return outputPath;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--output' && args[1])) {
    throw new Error('用法：node evaluation-report/build.mjs [--output 路径]');
  }
  const output = await buildReport(args.length ? { output: args[1] } : {});
  console.log(`已导出：${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
