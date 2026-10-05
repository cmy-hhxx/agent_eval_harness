export type CitationFormat = "footnote" | "trace" | "vis-html";
export interface CitationMarker {
  format: CitationFormat;
  attribute?: "ref" | "anchor";
  reference: string;
  start: number;
  end: number;
}

/** Recognize complete citation control markers, never ordinary brackets or partial tags. */
export function citationMarkers(text: string): CitationMarker[] {
  return [...text.matchAll(/\[\^(\d+)\]|<trace\s+(ref|anchor)\s*=\s*"([A-Za-z0-9]{7})"\s*\/>|<vis-html\s+ref\s*=\s*"([^\s"<>]+)"\s*\/>/gu)]
    .map(match => ({ ...(match[4] !== undefined
      ? { format: "vis-html" as const, reference: match[4] }
      : match[1] === undefined
      ? { format: "trace" as const, attribute: match[2] as "ref" | "anchor", reference: match[3] }
      : { format: "footnote" as const, reference: match[1] }),
      start: match.index, end: match.index + match[0].length }));
}

/** A semantic view only: retain UTF-16 offsets and line breaks of the quoted source. */
export function maskCitationMarkup(text: string): string {
  let result = "", from = 0;
  for (const marker of citationMarkers(text)) {
    result += text.slice(from, marker.start) + text.slice(marker.start, marker.end).replace(/[^\r\n]/gu, " ");
    from = marker.end;
  }
  return result + text.slice(from);
}
