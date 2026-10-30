# Session 归因

Attribution 是独立 workflow，入口为 `workflow: "attribution"`。输入扫描以一行为一条评测记录，保留该记录的全部 trace，任何 trace 没有完整最终回答时整条记录过滤。按 trace 抓取的数据可有多行共享同一个 `session_id`；每条记录独立评测和落盘，不自动合并上下文。`meta.n_traces` 保留来源会话的总数，允许大于当前记录实际包含的 trace 数量，但必须是不小于实际数量的整数；规划和进度只统计当前 `traces[]`，不补造缺省上下文。完整会话输入仍以一行保留全部 trace。Score、Rewrite、指令遵循归因 和 Clustering 都不属于这条 workflow。

AIME 的 `4_daily_eval_slim` JSONL 可以直接作为输入。每个 trace 的 `message_pool` 和 `tool_sets` 在输入边界按索引恢复：保持消息顺序、对象字段顺序和原始证据路径，不改写正文，不另存展开后的输入文件。重复消息共享内存中的对象，内部规范投影也复用共享结构；缺失、越界或非整数引用报错，不把坏引用当成空材料。未使用共享池的 trace 保持原样。

采集 trace 子集时，外层 `meta.n_messages` 同样保留原会话总数，允许大于当前记录的消息总数；完整会话的外层计数和每个 trace 的消息计数继续精确校验。评测材料仅使用实际采集的消息，不按外层计数补造内容。

## 任务结构

```text
session input
→ attribution-compact-field（每个字段一个独立、单轮模型会话）
→ attribution-compact（代码拼装，无模型调用）
→ attribution-trace（每个 trace 沿完整过程归因）
→ attribution-session（跨轮归因，回填逐轮结果）
→ results/compact.jsonl + results/attribution.jsonl
```

每条实际收到的输入记录生成一条 compact。输入包含几轮就处理几轮，不跨记录拼接、不按外层计数推测未采集的上下文。Compact 是 Attribution 的必需前置任务；正常重试后仍失败时仅暂缓该 session，其他 session 继续，续跑复用已完成工作。

代码按实际轮次提供有界结构化字段、原生值和稳定原文坐标，先保留返回自身的主体、单位、期间等原生标量，再整理嵌套数列，避免大表列描述挤占额度；整理消息顺序、请求返回关联、原始组件身份和原文片段；优先保留明确诊断字段及仅见于输入快照的工具回执（含额度守卫），不把快照回执另算一次工具调用，不从工具名推断责任。每轮的每个摘要字段使用独立模型会话，只生成该字段内容；会话概览、跨轮观察另行生成。内部结构保持开放。字段会话并行调度，共用全局模型并发上限；就绪的归因优先于其他字段任务，计算得到的 compact 立即组装，避免归因等待整批摘要；模型选择关键事实编号，代码回填精确数值和稳定来源，避免重复抄表；默认 `bindings.attribution-compact.thinking: "off"`，无探索调用，一次响应直接提交。提示明确当前字段、value 类型及完整提交示例，值直接放入 value。结构失败最多定向修复一次，保留原事实，不做语义或语言复审。代码共享事实整理，并按字段、轮次拼装完整 compact，不调用汇总模型。

Compact 外壳使用 `session_overview`、`meta`、`turns[]`，多轮可带 `cross_turn`。每个 turn 保留从0开始的 `turn_index`，可包含 `plan/reasoning_chain/execution_chain/reflections/gaps/stop_reason/final_answer/key_data/artifacts`。这些分区内部保持开放 JSON，允许自定义重要信息；缺乏依据的分区可以省略，不强迫填写空结论。`key_data` 不固定指标或条目模板，重点保留数值、实体、期间、单位、口径、来源与结论使用关系。Schema 只固定外壳和分区类型、轮次覆盖；不做语义或语言返工。

摘要以原会话为主体，`gaps` 只记录原会话实际材料缺失。评测者未核验、未补读、首屏展示截断不属于原会话缺失，不写入 compact；同一事实只记录一次。

