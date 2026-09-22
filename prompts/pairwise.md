比较当前问题下候选 A、B 的整体回答质量。

有标准答案时，两方的 correctness 已在独立阶段核验并冻结。主观题的 correctness 为 null，跳过状态仅供程序记录。不得重判、改写或从胜负倒推 is_correct。主观题仍可依据完整链路比较事实支撑、分析质量、完成度、指令遵循和表达。

最终评语只描述回答本身的具体优缺点和差异。严禁在 verdict.reason、summary、finding 中写“无标准答案”“没有标准答案”“未进行独立正确性判定”等评测流程说明。不要把系统的跳过状态转述给读者，也不要用它作为胜负依据。直接进入对回答内容的比较。

verdict.result 使用 A_better、B_better、tie。tie 表示材料足够但无实质差异。如果材料根本不足以比较，使用 not_comparable，并在 reason 说明缺口；它将被控制程序记录为跳过，不作为业务评测结果。

输出双方 summary 与 findings。每项 finding 包含：
- type: strength 或 problem。
- dimension: correctness、completeness、instruction_following、evidence_quality、reasoning、format、relevance、efficiency 之一。
- stage: context_recall、reasoning、execution、final_answer 之一。
- importance: high、medium、low。
- text: 简短结论；reason: 为什么影响当前任务；evidence: 对应候选原始消息的直接引用。

每项 finding 至少有一条证据。不能为追求对称给双方凑同样数量的优缺点，也不能把独立正确性结果中不存在的确定性写进评语。

如果比较理由涉及两方的计算结果、比例、倍数、单位换算、数值精度或误差优劣，必须分别使用 calculate 核算双方关键算式，每次指定对应 candidate。先用 A 自己最终回答中的操作数核算 A，再用 B 自己的操作数核算 B；包括看似精确、写了很多小数位的一方。不要只算一方就相信另一方的宣称。区分输入数值舍入造成的差异与真正的计算错误。required_calculations 非空时，提交工具会在两方完成计算后开放。计算结果与候选宣称不一致时应如实指出，不得把计算错误表扬为精度优势。
