按顺序评审 `answer`：

1. 从最后一条用户问题和必要历史提取目标、核心要求；确有加分项或致命风险时才填 `scoring_points` / `red_flags`，否则填 []。
2. 按 `ground_truth.available` 判对错：有标准答案时填写布尔 `is_correct`、核对理由和最终回答 `answer.final_message_index` 的证据；没有时分别填 null、""、[]。
3. 检查回答和调用链，写出有证据的优点、问题和疑似问题；同一现象写一条 finding，最多 8 条，`finding_id` 各不相同。`text` 写发现，`assessment.observation` 写看到的事实，`reason` 写判断依据，`assessment.impact` 写对任务的影响。关联核心要求时填 `requirement_index`，否则填 null；`importance` 表示影响大小。
4. 优点的 `problem=null`；问题的 `problem.label/definition` 写现象及边界。`stage` 写发生阶段；`problem.component` 对工具调用或返回写调用链 `catalog.name` 中的确切工具名；对模型误读结果、推理或表达写「模型自身推理」。疑似问题也要定位部位，并以 `assessment.evidence_status="uncertain"` 写明尚未证实的判断。
5. `summary` 概括完成情况、主要优点和缺口，避免重复逐条 finding。

`evidence_id` 只能逐字复制材料或 read_trace/search_trace/view_image 返回的值，禁止按起止数字或路径自行拼接、猜测；没有现成 ID 时用 search_trace 检索原文取得。图片须先查看并填写 observation，数值争议要核算。调用 submit_evaluation 提交；长 JSON 可用 execute_code 写入当前工作目录，再用 submit_evaluation_file。校验失败时修正对应字段，判断改变时重新核验。
