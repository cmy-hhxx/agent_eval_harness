独立核验候选最终回答是否符合题目和标准答案，给出 is_correct、具体理由与原文证据。

evidence 只能引用该候选 final_message_index 对应的最终回答，优先使用初始材料中的 final_evidence。不能引用用户问题、工具结果、中间推理或标准答案作为候选回答的证据；即使这些内容帮助你判断，也不要把它们的 evidence_id 放入 evidence。
收到 evidence_final_required 时，保留最终回答中的有效证据，移除其他消息的引用，再核实理由并提交；不要重复提交原来的非法引用。