`meta` 的业务身份、被评模型、收到的 trace ID、source_input_id、summary_origin 和原始 session 元信息由程序回填。一个来源 UUID 始终指向按接收轮次顺序展平的同一消息数组；source_positions 将统一消息序号映射回原始 trace_index/message_index。字段会话、Trace、Session、Criteria 与 Comparison 共用来源身份、原文字段路径和半开 UTF-16 片段范围，不把拼接问答注册为原始消息。

字段模型统一用 `{"$evidence":[本次reference.evidence_index]}` 关联关键观察、失败动作、调用关系和关键数值；数值菜单直接使用同一原文编号，一个自由分组可以选择多个编号。代码回填 `source_evidence`，选择数值菜单项时将原值、位置和引用写入 `source_values`。两者均是代码保留字段，模型不填写；`evidence` 裸数字数组会被拒绝并指向 `$evidence`，不作为未解析编号落盘；其余内部结构开放。正式 compact 不保留临时编号，summary_origin 标记模型概述身份，摘要文字不作为引文。类型或引用错误沿用现有一次定向修复，反馈指向具体JSON路径和当前可选编号，不做语义或语言返工。存成字符串的 JSON 直接索引原字符范围，重复数值保留各自坐标；隐私投影后的父对象不作为原文。

每个字段的具体任务及 value 类型直接写入该字段的系统提示。提交示例演示可解析引用，不引导选择菜单开头的状态码、耗时等遥测项；key_data 自由组织指标说明和用途，具体数值、日期保留在代码回填的 source_values 或 source_evidence 中，不再让模型另抄一份或换算期间。没有相关数值时返回空对象。归因展示保留原值、原文字段路径、发言来源、引文和补读入口，省去 source_values 中重复的轮次、消息等坐标；正式 compact 继续保存全部定位信息。

每轮 `execution_facts` 由代码记录已收到的工具调用数量、消息位置及模型返回形式，调用记录与返回记录分开计数，空规划数组不代表其他模型也返回空数组。该字段及其原文引用在拼装时填写，不由摘要模型改写。摘要只负责提取当前字段的语义，按这些事实描述过程；没有关键数值时直接返回空对象。

字段完成后可独立续跑；完整 compact 落盘后，字段收据通过其文件与行号恢复，原始提交仅保存恢复差异，不重复保存正文。结果写入器按已接受收据的原有行号恢复顺序，不以任务计划顺序重排旧行。

每个 Trace Agent 接收会话概览、本轮 compact、跨轮观察、原始问答、适用标准与原文导航。先使用 compact 中已核验的原文片段，遇到决定性缺口才定点补读。compact.components 列出真实链路组件：程序整理模型、Agent 和工具身份，独立 components 字段任务补充未单独记录的内层服务、委派模型、具体脚本路径与 skill 名，代码核对名称存在于所选原文后合并。目录保留调用位置、原始来源和组件编号，不判断责任；identity_basis 区分原始调用记录和从原文提取的名称，名称提及本身不证明执行。归因选择 [`taxonomy.json`](../packages/prompts/resources/attribution/taxonomy.json) 中最具体的责任条目 ID，并以 actor_index 选择来源主体。模型自身错误使用 reasoning 条目名称，模型名称仅说明来源；工具、脚本和 skill 故障使用具体组件名称。失败动作写入问题描述，正式字段结构不变。错误命令定位参数生成步骤，脚本实现错误定位脚本文件，技能正文错误定位具体 skill；不因经 shell 执行就归责 shell，也不因终稿有错就排除上游故障。同一故障只计一次，独立偏差分别记录，不要求类别分散。

每个 trace 有一个完整过程审查，不再按组件拆分调用。单轮 session 的过程审查直接生成终态，由程序回填 session 总结和空跨轮问题，不额外调用 Session 模型。请求参数错误、工具实际执行错误、返回后使用错误分别定位；同一上游问题沿用到终稿不重复计责。报错、空返回、零行、截断、缺返回和调用无结果是调查线索，由模型结合上下文判定，不能凭关键词直接生成问题。

