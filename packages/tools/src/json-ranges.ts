/** Exact JSON pointer spans, including a property's key, without reserializing the source. */
export function jsonRanges(text: string) {
  const ranges = new Map<string, { start: number; end: number; valueStart: number }>();
  // Validate before indexing; the scanner then only has to preserve original UTF-16 offsets.
  JSON.parse(text);
  let cursor = 0;
  const space = () => { while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
  const string = () => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor++] === "\\") cursor++;
      else if (text[cursor - 1] === '"') break;
    }
    return JSON.parse(text.slice(start, cursor)) as string;
  };
  const value = (path: string, start: number) => {
    space();
    const valueStart = cursor, char = text[cursor];
    if (char === "{" || char === "[") {
      const object = char === "{", close = object ? "}" : "]";
      cursor++;
      let index = 0;
      while (true) {
        const whitespace = cursor;
        space();
        if (text[cursor] === close) break;
        const keyStart = text.lastIndexOf("\n", cursor - 1) + 1;
        const entryStart = Math.max(whitespace, keyStart);
        const key = object ? string() : String(index++);
        if (object) { space(); cursor++; }
        value(path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"), entryStart);
        space();
        if (text[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (char === '"') string();
    else while (cursor < text.length && !/[\s,}\]]/u.test(text[cursor]!)) cursor++;
    ranges.set(path, { start, end: cursor, valueStart });
  };
  value("", 0);
  return ranges;
}
