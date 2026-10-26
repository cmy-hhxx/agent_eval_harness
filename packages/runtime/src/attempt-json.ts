import { ValidationError, errorText } from "@eval/contracts";

export interface JsonSubmissionResult {
  value: unknown;
  repairs: number;
}

/**
 * Decode the model-facing JSON submission envelope and apply only the existing
 * deterministic repairs. The caller still validates the decoded value against
 * the task schema.
 */
export function decodeJsonSubmission(
  envelope: unknown,
  validateEnvelope: (value: unknown) => boolean,
): JsonSubmissionResult {
  if (!validateEnvelope(envelope)) throw new Error("参数只包含 json 字符串");
  const text = (envelope as { json: string }).json;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const position = Number(/position (\d+)/u.exec(errorText(error))?.[1] ?? 0);
    // Only discard surplus closing punctuation after an already complete, parseable value.
    // Any second value, field, prose, or incomplete structure still requires model repair.
    if (position > 0 && [...text.slice(position)].every(char => "}] \t\r\n".includes(char))) {
      try { value = JSON.parse(text.slice(0, position)); } catch { /**/ }
    }
    const controlEscaped = escapeControlCharacters(text);
    if (value === undefined && controlEscaped !== undefined) {
      try { value = JSON.parse(controlEscaped); } catch { /**/ }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const quoting = escapeStringQuotes(controlEscaped ?? text);
      if (quoting) {
        try { value = JSON.parse(quoting.text); } catch { /**/ }
      }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidationError([{
        category: "structure",
        code: "submission_json_invalid",
        path: "/json",
        message: "JSON 正文语法错误，无法安全修复：" + errorText(error) +
          "。正文里的英文双引号必须转义（前置反斜杠）或改用中文引号“”；只修正报错位置附近，保持其他内容不变。",
        actual: { position, excerpt: text.slice(Math.max(0, position - 100), position + 100) },
      }]);
    }
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("评审正文必须为对象");
    return { value, repairs: 1 };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("评审正文必须为对象");
  return { value, repairs: 0 };
}

// A raw control character inside a JSON string has exactly one intended value; escaping it
// preserves the model's text while structural JSON errors still fail without repair.
function escapeControlCharacters(text: string): string | undefined {
  let repaired = "", inString = false, escaped = false, changed = false;
  for (const char of text) {
    if (inString) {
      if (escaped) { repaired += char; escaped = false; continue; }
      if (char === "\\") { repaired += char; escaped = true; continue; }
      if (char === '"') { inString = false; repaired += char; continue; }
      if (char.codePointAt(0)! < 0x20) {
        repaired += JSON.stringify(char).slice(1, -1);
        changed = true;
        continue;
      }
    } else if (char === '"') inString = true;
    repaired += char;
  }
  return changed && !inString ? repaired : undefined;
}

// An unescaped ASCII quote inside a JSON string is either the string terminator (followed by a
// structural character) or literal prose punctuation; the two readings differ by one backslash,
// so the repair is deterministic. Structural mistakes still fail, and the repaired object must
// pass every later Schema and business check before it becomes a result.
function escapeStringQuotes(text: string): { text: string; escaped: number } | undefined {
  let repaired = "", inString = false, escapedChar = false, escaped = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (!inString) {
      if (char === '"') inString = true;
      repaired += char;
      continue;
    }
    if (escapedChar) { repaired += char; escapedChar = false; continue; }
    if (char === "\\") { repaired += char; escapedChar = true; continue; }
    if (char !== '"') { repaired += char; continue; }
    let next = index + 1;
    while (next < text.length && /\s/u.test(text[next])) next++;
    if (next >= text.length || ",:}]".includes(text[next])) {
      inString = false;
      repaired += char;
    } else {
      repaired += '\\"';
      escaped++;
    }
  }
  return escaped && !inString ? { text: repaired, escaped } : undefined;
}
