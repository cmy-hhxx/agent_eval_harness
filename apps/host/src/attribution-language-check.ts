import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileSourceReader} from '@eval/data';
import {checkDirectAttributionLanguage,type AttributionLanguageField,type AttributionLanguageStatus} from '@eval/agents/attribution';

async function main(){
  const {values}=parseArgs({options:{input:{type:'string'},limit:{type:'string'},help:{type:'boolean'}}});
  if(values.help){console.log('npm run attribution:check-language -- --input /absolute/path/attribution.jsonl [--limit 602]\n只读检查；--limit 限定文件前 N 行，strength 的 null 问题字段记为不适用。');return;}
  if(!values.input)throw Error('--input is required');
  const file=path.resolve(values.input),limit=values.limit===undefined?undefined:Number(values.limit);
  if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1))throw Error('--limit must be a positive integer');
  // A live evaluator atomically replaces this file; reject a raced read instead of mixing snapshots.
  for(let attempt=0;attempt<3;attempt++){
    const revision=await fileSourceReader.revision(file);
    const fields=Object.fromEntries(['summary','text','reason','label','definition'].map(field=>[field,{passed:0,failed:0,not_applicable:0}])) as Record<AttributionLanguageField,Record<AttributionLanguageStatus,number>>;
    const failures:{line:number;trace_id:unknown;task_id:unknown;issues:ReturnType<typeof checkDirectAttributionLanguage>['issues']}[]=[];
    let checked=0;
    try{
      for await(const {line,index}of fileSourceReader.lines(file,revision)){
        if(limit!==undefined&&index>limit)break;
        if(!line.trim())continue;
        let row:unknown;try{row=JSON.parse(line);}catch{throw Error('Invalid JSON at line '+index);}
        const result=checkDirectAttributionLanguage(row);checked++;
        for(const check of result.checks)fields[check.field][check.status]++;
        if(result.issues.length){const record=row&&typeof row==='object'?row as Record<string,unknown>:{};
          failures.push({line:index,trace_id:record.trace_id??null,task_id:record.task_id??null,issues:result.issues});}
      }
      if(await fileSourceReader.revision(file)!==revision){if(attempt<2)continue;throw Error('结果文件正在更新，请重试检查。');}
    }catch(error){if(attempt<2&&await fileSourceReader.revision(file)!==revision)continue;throw error;}
    console.log(JSON.stringify({file,checked_rows:checked,failed_rows:failures.length,fields,failures},null,2));
    process.exitCode=failures.length?2:0;return;
  }
}
await main().catch(error=>{console.error(String(error));process.exitCode=2;});
