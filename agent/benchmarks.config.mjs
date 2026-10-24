import { mergeConfig } from 'vite';
import base from './vitest.config.mjs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
function replaceSnippet(code,before,after,count=1){
 const matches=code.split(before).length-1;
 if(matches!==count)throw new Error(`Benchmark adapter expected ${count} occurrence(s), got ${matches}: ${before}`);
 return code.replaceAll(before,after);
}
export default mergeConfig(base,{
 plugins:[{name:'benchmark-environment',enforce:'pre',transform(code,id){
  if(id.endsWith('/long-session.bench.ts')){
    code=replaceSnippet(code,"'../../apps/web/tests/scaffold.ts'",JSON.stringify(path.join(root,'agent/benchmarks/scaffold.mjs')));
    code=replaceSnippet(code,"'../../apps/web/tests/support.ts'",JSON.stringify(path.join(root,'agent/benchmarks/scaffold.mjs')));
    // Eris may expand its current workspace while creating the initial draft.
    // Inspect and expand in one DOM task so preparation cannot collapse it.
    code=replaceSnippet(code,"await page.getByRole('treeitem').first().click()",`await page.locator('[data-row-key="workspace:analysis"]').evaluate(row => { if (row.getAttribute('aria-expanded') === 'false') row.click() })`);
    // This product opens a draft in the workspace. Select the seeded history
    // by its fixture title instead of racing its position against that draft.
    code=replaceSnippet(code,"const result = page.getByRole('treeitem').nth(1)", "const result = page.getByRole('treeitem').filter({ hasText: 'SYNTHETIC_BROWSER_HISTORY' })");
    code=replaceSnippet(code,'} catch (error) { failures.push(error) }', '} catch (error) { console.error(error); failures.push(error) }',3);
    return replaceSnippet(code,'chromium.launch({ headless: true })',`chromium.launch({ headless: true, executablePath: ${JSON.stringify(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')} })`,8);
  }
  if(id.endsWith('/reconnect.bench.client.ts'))return replaceSnippet(code,"join(import.meta.dirname, '../.dsh-build/active-stream-reconnect/reconnect.worker.js')",JSON.stringify(path.join(root,'dist/agent/benchmarks/.dsh-build/active-stream-reconnect/reconnect.worker.js')));
 }}],
 test:{include:['benchmarks/active-stream-reconnect/reconnect.bench.client.ts','benchmarks/long-session-browser/long-session.bench.ts'],testTimeout:120000,fileParallelism:false},
});
