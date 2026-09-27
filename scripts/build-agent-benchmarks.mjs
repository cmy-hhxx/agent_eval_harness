import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './lib.mjs';
const vendor=path.join(root,'vendor/deepseek');
const {aliases}=JSON.parse(await readFile(path.join(vendor,'sources.json'),'utf8'));
for(const [entry,outfile] of [
 ['active-stream-reconnect/reconnect.worker.client.ts','benchmarks/.dsh-build/active-stream-reconnect/reconnect.worker.js'],
 ['long-session-browser/synthetic-history.ts','benchmarks/synthetic-history.js']
])await build({entryPoints:[path.join(vendor,'benchmarks',entry)],outfile:path.join(root,'dist/agent',outfile),bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',plugins:[{name:'vendored-benchmark',setup(build){
 build.onResolve({filter:/^@deepseek-ai\//},({path:specifier})=>({path:path.join(vendor,aliases[specifier])}));
 build.onLoad({filter:/reconnect.worker.client.ts$/},async({path:file})=>({loader:'ts',contents:(await readFile(file,'utf8')).replace(/assertBuiltBenchmarkRuntime\(import\.meta\.url, \{[\s\S]*?\}\)/,"if (!import.meta.url.includes('/benchmarks/.dsh-build/') || !import.meta.url.endsWith('.js')) throw new Error('Benchmark must use the bundled production source')")}));
 build.onLoad({filter:/llm\/llm\/src\/attribution.ts$/},async({path:file})=>({loader:'ts',contents:(await readFile(file,'utf8')).replace(/const \{ version \} = createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\)/,`const {version}=${JSON.stringify(JSON.parse(await readFile(path.join(path.dirname(file),'../package.json'),'utf8')))}`)}));
}}]});