归因首屏终稿最多6400字符，按400字符切成可提交原文，超出部分保留准确续读入口；key_data 复用同样的6400字符窗口。plan、reasoning_chain、execution_chain、reflections、components 只接收过程材料，不接收终稿或过程节点中与终稿完全相同的纯生成文本；同一节点的真实输入观察仍保留。结论相关字段接收终稿陈述。final_context.partial 与过程片段的 partial/total_chars 保留展示范围，不表示原文缺失或原会话未完成。过程片段与数值按实际轮次独立分配预算。模型展示只传一份精简的 actor_catalog（actor_index、kind、name、原文引用），省去 compact 中重复的组件目录、调用关系元数据、交付索引、重复坐标和摘要身份标签，保留原始运行环境事实；终稿已完整展示时省去重复的最终结论摘要。精确位置与摘要身份仍保留在正式compact中，每段原文附定点补读入口。重复引用只在本次准备期间按同一 evidence_id 解析一次，每次出现仍核对引文；不建立跨 run 正文缓存。代码提供 execution_links，保留请求、回执、发起模型和关联模型输入的原始位置，不据此宣称模型采纳了回执；同一接收组件的相同原文输入合并导航，完整位置存为 additional_input_locations。归因视图省去这些重复位置及代码计数/输出形态的重复证明，语义观察和 source_values 的原文证据照常呈现，已读记录以实际展示为准。可见思考、动作、返回及数字型 JSON 均有导航；仅对决定性证据缺口补读，独立读取可并行，不枚举全局责任图，不增加模型阶段或校验循环。

Session Agent 使用完整 compact、有序原始 QA 和执行原文入口，只核查跨轮前提、条件、状态、结论变化，不重做各轮数值和工具审查；各轮结果由程序原样回填。某轮失败或未重试不能仅因前轮成功过就重复报为跨轮问题。模型通过标有 question/answer 的连续引文读取完整回答，不再同时传一份重复正文；可信输入和正式产物不变。不同 QA 的矛盾须由相应原文支持，合理条件更新不算矛盾。Session 同样自主选择具体 taxonomy ID，不固定为终稿生成轮；单轮定责示例只进入 Trace 提示。

Compact 接受后立即写 `results/compact.jsonl`，Session 接受后立即写 `results/attribution.jsonl`；其他 session 无需等待。默认业务交付按模型和原始完整日期组织：归因为 `<模型>/<模型>-YYYY-MM-DD.jsonl`，摘要为 `<模型>/compact/<模型>-YYYY-MM-DD.jsonl`。持久化与续跑均保留任务 UUID、一基行号、原始来源和已接受结果。完整成功的归因仍跨版本复用；旧归因缺摘要时只补 compact，不自动重评正式判词。

调度按输入记录准入，`execution.sessionWindow` 默认16；代码拼装与就绪归因优先于新字段任务；代码任务不占模型 Worker 或网关额度，持久化接受提交后立即唤醒下游调度。失败或阻塞的 session 释放窗口，完成度仍以 session 任务为准。

## 正式契约

```json
{
  "session_meta": {},
  "turns": [
    {
      "meta": {},
      "summary": "",
      "problem": [],
      "is_correct": 1,
      "correct_reason": ""
    }
  ],
  "session_summary": "",
  "session_problem": []
}
```

`session_meta` 与每个 `turns[i].meta` 直接保留输入值。`is_correct` 使用 `1` 表示与标准一致、`0` 表示不一致、`null` 表示没有标准或无法据给定标准判断。turn 和 session 的 Problem 同形：

