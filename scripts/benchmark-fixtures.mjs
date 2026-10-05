/** Capture actual submitted JSON; a path or a malformed SDK call cannot reconstruct a draft. */
export async function* rejectedEvaluationDrafts(events) {
  let draft;
  for await (const event of events) {
    const data = event.data ?? {};
    if (event.type === "tool_start" && ["submit_evaluation", "submit_evaluation_file"].includes(data.name))
      draft = undefined;
    if (event.type === "submission" && data.content_loaded === true && data.inspection !== true)
      draft = data.evaluation;
    if (event.type !== "tool_end" || !["submit_evaluation", "submit_evaluation_file"].includes(data.name)) continue;
    if (data.result?.isError && draft !== undefined) yield { event, draft };
    draft = undefined;
  }
}
