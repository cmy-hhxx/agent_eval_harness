import { agentPrompt, scoreDirectory } from "@eval/prompts";
import type { AgentDefinition, AgentProfile, ReviewCase } from "@eval/contracts";
import resultSchema from "../../../../schemas/score/result.schema.json" with {type:"json"};
import { validateScore } from "./validate.js";
export * from "./types.js";
export { validateScore } from "./validate.js";
const prompt=agentPrompt("score",["review_material","review_calculate","review_external","read_artifact"]);
export const scoreProfile:AgentProfile={id:"default",...prompt,requestSchema:{type:"object",required:["case_id","task_question","availability"],additionalProperties:true},submissionSchema:resultSchema,resultSchema,
  toolNames:["review_material","review_calculate","review_external","read_artifact"],
  renderPrompt:(input,policy,failure)=>prompt.renderPrompt({...input,score_directory:scoreDirectory},policy,failure),
  modelSubmissionSchema(request){const schema=structuredClone(resultSchema);const id=(request.sources.case.value as unknown as ReviewCase).case_id;
    Object.assign(schema.$defs.normal.properties.case_id,{const:id});Object.assign(schema.$defs.exception.properties.case_id,{const:id});return schema;},
  validate:validateScore,
};
export const scoreAgent:AgentDefinition={id:"score",profiles:{default:scoreProfile}};