```json
{
  "problem_id": "p1",
  "component": "finquery 取数服务",
  "label": "零行结果未识别",
  "definition": "应返回数据的查询返回零行，后续仍据此形成事实结论。",
  "problem_phenomena": "第一问把零行取数结果当成有数据支持。",
  "reason": "工具请求查询 X，原始返回为零行，下一轮仍给出肯定结论。",
  "severity": "P1",
  "severity_reason": "重要结论缺少数据支持，需要重新取数核对后才能使用。",
  "evidence": [
    {
      "position": "trace_index 0 / message_index 3 / path /output/0/text / evidence_id ev_11111111-1111-4111-8111-111111111111_3_text_0_8_/output/0/text",
      "component": "tool_call: finquery 取数服务",
      "quote": "为您找到0条数据",
      "reason": "证明工具返回零行。"
    }
  ],
  "calculations": [
    { "text": "计算错误：将 5.89 亿元误写成 589 亿元，放大了 100 倍。" }
  ]
}
```

`quote` 上限为400字；工具和错误反馈只提供不超过400字的可提交片段。引文必须是精确连续原文，不能拼接或由程序截断。`position` 保留原始轮次、轮内消息和字段路径，末尾附 ` / evidence_id <完整坐标>`，外部字段结构不变；后续阶段直接解析该 ID，不生成临时替代来源。`evidence.component` 明确区分 `reasoning:`、`tool_call:`、`answer:` 等证据位置及具体组件。`calculations` 只保留文字点评，不再嵌套操作数和复算元数据。

新生成的每条 Problem 必填 `severity`（P0/P1/P2/P3，P0 最严重）和 `severity_reason`，按本次对最终交付的已确认影响判定；已补救的问题按残余影响分级。同类问题在不同回答中可以有不同等级，不按等级拆类，也不改变 Comparison 的判胜规则。分级口径与点评表达统一维护在[问题表达规则](../packages/prompts/resources/attribution/problem-output.md)。Trace 与 Session 各自填写本阶段产生的问题，正式导出原样保留。跨版本复用的历史正式行不补造后来新增的字段。

提交只校验 Schema、字段范围、证据身份、原文坐标及读取证明；不靠占位词黑名单、相似措辞或语义重复判断触发返工。来源预览的编号只对应已展示的连续原文，完整长段在展示时拆成不超过400字的独立片段，各自保留原始坐标。工具沿用相同限制；拒绝提交时一次反馈全部引用问题和可选短片段，要求替换对应 evidence.index，不逐条消耗修复次数。校验不会改写或截断所选 quote，不增加校验阶段或预算。

## Trace 与 Session 汇总

Trace 接收原始 Q/A、compact、适用 Criteria 和显式 ground_truth，输出总结与逐条问题。有标准答案时提交 `summary/problems/is_correct/correct_reason`；无标准时仅提交 `summary/problems`，程序固定 `is_correct=null` 和未提供标准答案的说明。一般缺陷不直接等同于与标准不一致。

Session 接收完整 compact、有序原始 QA、执行原文导航，不读取各轮评测意见，避免将局部评语当成原始事实。已有 Trace 结果由程序原样回填到 `turns[]`。Session 内部 evidence 使用 `{index, reason}` 选择原文编号，程序映射回原始 trace、消息和字段坐标。

所有新生成的描述使用中文，特别是 `label`、`definition`、问题理由、总结和严重程度理由；真实工具名、代码、单位与原文引文保留原样。该要求通过提示词表达，不新增语言校验或润色循环。

## Comparison

Comparison 是另一个独立 workflow，按整场 session 比较，不逐 trace 判胜。单轮和多轮共用原始来源目录；首屏可合并展示有序问答，正式引文仍定位每轮原始消息，独立核验覆盖所有实际交付轮次。Attribution 结果提供整场总结、turn 问题和 session 问题，用于识别最终交付与跨问答逻辑。结果查看与问题样本复核也用相同展平消息索引解析原文。

## 验证

开发运行 `npm run typecheck` 和 `npm test`；提交前运行 `npm run test:full`；涉及 Worker/SDK 时运行 `npm run test:integration`。真实样本必须覆盖多 trace、空工具返回、零行、工具报错、截断和最终回答缺失过滤。
