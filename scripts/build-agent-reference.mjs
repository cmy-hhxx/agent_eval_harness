// Rebuild the recorded upstream baseline for screenshot parity. The application
// binding and Eris brand slots are shared; local UI patches are reversed except the removal of official artwork.
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { build } from 'vite';
import { root } from './lib.mjs';
const source=path.join(root,'vendor/deepseek'),reference=path.join(root,'.artifacts/agent-reference/source');
await rm(reference,{recursive:true,force:true});
await mkdir(reference,{recursive:true});
for(const entry of ['packages','vendor'])await cp(path.join(source,entry),path.join(reference,entry),{recursive:true});
execFileSync('git',['apply','--reverse','--exclude=**/ui-primitives/**','--exclude=**/ui-sidebar/**',
  ...['chat/RunningStatus.tsx','chat/ChatView.tsx','chat/ChatView.module.css','apply.ts','contract/slots.ts']
    .map(file=>`--exclude=**/ui-chat/src/client/${file}`),
  `--directory=${path.relative(root,reference)}`,path.join(source,'local.patch')],{cwd:root});
const {aliases}=JSON.parse(await readFile(path.join(source,'sources.json'),'utf8'));
await build({configFile:path.join(root,'agent/vite.config.mjs'),resolve:{alias:Object.entries(aliases).sort(([a],[b])=>b.length-a.length).map(([find,file])=>({find,replacement:path.join(reference,file)}))},build:{outDir:path.join(root,'dist/agent/reference-web')}});
