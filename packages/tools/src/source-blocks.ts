/** Test a complete original block at the boundaries used to join selected source blocks. */
export function hasSourceTextBlock(text: string, block: string): boolean {
  return !!block && (text === block || text.startsWith(block + "\n\n") ||
    text.endsWith("\n\n" + block) || text.includes("\n\n" + block + "\n\n"));
}

/** Preserve original normative sections so a catalogue cannot select a heading without its conditions. */
export function sourceTextBlocks(text: string): { quote: string; start: number; end: number }[] {
  const blocks: { quote: string; start: number; end: number }[] = [];
  const add = (start: number, end: number) => {
    const original = text.slice(start, end), quote = original.trim();
    if (!quote) return;
    const offset = original.indexOf(quote);
    blocks.push({ quote, start: start + offset, end: start + offset + quote.length });
  };
  const addParagraphs = (start: number, end: number) => {
    const original = text.slice(start, end);
    let cursor = start;
    for (const separator of original.matchAll(/\n[\t ]*\n+/gu)) {
      const boundary = start + separator.index;
      add(cursor, boundary);
      cursor = boundary + separator[0].length;
    }
    add(cursor, end);
  };
  let offset = 0, section: { start: number; level: number } | undefined;
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.split(/(?<=\n)/u)) {
    const trimmed = line.replace(/\r?\n$/u, "");
    const fenced = trimmed.match(/^[\t ]{0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence) {
      if (fenced && fenced[1]![0] === fence.marker && fenced[1]!.length >= fence.length && !fenced[2]!.trim()) fence = undefined;
    } else if (fenced) {
      fence = { marker: fenced[1]![0]!, length: fenced[1]!.length };
    } else {
      const heading = trimmed.match(/^[\t ]{0,3}(#{1,6})[\t ]+\S.*$/u);
      if (heading && (!section || heading[1]!.length <= section.level)) {
        if (section) add(section.start, offset);
        else addParagraphs(0, offset);
        section = { start: offset, level: heading[1]!.length };
      }
    }
    offset += line.length;
  }
  if (section) add(section.start, text.length);
  else addParagraphs(0, text.length);
  return blocks;
}

/** Complete joined or independent leaf blocks retain only real text-leaf evidence. */
export function sourceContentBlocks(content: unknown, path: string): {
  quote: string; origins: { path: string; quote: string; start: number; end: number }[];
}[] {
  const textParts = (value: unknown, location: string): { text: string; path: string }[] => {
    if (typeof value === "string") return [{ text: value, path: location }];
    if (Array.isArray(value)) return value.flatMap((part, index) => textParts(part, `${location}/${index}`));
    if (value && typeof value === "object" && "text" in value && typeof value.text === "string")
      return [{ text: value.text, path: `${location}/text` }];
    return [];
  };
  let offset = 0;
  const leaves = textParts(content, path).map(leaf => {
    const located = { ...leaf, start: offset, end: offset + leaf.text.length, blocks: sourceTextBlocks(leaf.text) };
    offset = located.end + 1;
    return located;
  });
  const text = leaves.map(leaf => leaf.text).join("\n"), joined = sourceTextBlocks(text);
  const headed = joined.filter(block => {
    const lineStart = text.lastIndexOf("\n", block.start - 1) + 1;
    return /^[\t ]{0,3}#{1,6}[\t ]+\S/u.test(text.slice(lineStart, block.end));
  });
  const blocks = joined.map(block => ({ quote: block.quote,
    origins: leaves.flatMap(leaf => leaf.blocks.filter(original => leaf.start + original.start < block.end &&
      block.start < leaf.start + original.end).map(original => ({ ...original, path: leaf.path }))),
  }));
  for (const leaf of leaves) for (const block of leaf.blocks) {
    // A body or heading split across parts is never an independent rule.
    if (headed.some(section => leaf.start + block.start < section.end && section.start < leaf.start + block.end)) continue;
    blocks.push({ quote: block.quote, origins: [{ ...block, path: leaf.path }] });
  }
  return blocks.filter((block, index) => blocks.findIndex(other => other.quote === block.quote &&
    other.origins.length === block.origins.length && other.origins.every((origin, position) => {
      const actual = block.origins[position]!;
      return origin.path === actual.path && origin.start === actual.start && origin.end === actual.end;
    })) === index);
}
