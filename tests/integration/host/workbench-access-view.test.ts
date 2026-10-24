import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { ROOT } from '../../fixtures/services.js';

async function fixture() {
  const directory = path.join(ROOT, 'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory, 'workbench.html'), 'utf8'), { url:'http://fixture/', runScripts:'outside-only' });
  dom.window.Request = Request; dom.window.DOMException = DOMException;
  dom.window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const compiled = await build({ entryPoints:[path.join(directory, 'workbench-access.js')], bundle:true, write:false, format:'iife', globalName:'Access', platform:'browser' });
  dom.window.eval(compiled.outputFiles[0].text + '\nglobalThis.Access=Access;');
  let authenticated = false, calls = 0, wrong = false; const bodies:string[] = [];
  const fetcher = async (input:string|Request, init?:RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/session')) return Response.json({ authenticated });
    if (url.endsWith('/login')) { if (wrong) return Response.json({ error:'用户名或密码错误' }, { status:401 }); authenticated = true; return Response.json({ authenticated }); }
    if (url.endsWith('/logout')) { authenticated = false; return Response.json({ authenticated }); }
    calls++; bodies.push(typeof input === 'string' ? String(init?.body || '') : await input.text());
    return authenticated ? Response.json({ accepted:true }) : Response.json({ code:'login_required', error:'请先登录后执行操作' }, { status:401 });
  };
  const access = dom.window.Access.mountAccess(dom.window.document, { fetch:fetcher }); await access.ready;
  const el = (id:string) => dom.window.document.getElementById(id)! as any;
  const settle = async (check:()=>boolean) => { for (let i=0;i<100;i++) { if(check())return;await new Promise(setImmediate); } assert.fail('access did not settle'); };
  const submit = () => { el('access-username').value='operator'; el('access-password').value='fixture-password'; el('access-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); };
  return { dom, access, el, submit, settle, calls:()=>calls, bodies, wrong:(value:boolean)=>{wrong=value;} };
}

test('login is shown only for execution and resumes the exact original request without leaving the workspace', async () => {
  const f = await fixture();
  try {
    f.el('more-section').value='problems';
    const request = f.access.fetch('/runtime/api/daily/wencai/control', { method:'POST', headers:{'content-type':'application/json'}, body:'{"action":"run"}' });
    await f.settle(()=>f.el('access-dialog').open); assert.equal(f.calls(),1); assert.equal(f.el('access-submit').textContent,'登录并继续');
    f.wrong(true);f.submit();await f.settle(()=>!f.el('access-error').hidden);assert.match(f.el('access-error').textContent,/密码错误/);assert.equal(f.calls(),1);
    f.wrong(false);f.submit();assert.equal((await request).status,200);assert.deepEqual(f.bodies,['{"action":"run"}','{"action":"run"}']);
    assert.equal(f.el('more-section').value,'problems');assert.equal(f.el('access-dialog').open,false);assert.equal(f.el('access-password').value,'');assert.equal(f.el('access-button').textContent,'退出');
    f.el('access-button').click();await f.settle(()=>f.el('access-button').textContent==='登录');
  } finally { f.dom.window.close(); }
});

test('cancelled or aborted execution is never replayed after login', async () => {
  const f = await fixture();
  try {
    let request = f.access.fetch('/data/workbench/clean',{method:'POST',body:'{}'});const cancelled=assert.rejects(request,{name:'AbortError'});await f.settle(()=>f.el('access-dialog').open);f.el('access-cancel').click();await cancelled;assert.equal(f.calls(),1);
    const controller = new AbortController();request=f.access.fetch('/runtime/api/daily/aime/control',{method:'POST',body:'{}',signal:controller.signal});
    const rejected = assert.rejects(request, { name:'AbortError' });await f.settle(()=>f.el('access-dialog').open);controller.abort();await rejected;f.submit();await f.settle(()=>!f.el('access-dialog').open);assert.equal(f.calls(),2);
  } finally { f.dom.window.close(); }
});
