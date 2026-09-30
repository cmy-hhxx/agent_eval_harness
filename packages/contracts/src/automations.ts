/** Remote input catalog. Counts are observations, not immutable snapshot identifiers. */
export const REMOTE_MODELS = ["a_fast", "b_fast", "a_expert", "b_expert"] as const;
export type RemoteModel = typeof REMOTE_MODELS[number];
export interface RemoteDay {
  date: string;
  rows: Record<RemoteModel, number>;
}
export interface InputDownload {
  name: string;
  rows: number;
  size: number;
  chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
