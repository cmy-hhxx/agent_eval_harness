import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {rm,readFile,writeFile} from 'node:fs/promises';
import {writeJson,runLock} from '@eval/data';
import {fixtureConfig} from '../../fixtures/comparison.js';
import {ROOT} from '../../fixtures/services.js';
import {loadAimeWorkbench} from '../../../apps/host/src/aime-workbench.js';

test('AIME Workbench persists independent settings and refuses an existing CLI owner without taking its lock',async t=>{
  const f=await fixtureConfig();t.after(()=>rm(f.directory,{recursive:true,force:true}));
  const overlay=path.join(f.directory,'models.json');await writeJson(overlay,{models:{judge:{model:'fixture',thinking:'low'}}});
  const file=path.join(f.directory,'aime.json'),stateDirectory=path.join(f.directory,'aime-state');
  await writeJson(file,{archiveDirectory:path.join(f.directory,'archives'),inputDirectory:path.join(f.directory,'2_daily_eval_input'),
    outputDirectory:path.join(f.directory,'eval_output/0_daily_eval'),dataStateDirectory:path.join(f.directory,'data-state'),stateDirectory,
    hostConfigs:[path.join(ROOT,'configs/host.json'),path.join(ROOT,'configs/answer-review.json'),overlay],
    settingsFile:path.join(f.directory,'config.ini'),logDirectory:path.join(f.directory,'log'),logLockDirectory:path.join(f.directory,'log-lock'),concurrency:64});
  const aime=await loadAimeWorkbench(file),initial=await aime.snapshot();
  assert.equal(initial.workflow,'answer-review');assert.equal(initial.concurrency,64);assert.deepEqual(Object.keys(initial.settings.bindings),['score','attribution']);
  assert.equal(Object.hasOwn(initial.settings,'rewrite'),false);assert.deepEqual((await aime.runs()).runs,[]);
  await aime.setSettings({engine:'prime',debug:true,execution:{repairAttempts:2,maxTaskAttempts:8,retryDelaySeconds:3},bindings:{score:{thinking:'high'}}});
  await aime.setConcurrency(16);
  const restored=await loadAimeWorkbench(file),snapshot=await restored.snapshot();
  assert.equal(snapshot.settings.engine,'prime');assert.equal(snapshot.settings.debug,true);assert.equal(snapshot.settings.execution.repairAttempts,2);
  assert.equal(snapshot.settings.bindings.score.thinking,'high');assert.equal(snapshot.concurrency,16);
  await assert.rejects(aime.setSettings({bindings:{comparison:{thinking:'high'}}}),/Score与Attribution/);
  const release=await runLock(stateDirectory);
  await assert.rejects(aime.run(new AbortController().signal),/另一个进程.*aime-auto/);
  await release();
  const ini=path.join(f.directory,'config.ini');await writeFile(ini,await readFile(ini,'utf8')+'\nmodels = fixture\n');
  await writeJson(overlay,{models:{judge:{model:'removed-model',thinking:'low'}}});
  assert.equal((await aime.snapshot()).settings.bindings.score.model,'removed-model','a stale model remains visible for repair');
  await assert.rejects(aime.run(new AbortController().signal),/not declared/);
  await aime.setSettings({bindings:{score:{model:'fixture'},attribution:{model:'fixture'}}});
  assert.equal((await aime.snapshot()).settings.bindings.score.model,'fixture');
});
