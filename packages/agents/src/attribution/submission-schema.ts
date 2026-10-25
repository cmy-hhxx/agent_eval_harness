import { ValidationError, type AgentRequest } from '@eval/contracts';
import schema from '../../../../schemas/attribution/submission.schema.json' with {type:'json'};
import {componentCatalogIssues} from './responsibility.js';
import {normDirectoryIssues} from './norm-directory.js';
export function attributionSubmissionSchema(request:AgentRequest){
  const issues=[...componentCatalogIssues(request),...normDirectoryIssues(request)];
  if(issues.length)throw new ValidationError(issues);
  return attributionSubmissionShape(request);
}
export function attributionSubmissionShape(request:AgentRequest){
  const value=structuredClone(schema);
  const count=(request.input.answer as {transitions:unknown[]}).transitions.length;
  for(const field of ['checks','causes'] as const)Object.assign(value.properties.Problem.items.properties[field].items.properties.transition_index,{maximum:count});
  if((request.input.ground_truth as {available:boolean}).available)value.required.push('is_correct','correct_reason');
  else {delete (value.properties as Record<string,unknown>).is_correct;delete (value.properties as Record<string,unknown>).correct_reason;}
  return value;
}
