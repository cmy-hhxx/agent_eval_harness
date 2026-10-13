import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = resolve(directory, 'src');
const assetTags = /<link\b[^>]*>|<img\b[^>]*>|<script\b[^>]*>\s*<\/script\s*>/gi;

function attributeValue(tag, attribute) {
  return tag.match(new RegExp(`\\s${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
}

function collectAssets(template) {
  const paths = new Set();
  return [...template.matchAll(assetTags)].flatMap(([tag]) => {
    const kind = /^<link\b/i.test(tag) ? 'style' : /^<img\b/i.test(tag) ? 'image' : 'script';
    if (kind === 'style' && attributeValue(tag, 'rel') !== 'stylesheet') return [];
    const path = attributeValue(tag, kind === 'style' ? 'href' : 'src');
    if (!path) return [];
    const absolute = resolve(sourceDirectory, path);
    const local = relative(sourceDirectory, absolute);
    if (/^[\/\\]|[:?#\\]/.test(path) || local === '..' || local.startsWith(`..${sep}`)) {
      throw new Error(`资源必须位于 src/ 内：${path}`);
    }
    if (paths.has(absolute)) throw new Error(`资源不可重复引用：${path}`);
    paths.add(absolute);
    return [{ tag, kind, absolute, path: `src/${local.split(sep).join('/')}` }];
  });
}

function compactSnapshot(content, path) {
  // 快照只有一个全局变量赋值；解析 JSON，不执行源文件中的代码。
  const match = content.match(/^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*window\.([\w$]+)\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  try {
    if (!match) throw new Error('缺少单一 JSON 对象赋值');
    return `window.${match[1]} = ${JSON.stringify(JSON.parse(match[2])).replace(/</g, '\\u003c')};`;
  } catch (cause) {
    throw new Error(`${path} 不是有效的 JSON 数据快照。`, { cause });
  }
}

function inlineAsset(asset, content) {
  if (asset.kind === 'image') {
    if (!asset.path.endsWith('.png')) throw new Error(`不支持的图片格式：${asset.path}`);
    return asset.tag.replace(/\bsrc\s*=\s*(["']).*?\1/i, `src="data:image/png;base64,${content.toString('base64')}"`);
  }
  const id = attributeValue(asset.tag, 'id');
  const attributes = `${id ? ` id="${id}"` : ''} data-source="${asset.path}"`;
  if (asset.kind === 'style') {
    if (/<\/style\b/i.test(content) || /@import\b/i.test(content)) {
      throw new Error(`${asset.path} 包含不支持的样式引用或闭合标签。`);
    }
    if (/url\(\s*["']?(?!data:|#)[^\s"')]/i.test(content)) throw new Error(`${asset.path} 仍包含外部资源。`);
    return `<style${attributes}>\n${content}\n</style>`;
  }
  if (/\sdata-snapshot(?=\s|>)/i.test(asset.tag)) content = compactSnapshot(content, asset.path);
  return `<script${attributes}>\n${content.replace(/<\/script/gi, closing => closing.replace('</', '<\\/'))}\n</script>`;
}

export async function buildReport({ output = resolve(directory, 'report.html') } = {}) {
  const outputPath = resolve(output);
  const protectedPaths = ['src', 'scripts', 'tests', 'licenses'].map(path => resolve(directory, path));
  if (outputPath === resolve(directory, 'README.md') || protectedPaths.some(path => outputPath === path || outputPath.startsWith(`${path}/`))) throw new Error('导出路径不能覆盖汇报源文件。');

  const template = await readFile(resolve(sourceDirectory, 'template.html'), 'utf8');
  if (!/<html\b[^>]*\bdata-standalone=["']false["']/i.test(template)) {
    throw new Error('src/template.html 必须声明 data-standalone="false"。');
  }
  const assets = collectAssets(template);
  const inlined = new Map(await Promise.all(assets.map(async asset => [asset.tag, inlineAsset(asset, await readFile(asset.absolute, asset.kind === 'image' ? undefined : 'utf8'))])));
  let html = template.replace(assetTags, tag => inlined.get(tag) ?? tag);
  html = html.replace(/(<html\b[^>]*\bdata-standalone=)["']false["']/i, '$1"true"');
  html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n<!-- 构建产物：修改 src/ 后运行 node evaluation-report/scripts/build.mjs；资源与顺序由 src/template.html 统一声明。 -->');

  // 检查页面标签，避免将脚本字符串中的 HTML 模板误当成资源引用。
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, '$1</script>');
  if (/<link\b[^>]*\brel=["']stylesheet["']/i.test(markup)
      || /<script\b[^>]*\bsrc\s*=/i.test(markup)
      || /<(?:img|iframe|audio|video|source)\b[^>]*\bsrc\s*=\s*["'](?!data:)/i.test(markup)) {
    throw new Error('导出仍包含外部资源；离线汇报必须把所有展示资源放进 HTML。');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
  return outputPath;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--output' && args[1])) {
    throw new Error('用法：node evaluation-report/scripts/build.mjs [--output 路径]');
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
