import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './lib.mjs';
const vendor=path.join(root,'vendor/deepseek');
const {aliases}=JSON.parse(await readFile(path.join(vendor,'sources.json'),'utf8'));
const streamSpecifier='@deepseek-ai/dsh-llm/assistant-stream';
const streamModule='./lib/assistant-stream.js';
function replaceSnippet(code,before,after){
 const matches=code.split(before).length-1;
 if(matches!==1)throw new Error(`Benchmark build expected one occurrence, got ${matches}: ${before}`);
 return code.replace(before,after);
}
function vendoredBenchmark(worker=false){return {name:'vendored-benchmark',setup(build){
 build.onResolve({filter:/^@deepseek-ai\//},({path:specifier})=>{
  if(worker&&specifier===streamSpecifier)return {path:streamModule,external:true};
  const file=aliases[specifier];
  if(!file)throw new Error(`Missing vendored benchmark export: ${specifier}`);
  return {path:path.join(vendor,file)};
 });
 if(worker)build.onLoad({filter:/reconnect.worker.client.ts$/},async({path:file})=>({loader:'ts',contents:replaceSnippet(await readFile(file,'utf8'),`import.meta.resolve('${streamSpecifier}')`,`import.meta.resolve('${streamModule}')`)}));
 build.onLoad({filter:/llm\/llm\/src\/attribution.ts$/},async({path:file})=>({loader:'ts',contents:replaceSnippet(await readFile(file,'utf8'),"const { version } = createRequire(import.meta.url)('../package.json')",`const {version}=${JSON.stringify(JSON.parse(await readFile(path.join(path.dirname(file),'../package.json'),'utf8')))}`)}));
}};}
const options={bundle:true,platform:'node',format:'esm',target:'node24',packages:'external'};
// Keep the upstream plain-Node and compiled-package guards intact: the worker
// imports the same vendored production accumulator from a standalone JS module.
await build({...options,entryPoints:[path.join(vendor,aliases[streamSpecifier])],outfile:path.join(root,'dist/agent/benchmarks/.dsh-build/active-stream-reconnect/lib/assistant-stream.js'),plugins:[vendoredBenchmark()]});
for(const [entry,outfile] of [
 ['active-stream-reconnect/reconnect.worker.client.ts','benchmarks/.dsh-build/active-stream-reconnect/reconnect.worker.js'],
 ['long-session-browser/synthetic-history.ts','benchmarks/synthetic-history.js']
])await build({...options,entryPoints:[path.join(vendor,'benchmarks',entry)],outfile:path.join(root,'dist/agent',outfile),plugins:[vendoredBenchmark(entry.endsWith('reconnect.worker.client.ts'))]});
