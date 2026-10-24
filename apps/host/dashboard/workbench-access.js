export function mountAccess(root, options = {}) {
  const $ = id => root.querySelector('#' + id), win = root.defaultView || root.ownerDocument.defaultView;
  const fetcher = options.fetch || win.fetch.bind(win), dialog = $('access-dialog'), form = $('access-form');
  let authenticated = false, pending, opener, busy = false;
  function status(value) { authenticated = value; $('access-button').textContent = value ? '退出' : '登录'; }
  function finish(value) { const current = pending; pending = undefined; current?.resolve(value); }
  function login(continuing = false) {
    $('access-submit').textContent = continuing ? '登录并继续' : '登录';
    if (pending) return pending.promise;
    opener = root.activeElement; while (opener?.shadowRoot?.activeElement) opener = opener.shadowRoot.activeElement;
    $('access-error').textContent = ''; $('access-error').hidden = true;
    let resolve; const promise = new Promise(done => { resolve = done; }); pending = { promise, resolve };
    dialog.showModal(); $('access-username').focus(); return promise;
  }
  dialog.addEventListener('close', () => { finish(false); $('access-password').value = ''; (opener?.isConnected && !opener.disabled ? opener : $('access-button')).focus(); });
  $('access-cancel').onclick = () => dialog.close();
  $('access-button').onclick = async () => {
    if (!authenticated) { await login(); return; }
    try { const response = await fetcher('/logout', { method:'POST' }); if (!response.ok) throw Error(); status(false); }
    catch { $('access-button').textContent = '退出失败，重试'; }
  };
  form.onsubmit = async event => {
    event.preventDefault(); if (busy) return; busy = true; $('access-submit').disabled = true;
    $('access-error').hidden = true;
    try {
      const body = new URLSearchParams({ username:$('access-username').value, password:$('access-password').value });
      const response = await fetcher('/login', { method:'POST', body }), value = await response.json();
      if (!response.ok) throw Error(value.error || `HTTP ${response.status}`);
      status(true); finish(true); dialog.close();
    } catch (error) { $('access-error').textContent = error.message; $('access-error').hidden = false; }
    finally { busy = false; $('access-submit').disabled = false; }
  };
  async function guarded(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, win.location.href);
    const method = (init?.method || input.method || 'GET').toUpperCase();
    const protectedAction = url.origin === win.location.origin && !['GET','HEAD'].includes(method) &&
      (url.pathname.startsWith('/runtime/api/') || url.pathname.startsWith('/data/workbench/'));
    const retry = protectedAction ? new win.Request(input instanceof win.Request ? input.clone() : url.href, init) : undefined;
    const response = await fetcher(input, init);
    if (!protectedAction || response.status !== 401 || (await response.clone().json().catch(() => ({}))).code !== 'login_required') return response;
    status(false); const signal = retry.signal;
    if (signal.aborted) throw new win.DOMException('操作已取消', 'AbortError');
    let abort;
    const cancelled = new Promise((_, reject) => { abort = () => reject(new win.DOMException('操作已取消', 'AbortError')); signal.addEventListener('abort', abort, { once:true }); });
    try { if (!await Promise.race([login(true), cancelled])) throw new win.DOMException('已取消操作', 'AbortError'); }
    finally { signal.removeEventListener('abort', abort); }
    if (signal.aborted) throw new win.DOMException('操作已取消', 'AbortError');
    return fetcher(retry);
  }
  const ready = fetcher('/session', { cache:'no-store' }).then(async response => { if (response.ok) status((await response.json()).authenticated); }).catch(() => {});
  return { ready, fetch:guarded };
}
