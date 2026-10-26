const labels={available:'本次可纳入',included:'已完成分析',reserved:'已占用 / 待恢复',unfinished:'评测未完成',superseded:'已被较新归因替代',
  succeeded:'已接受',failed:'失败',pending:'待处理',running:'运行中',blocked:'依赖阻塞',timed_out:'超时',cancelled:'已中断',not_started:'尚未执行',finished:'已结束',interrupted:'待恢复',completed:'已完成',ready:'已预检',starting:'启动中'};
export function mountAnalysis(root,options={}) {
  const $=selector=>root.querySelector(selector), doc=root.ownerDocument || root;
  const getFetch=options.fetch || globalThis.fetch;
  const api=options.apiRoot || '/runtime/api/dashboard';
  const state={runs:[],jobs:[],selected:new Set(),rows:[],page:1,preview:null,revision:0,busy:false,counts:{},total:0};
  function text(tag,value) {const node=doc.createElement(tag);node.textContent=value ?? '';return node;}
  function button(label,action,disabled=false) {const node=text('button',label);node.type='button';node.className='button';node.disabled=disabled;node.onclick=()=>void perform(action);return node;}
  async function request(url,value) {
    const response=await getFetch(api+url,value===undefined ? {cache:'no-store'} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
    const body=await response.json();if(!response.ok) throw new Error(body.error || `HTTP ${response.status}`);return body;
  }
  function controls() {$('#analysis-start').disabled=state.busy || !state.preview;$('#analysis-preview').disabled=state.busy || !state.counts.available;$('#analysis-scope').disabled=state.busy || !state.selected.size;}
  async function perform(action) {if(state.busy)return;state.busy=true;controls();$('#analysis-error').hidden=true;try {await action();}catch(error){$('#analysis-error').textContent=error.message;$('#analysis-error').hidden=false;}finally{state.busy=false;controls();}}
  function invalidate() {state.revision++;state.preview=null;state.rows=[];state.counts={};$('#analysis-coverage').hidden=true;$('#analysis-counts').textContent='';$('#analysis-plan').textContent='';controls();}
  const selectedBatches=()=>[...$('#analysis-batch').selectedOptions].map(option=>option.value).filter(Boolean);
  const filtered=()=>state.runs.filter(run=>run.task.id===$('#analysis-task').value && (!selectedBatches().length || run.batch_ids.some(id=>selectedBatches().includes(id))));
  function renderRuns() {
    $('#analysis-runs').replaceChildren(...filtered().map(run=>{
      const tr=doc.createElement('tr'),cell=doc.createElement('td'),check=doc.createElement('input');check.type='checkbox';check.checked=state.selected.has(run.run_id);check.setAttribute('aria-label',`选择运行 ${run.run_id}`);
      check.onchange=()=>{check.checked?state.selected.add(run.run_id):state.selected.delete(run.run_id);invalidate();};cell.append(check);tr.append(cell,text('td',`${run.run_id}\n${run.batch_ids.join('、')}`),text('td',run.progress && (run.progress.blocked || run.progress.queued || Object.values(run.progress.failures || {}).some(Boolean)) && run.status!=='running' ? '部分完成' : labels[run.status] || run.status),text('td',run.archived_at?new Date(run.archived_at).toLocaleString():'未归档'));
      const actions=doc.createElement('td');actions.append(button('样本与结果',()=>options.onResults?.(run.run_id)),button('产物',()=>artifacts(run.run_id)),button('归档',async()=>{await request(`/batch-runs/${run.run_id}/archive`,{});await loadRuns(false);await artifacts(run.run_id);},['starting','running','ready'].includes(run.status)));tr.append(actions);return tr;
    }));
  }
  function taskChanged() {
    const runs=state.runs.filter(run=>run.task.id===$('#analysis-task').value), batches=[...new Set(runs.flatMap(run=>run.batch_ids))];
    $('#analysis-batch').replaceChildren(new Option('全部批次',''),...batches.map(id=>new Option(id,id)));
    state.selected=new Set(runs[0]?[runs[0].run_id]:[]);invalidate();renderRuns();
  }
  async function loadRuns(initial) {
    const result=await request('/batch-runs');state.runs=result.runs.filter(run=>!['ready','draft','preview_failed'].includes(run.status));
    const task=$('#analysis-task').value, tasks=[...new Map(state.runs.map(run=>[run.task.id,run.task])).values()];
    $('#analysis-task').replaceChildren(...tasks.map(task=>new Option(`${task.name} · ${task.source} · ${task.category==='daily'?'日常':'专项'}`,task.id)));
    if(tasks.some(item=>item.id===task))$('#analysis-task').value=task;
    if(initial || !task)taskChanged();else renderRuns();
  }
  const selection=()=>({task_id:$('#analysis-task').value,batch_ids:selectedBatches(),run_ids:[...state.selected]});
  async function scope(reset=true) {
    if(reset) {state.page=1;state.preview=null;$('#analysis-plan').textContent='';}
    const revision=state.revision, value=await request('/analysis/scope',{...selection(),page:state.page,status:$('#analysis-status').value});if(revision!==state.revision)return;
    state.rows=value.rows;state.counts=value.counts;state.total=value.total;
    $('#analysis-counts').textContent=Object.entries(value.counts).map(([key,n])=>`${labels[key]} ${n}`).join(' · ');$('#analysis-coverage').hidden=false;renderRows();controls();
  }
  function renderRows() {
    const rows=state.rows,pages=Math.max(1,Math.ceil(state.total/40));
    $('#analysis-rows').replaceChildren(...rows.map(row=>{
      const tr=doc.createElement('tr');tr.append(text('td',`${row.case_id}\n${row.model}\n${row.batch_id}`),text('td',`${row.package_name}\n${row.original_file}:${row.original_line}`),text('td',`${labels[row.evaluation_status] || row.evaluation_status}\n${labels[row.status]}`),text('td',`${row.run_id}\n${row.job_id || ''}`));
      const actions=doc.createElement('td');actions.append(button('查看样本',()=>options.onResults?.(row.run_id,row)));if(row.job_id)actions.append(button('分析明细',()=>jobDetail(row.job_id)));tr.append(actions);return tr;
    }));$('#analysis-page').textContent=`${state.page} / ${pages} · ${state.total} 条`;$('#analysis-prev').disabled=state.page<=1;$('#analysis-next').disabled=state.page>=pages;
  }
  function artifactLink(kind,id,file) {const link=text('a',`${file.name} · ${file.bytes} 字节`);link.href=`${api}/${kind}/${encodeURIComponent(id)}/artifacts?file=${encodeURIComponent(file.name)}`;link.setAttribute('download','');const row=doc.createElement('p');row.append(link);return row;}
  async function artifacts(id) {
    const value=await request(`/batch-runs/${id}/artifacts`);$('#analysis-archive').hidden=false;$('#analysis-directory').textContent=value.directory;
    $('#analysis-files').replaceChildren(...value.files.map(file=>artifactLink('batch-runs',id,file)));
  }
  async function loadJobs() {
    state.jobs=(await request('/analysis')).jobs;
    $('#analysis-jobs').replaceChildren(...state.jobs.map(job=>{
      const tr=doc.createElement('tr');tr.append(text('td',`${job.id}\n${state.runs.find(run=>run.task.id===job.scope.task_id)?.task.name || job.scope.task_id}\n${job.scope.run_ids.length} 个运行`),text('td',labels[job.status] || job.status),text('td',`${job.accepted} / ${job.total}`));
      const actions=doc.createElement('td');actions.append(button('明细与错误',()=>jobDetail(job.id)));
      if(job.status==='running')actions.append(button('停止',async()=>{await request(`/analysis/${job.id}/stop`,{});await loadJobs();}));
      if(job.status==='interrupted')actions.append(button('继续未完成',async()=>{await request(`/analysis/${job.id}/resume`,{});await loadJobs();}));tr.append(actions);return tr;
    }));
  }
  async function jobDetail(id) {
    await loadJobs();const job=state.jobs.find(job=>job.id===id);if(!job)throw new Error('分析作业不存在');
    const [sources,files,logs]=await Promise.all([request(`/analysis/${id}/sources`),request(`/analysis/${id}/artifacts`),request(`/analysis/${id}/errors?history=true`)]);
    const box=$('#analysis-job-body');box.replaceChildren(text('p',job.id),text('p',job.output_dir));
    if(job.error)box.append(text('p',job.error));
    for(const pause of job.paused_stages)box.append(button(`${pause.stage} 修复后解除暂停并续跑`,async()=>{await request(`/analysis/${id}/resume`,{resume_stages:[pause.stage]});await jobDetail(id);}));
    for(const error of job.errors)box.append(text('p',`${error.model} · ${error.stage} · ${error.task_id} · ${labels[error.status] || error.status} · 尝试 ${error.attempts}\n${error.reason || ''}\n${error.errors.map(item=>`${item.path || ''} ${item.code || ''} ${item.message || ''}`).join('\n')}`));
    for(const task of logs.tasks) {if(task.location_error)box.append(text('p',`来源定位失败（仅显示模型范围）：${task.location_error}`));
      for(const location of task.locations)box.append(text('p',`${task.stage} · ${task.task_id} · ${location.model} · ${location.case_id} · ${location.input_file}:${location.input_line}`));}
    box.append(text('h4',`错误历史 ${logs.total}`));
    const history=doc.createElement('div');box.append(history);
    async function historyPage(page) { const value=page===1?logs:await request(`/analysis/${id}/errors?history=true&page=${page}`);history.replaceChildren(...value.records.map(item=>text('pre',JSON.stringify(item.record,null,2))));
      if(page>1)history.append(button('上一页日志',()=>historyPage(page-1)));if(page*value.page_size<value.total)history.append(button('下一页日志',()=>historyPage(page+1))); }
    await historyPage(1);
    box.append(text('h4',`本次归因 ${sources.selected_count} · 待观察召回 ${sources.recalled_count}`));
    const sourceList=doc.createElement('div');box.append(sourceList);
    async function sourcePage(page) {const value=page===1?sources:await request(`/analysis/${id}/sources?page=${page}`);sourceList.replaceChildren();
      for(const item of value.sources) {const source=item.source,row=text('p',`${item.kind==='recalled'?'待观察召回':'本次选择'} · ${source.model} · ${source.batch_id} · ${source.case_id} · ${source.run_id} · ${source.task_id} `);row.append(button('查看归因',()=>options.onResults?.(source.run_id,source)));sourceList.append(row);}
      if(page>1)sourceList.append(button('上一页来源',()=>sourcePage(page-1)));if(page*value.page_size<value.total)sourceList.append(button('下一页来源',()=>sourcePage(page+1))); }
    await sourcePage(1);
    for(const file of files)box.append(artifactLink('analysis',id,file));$('#analysis-job-detail').hidden=false;
  }
  $('#analysis-task').onchange=taskChanged;
  $('#analysis-batch').onchange=()=>{state.selected=new Set(filtered()[0]?[filtered()[0].run_id]:[]);invalidate();renderRuns();};
  $('#analysis-refresh').onclick=()=>void perform(async()=>{state.preview=null;await loadRuns(false);await loadJobs();if(state.rows.length)await scope(false);});
  $('#analysis-scope').onclick=()=>void perform(scope);
  $('#analysis-preview').onclick=()=>void perform(async()=>{const revision=state.revision;const preview=await request('/analysis/preview',selection());if(revision!==state.revision)return;state.preview=preview;$('#analysis-plan').textContent=`归因 ${preview.summary.attribution_answers} · 聚类任务 ${preview.summary.clustering_tasks} · 待观察召回 ${preview.summary.recalled_problems} · ${preview.output_dir}`;});
  $('#analysis-start').onclick=()=>void perform(async()=>{const preview=state.preview;state.preview=null;await request(`/analysis/${preview.job_id}/start`,{});await scope();await loadJobs();});
  $('#analysis-status').onchange=()=>{state.page=1;void perform(()=>scope(false));};
  $('#analysis-prev').onclick=()=>{if(state.busy)return;state.page--;void perform(()=>scope(false));};$('#analysis-next').onclick=()=>{if(state.busy)return;state.page++;void perform(()=>scope(false));};
  const ready=perform(async()=>{await loadRuns(true);await loadJobs();});
  const timer=setInterval(()=>{if(!state.busy)void perform(async()=>{const before=JSON.stringify(state.jobs.map(job=>[job.id,job.status,job.accepted]));await loadJobs();if(state.rows.length && before!==JSON.stringify(state.jobs.map(job=>[job.id,job.status,job.accepted])))await scope(false);});},5000);
  return {ready,state,async selectRun(id){await ready;await perform(async()=>{await loadRuns(false);const run=state.runs.find(run=>run.run_id===id);if(!run)throw new Error('运行尚未开始');$('#analysis-task').value=run.task.id;taskChanged();state.selected=new Set([id]);renderRuns();await scope();});},destroy(){clearInterval(timer);}};
}
