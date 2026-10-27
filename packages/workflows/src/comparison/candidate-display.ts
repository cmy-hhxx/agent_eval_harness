/** Expand blind identities in authored prose; source quotations are never rewritten. */
export function display<T>(value: T, names: Record<string, string>, key = "", bareCandidates = false): T {
  if (typeof value === "string") {
    if (key === "quote") return value;
    const protectedNames = Object.values(names).filter(Boolean).sort((a, b) => b.length - a.length)
      .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pattern = bareCandidates
      ? new RegExp([...protectedNames, "(?:A\\s*[/／]\\s*B|[AB])\\s*(?:股|类|组|级|轮|座|型)",
        "【候选([A-Z])】|候选([A-Z])|(?<![A-Za-z0-9_])([AB])(?![A-Za-z0-9_])"].join("|"), "g")
      : /【候选([A-Z])】|候选([A-Z])/g;
    return value.replace(pattern, (marker, bracketed, candidate, bare) =>
      names[bracketed ?? candidate ?? bare] ?? marker) as T;
  }
  if (Array.isArray(value)) return value.map(item => display(item, names, key, bareCandidates)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, display(item, names, field, bareCandidates)])) as T;
  return value;
}

export const displayComparison = <T>(value: T, names: Record<string, string>): T => display(value, names, "", true);
