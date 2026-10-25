import {scoreDirectory} from '@eval/prompts';

/** A fixed grader for pipeline tests; actual source findings and uncertainty remain unchanged. */
export function scoreSubmission(input:any,finalAffected=true){
  const ids=(input.evidence_catalog as {evidence_id:string}[]).map(row=>row.evidence_id),proof=ids.slice(0,2);
  const problems=input.accepted_attribution.problems as {attribution:string;evidence_ids:string[]}[];
  const known=problems.some(problem=>problem.attribution==='established'),uncertain=problems.length>0&&!known;
  const final=problems.length>0&&finalAffected;
  const judgment=(bad=false)=>({status:bad?(uncertain?'unverified':'violated'):'met',applicability:'both',
    reason:bad?'按已接受归因记录的缺陷或待核选档。':'按已接受归因确认的交付选档。',evidence_ids:proof});
  return {evaluations:Object.keys(scoreDirectory.units).map((_id,index)=>({...judgment(index===0&&problems.length>0),
    score:index===0&&problems.length>0?(uncertain?null:3):4,score_range:index===0&&uncertain?[0,4]:null})),
    diagnostics:Object.keys(scoreDirectory.diagnostics).map((_id,index)=>judgment(index===0&&problems.length>0)),
    problem_assignments:problems.map(()=>({affected_unit_indices:[1],diagnostic_indices:[1],final_delivery_affected:final})),
    final_answer_score:{status:final?(uncertain?'unverified':'violated'):'met',score:final?(uncertain?null:9):10,
      score_range:final&&uncertain?[0,10]:null,reason:'总分依据源归因的最终交付影响独立选档，过程恢复不自动扣最终分。',evidence_ids:proof},
    explicit_probability:null,probability_evidence_ids:[]};
}
