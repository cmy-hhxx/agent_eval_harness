import { mergeConfig } from 'vite';
import base from './vitest.config.mjs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
export default mergeConfig(base,{
 plugins:[{name:'benchmark-environment',enforce:'pre',transform(code,id){
  if(id.endsWith('/long-session.bench.ts'))return code
    .replace("'../../apps/web/tests/scaffold.ts'",JSON.stringify(path.join(root,'agent/benchmarks/scaffold.mjs')))
    .replace("'../../apps/web/tests/support.ts'",JSON.stringify(path.join(root,'agent/benchmarks/scaffold.mjs')))
    // This product opens a draft in the workspace. Select the seeded history
    // by its fixture title instead of racing its position against that draft.
    .replace("const result = page.getByRole('treeitem').nth(1)", "const result = page.getByRole('treeitem').filter({ hasText: 'SYNTHETIC_BROWSER_HISTORY' })")
    .replaceAll('} catch (error) { failures.push(error) }', '} catch (error) { console.error(error); failures.push(error) }')
    .replaceAll('chromium.launch({ headless: true })',`chromium.launch({ headless: true, executablePath: ${JSON.stringify(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')} })`);
  if(id.endsWith('/reconnect.bench.client.ts'))return code.replace("join(import.meta.dirname, '../.dsh-build/active-stream-reconnect/reconnect.worker.js')",JSON.stringify(path.join(root,'dist/agent/benchmarks/.dsh-build/active-stream-reconnect/reconnect.worker.js')));
 }}],
 test:{include:['benchmarks/active-stream-reconnect/reconnect.bench.client.ts','benchmarks/long-session-browser/long-session.bench.ts'],testTimeout:120000,fileParallelism:false},
});
