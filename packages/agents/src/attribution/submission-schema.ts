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
  if((request.input.ground_truth as {available:boolean}).available)value.required.push('is_correct','correct_reason');
  else {delete (value.properties as Record<string,unknown>).is_correct;delete (value.properties as Record<string,unknown>).correct_reason;}
  return value;
}
