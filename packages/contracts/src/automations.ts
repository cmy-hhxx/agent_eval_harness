/** Remote input catalog. Counts are observations, not immutable snapshot identifiers. */
/** The catalog/file is temporarily unavailable while the source prepares its data. */
export class RemoteInputNotReadyError extends Error {}
/** A transient transfer failure; the entire file can be requested again. */
export class RetryableInputDownloadError extends Error {}
export interface RemoteDay {
  date: string;
  rows: Record<string, number>;
}
export interface InputDownload {
  name: string;
  /** Catalog observation before this response; a complete newer file may contain more rows. */
  rows: number;
  size: number;
  chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
