import {parseArgs} from 'node:util';
import {fileSourceReader,writeJson} from '@eval/data';
import {adapt} from '@eval/workflows/comparison';
import {errorText} from '@eval/contracts';

/** Data-service cleaning calls the actual current TypeScript adapter before publication. */
const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'}}});
if(!values.input||!values.output)throw Error('--input and --output are required');
const invalid:{key:string[];error:string}[]=[];
let valid=0;
for await(const {line,index} of fileSourceReader.lines(values.input)){
  if(!line.trim())continue;
  const row=JSON.parse(line),key=[row.version,row.batch_id,row.case_id];
  try{
    if(!['aime_fast','aime_expert'].includes(row.version))throw Error('未知AIME模型模式');
    const candidate=adapt(row,{id:row.version,name:row.version,adapter:'a',sources:[]},values.input,index);
    if(!candidate.trace_id||candidate.trace_id!==row.trace_id)throw Error('trace_id必须与实际回答trace一致');
    valid++;
  }catch(error){invalid.push({key,error:errorText(error)});}
}
await writeJson(values.output,{valid,invalid});
