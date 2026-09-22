import fs from "node:fs";
import { createHash } from "node:crypto";

export function textLeaves(value, path = "") {
  if (typeof value === "string") return [{ path, text: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    textLeaves(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
}

function embeddedImages(value, path = "") {
  if (typeof value === "string") {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(value);
    return match ? [{ path, mimeType: match[1], data: match[2] }] : [];
  }
  if (!value || typeof value !== "object") return [];
  if (value.type === "image" && value.data && (value.mimeType || value.mime_type)) {
    return [{ path, mimeType: value.mimeType || value.mime_type, data: value.data }];
  }
  return Object.entries(value).flatMap(([key, child]) => embeddedImages(child, `${path}/${key}`));
}

function render(value) {
  return JSON.stringify(value, (key, child) => {
    if (typeof child === "string" && (child.startsWith("data:image/") || (key === "data" && child.length > 20000))) {
      return "[内嵌图像数据，请使用 view_image；未从原始材料删除]";
    }
    return child;
  }, 2);
}

export function calculate(operation, operands) {
  if (operands.length < 2 || operands.length > 20) throw new Error("需要 2—20 个数值");
  if (operands.some(x => typeof x !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(x))) {
    throw new Error("仅接受十进制数值字符串，不接受表达式或代码");
  }
  const numbers = operands.map(Number);
  if (!numbers.every(Number.isFinite)) throw new Error("数值超出范围");
  const answer = numbers.slice(1).reduce((a, b) => {
    switch (operation) {
      case "add": return a + b;
      case "subtract": return a - b;
      case "multiply": return a * b;
      case "divide": if (b === 0) throw new Error("不能除以零"); return a / b;
      default: throw new Error("不支持的运算");
    }
  }, numbers[0]);
  if (!Number.isFinite(answer)) throw new Error("计算结果溢出");
  return { operation, operands, result: answer.toPrecision(15), precision: "IEEE-754, 15 significant digits" };
}

export function checkEvidence(result, stage, records, viewed) {
  const locations = [];
  for (const [candidate, record] of Object.entries(records)) {
    const evidence = stage === "correctness" ? result.evidence
      : result.evaluations[candidate].findings.flatMap(finding => finding.evidence);
    for (const item of evidence) {
      const message = record.messages[item.message_index];
      if (!message) throw new Error(`${candidate}[${item.message_index}] 消息不存在`);
      let paths;
      if (item.quote.startsWith("[图像观察]")) {
        if (!viewed.has(`${candidate}:${item.message_index}`)) throw new Error("不能引用尚未查看的图像");
        paths = ["image_observation"];
      } else {
        paths = textLeaves(message).filter(leaf => leaf.text.includes(item.quote)).map(leaf => leaf.path);
        if (!paths.length) throw new Error(`${candidate}[${item.message_index}] 引文不匹配原文，请通过 search_trace 找到逐字片段`);
      }
      locations.push({ candidate, ...item, paths });
    }
  }
  return locations;
}

export default function (pi) {
  const task = JSON.parse(fs.readFileSync(process.env.PRIME_EVAL_TASK, "utf8"));
  const records = Object.fromEntries(Object.entries(task.inputs).map(([key, file]) => [key, JSON.parse(fs.readFileSync(file, "utf8"))]));
  const viewed = new Set();
  const calculations = [];
  const bank = new Map(task.evidence_bank.map(entry => [entry.ref, entry]));
  const referenceFor = (candidate, message_index, path, quote) => {
    const ref = `${candidate}-${createHash("sha256").update(JSON.stringify([message_index, path, quote])).digest("hex").slice(0, 16)}`;
    bank.set(ref, { ref, candidate, message_index, path, quote });
    return ref;
  };
  let calls = 0;
  let submissions = 0;
  const candidate = { type: "string", enum: Object.keys(records) };
  const index = { type: "integer", minimum: 0 };
  const properties = (fields, required) => ({ type: "object", properties: fields, required, additionalProperties: false });
  const textResult = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });
  const expandSubmission = params => {
    const result = structuredClone(params);
    const expand = (evidence, candidate) => evidence.map(item => {
      const entry = bank.get(item.ref);
      if (!entry || entry.candidate !== candidate) throw new Error("引用编号不存在或属于另一候选");
      return { message_index: entry.message_index, quote: entry.quote };
    });
    if (task.stage === "correctness") result.evidence = expand(result.evidence, "A");
    else for (const [candidate, review] of Object.entries(result.evaluations)) {
      review.findings = review.findings.map(finding => ({ ...finding, evidence: expand(finding.evidence, candidate) }));
    }
    return result;
  };
  const messageFor = params => {
    const message = records[params.candidate]?.messages[params.message_index];
    if (!message) throw new Error("只能读取本任务候选的有效消息索引");
    return message;
  };
  const register = (name, description, parameters, action) => {
    if (task.stage === "correctness" && name !== "calculate") return;
    pi.registerTool({ name, label: name, description, parameters,
      async execute(_id, params) {
        try {
          if (++calls > task.max_tool_calls) throw new Error("本地读取/计算次数已达上限，请根据已核验材料提交或说明无法判定");
          return await action(params);
        } catch (error) {
          return { content: [{ type: "text", text: error.message }], isError: true };
        }
      },
    });
  };
  register("read_trace", "读取原始消息的分页内容。offset 按字符计；has_more=true 时仍有未展示内容。", properties({
    candidate, message_index: index, offset: index, max_chars: { type: "integer", minimum: 1, maximum: 16000 },
  }, ["candidate", "message_index"]), params => {
    const full = render(messageFor(params));
    const offset = params.offset || 0, length = params.max_chars || 12000;
    const page = full.slice(offset, offset + length);
    const citations = [];
    for (const leaf of textLeaves(messageFor(params))) {
      if (citations.length >= 12 || leaf.text.startsWith("data:image/")) continue;
      for (const text of leaf.text.split("\n")) {
        const quote = text.trim().slice(0, 320);
        if (quote.length < 8 || !page.includes(JSON.stringify(quote).slice(1, -1))) continue;
        citations.push({ ref: referenceFor(params.candidate, params.message_index, leaf.path, quote), quote });
        if (citations.length >= 12) break;
      }
    }
    return textResult({ message_index: params.message_index, offset, total_chars: full.length,
      text: page, citations, next_offset: offset + length, has_more: offset + length < full.length });
  });
  register("search_trace", "在本候选全部原始消息中按原文子串检索，返回可逐字引用的片段和 JSON 路径。", properties({
    candidate, query: { type: "string", minLength: 1, maxLength: 500 },
    message_index: index, offset: index,
  }, ["candidate", "query"]), params => {
    const matches = [];
    const seen = new Set();
    const record = records[params.candidate];
    if (!record) throw new Error("候选不存在");
    record.messages.forEach((message, message_index) => {
      if (params.message_index !== undefined && message_index !== params.message_index) return;
      for (const leaf of textLeaves(message)) {
        if (leaf.text.startsWith("data:image/")) continue;
        const position = leaf.text.indexOf(params.query);
        if (position < 0) continue;
        const text = leaf.text.slice(Math.max(0, position - 160), position + params.query.length + 480);
        const key = `${message_index}:${text}`;
        if (!seen.has(key)) matches.push({ message_index, path: leaf.path, text });
        seen.add(key);
      }
    });
    const offset = params.offset || 0;
    return textResult({ matches: matches.slice(offset, offset + 12).map(match => ({ ...match,
      ref: referenceFor(params.candidate, match.message_index, match.path, match.text) })), total: matches.length,
      has_more: matches.length > offset + 12, next_offset: offset + 12 });
  });
  register("calculate", "按顺序执行加减乘除，本地计算，不执行代码。", properties({
    candidate,
    operation: { enum: ["add", "subtract", "multiply", "divide"] },
    operands: { type: "array", minItems: 2, maxItems: 20, items: { type: "string" } },
  }, ["candidate", "operation", "operands"]), params => {
    const result = { candidate: params.candidate, ...calculate(params.operation, params.operands) };
    calculations.push(result);
    return textResult(result);
  });
  register("view_image", "查看某条消息中已有的内嵌图像。禁止下载远程图像；image_index 从 0 开始。", properties({
    candidate, message_index: index, image_index: index,
  }, ["candidate", "message_index"]), params => {
    const images = embeddedImages(messageFor(params));
    const image = images[params.image_index || 0];
    if (!image) throw new Error("无可读取的内嵌图片；远程链接不联网下载，请说明证据缺口");
    if (image.data.length > 28_000_000) throw new Error("图像超过 20MB，无法在当前限制内读取");
    viewed.add(`${params.candidate}:${params.message_index}`);
    const ref = referenceFor(params.candidate, params.message_index, image.path, `[图像观察]原始消息中的内嵌图片（${image.path}）`);
    return { content: [{ type: "text", text: `message_index=${params.message_index}, path=${image.path}, ref=${ref}` },
      { type: "image", data: image.data, mimeType: image.mimeType }],
      details: { candidate: params.candidate, message_index: params.message_index, path: image.path } };
  });
  pi.registerTool({
    name: "submit_evaluation", label: "提交评测", description: "提交最终结构化评测。evidence 只选择已提供的 ref 编号；程序自动恢复原文引用，成功后立即结束任务。",
    parameters: task.schema,
    async execute(_id, params) {
      if (++submissions > task.max_submissions) {
        return { content: [{ type: "text", text: "结构化提交失败次数已达上限" }], details: { submission_exhausted: true }, terminate: true };
      }
      try {
        const evaluation = expandSubmission(params);
        if ((task.required_calculations || []).some(candidate => !calculations.some(item => item.candidate === candidate))) {
          throw new Error("必须分别核算双方最终回答中的关键算式，不能只检查一方。");
        }
        if (task.stage === "correctness" && /候选\s*[AB]/.test(evaluation.correctness_reason || "")) {
          throw new Error("请用‘该回答’表述独立正确性理由，不能使用候选 A/B，避免配对后位置误指。");
        }
        if (task.stage === "pairwise") {
          const editorial = [evaluation.verdict.reason, ...Object.values(evaluation.evaluations).flatMap(review =>
            [review.summary, ...review.findings.flatMap(finding => [finding.text, finding.reason])])];
          if (editorial.some(text => /无标准答案|没有标准答案|未进行独立正确性|未进行正确性判定|未做独立正确性/.test(text))) {
            throw new Error("请删除评测流程说明，只描述回答本身的具体优劣和差异，再次提交。");
          }
        }
        if (task.stage === "correctness" && evaluation.evidence.some(e => e.message_index !== task.final_indices.A)) {
          throw new Error("独立判对错只允许引用已提供的最终回答");
        }
        const locations = checkEvidence(evaluation, task.stage, records, viewed);
        return { content: [{ type: "text", text: "评测已提交。" }],
          details: { evaluation, submission: params, calculations, evidence_locations: locations, viewed_images: [...viewed] }, terminate: true };
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    },
  });
  pi.on("before_provider_request", event => {
    const payload = structuredClone(event.payload);
    const schema = structuredClone(task.schema);
    const setRefs = (evidence, candidate) => {
      evidence.items.properties.ref.enum = [...bank.values()].filter(entry => entry.candidate === candidate).map(entry => entry.ref);
    };
    if (task.stage === "correctness") setRefs(schema.properties.evidence, "A");
    else for (const candidate of Object.keys(records)) {
      setRefs(schema.properties.evaluations.properties[candidate].properties.findings.items.properties.evidence, candidate);
    }
    for (const tool of payload.tools || []) {
      const definition = tool.function || tool;
      if (definition.name === "submit_evaluation") {
        definition.strict = true;
        definition.parameters = schema;
      }
    }
    const pendingCalculations = (task.required_calculations || []).filter(candidate => !calculations.some(item => item.candidate === candidate));
    if (pendingCalculations.length) {
      payload.tools = payload.tools.filter(tool => (tool.function || tool).name !== "submit_evaluation");
    }
    // Native constrained tool decoding, not an instruction to produce JSON text.
    const forcedTool = pendingCalculations.length ? "calculate" : "submit_evaluation";
    payload.tool_choice = calls >= task.max_tool_calls
      ? (payload.messages ? { type: "function", function: { name: forcedTool } }
        : { type: "function", name: forcedTool }) : "required";
    payload.parallel_tool_calls = false;
    fs.writeFileSync(`${process.env.PRIME_EVAL_TASK}.protocol.json`, JSON.stringify({
      model: payload.model, strict_submission: true, tool_choice: payload.tool_choice,
      parallel_tool_calls: false, submission_schema: schema,
    }, null, 2));
    return payload;
  });
  pi.on("session_start", () => {
    pi.setActiveTools(task.stage === "correctness" ? ["calculate", "submit_evaluation"]
      : ["read_trace", "search_trace", "calculate", "view_image", "submit_evaluation"]);
  });
}
