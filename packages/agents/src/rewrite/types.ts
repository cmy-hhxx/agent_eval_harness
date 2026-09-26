/** One editable text slot. `id` is the workflow-owned address used to merge the rewrite back. */
export interface RewriteItem {
  id: string;
  label: string;
  text: string;
}
export interface RewriteRequest {
  kind: "attribution" | "comparison";
  case: {
    batch_id: string;
    case_id: string;
    question: string;
  };
  items: RewriteItem[];
}
export interface RewriteResult {
  rewrites: {
    id: string;
    text: string;
  }[];
}
/** Slot id to polished text; the only structure the workflow applies back. */
export type Rewrites = Record<string, string>;
export function toRewrites(result: RewriteResult): Rewrites {
  return Object.fromEntries(result.rewrites.map((item) => [item.id, item.text]));
}
