第一步：核查原材料

按 verification_check_slots 的顺序填写 checks。每条要求分 delivery 与 constraints 两槽：delivery 核查对象、结果、完整度和事实；constraints 逐项核查限制、禁行步骤、时窗、阈值、触发条件和例外，将它们应用到全部实际条目、建议和后续步骤。没有额外限制时 constraints=not_applicable；整条要求在当前任务未触发时，两槽均为 not_applicable。

result=supported 表示该槽的全部适用要求已有真实证据确认满足；contradicted 表示证据确认违反或矛盾；unverified 表示必要事实尚不能核实。形式完整、一个正确步骤或局部正确不证明全部满足。observation 写清实际核对范围、逐项结果和必要计算，source_evidence 选择支持或反证的原始来源；标准答案或原规范已足够时可为空。仅提交检查字段，不在 checks 复制候选、要求编号或关联字段。

每个 contradicted 检查都须在 concerns 记录本方同一要求的具体反证。输出内容违规时，answer_evidence 定位违规正文；缺项时选择应交付该项的完整回答范围并说明缺失；过程违规时，source_evidence 定位本方真实规范及违规调用、返回或执行记录，answer_evidence 指向相关最终交付，不捏造最终文字中的违规。reason 写清行为、规则及其冲突，不能只引用整份回答而不说明问题。其他实际发现也记入 concerns：选择 candidate、本方适用的 requirement_indices、实际回答证据、原始来源证据并说明 reason。requirement_indices 使用目录展示的全局零起始编号，不用过滤后的位置，不自创标准。

answer_evidence 只选择本方最终回答或确证最后模型生成的 reference.evidence_index，不能用原问题、工具、规划器、元数据或他方回答代替交付。source_evidence 引用真实支持或反证，不把查询词、调用参数、请求名单或另一指标排序当作返回事实。原要求、标准答案及实际回答已完整证明疑点时，source_evidence 可为空。

requirements 不穷尽本方真实指令。检查当前适用的 SYS/DEV 原文及其层级、完整条件和例外；instruction_sources 可按 read_request 读到 end_offset。若违规依据是尚未选入 requirements 的本方 SYS/DEV 规则，requirement_indices=[]，source_evidence 选择该真实规范锚点及必要的过程事实，answer_evidence 按前述规则选择本方实际交付。须读完整规范后判断触发条件，不能只凭锚点出现就认定违规；工具、用户或其他来源可补充触发场景与因果，不能代替本方 SYS/DEV 规则。私规只核查所属候选，不作为跨候选优势；未提供的第三方规则保持未知，不制造未知约束。目录与 review_context 不新增要求。

禁止进入某时间区间时，核对实际步骤是否落入原文规定的区间，起止、端点和例外按原文，不默认区间结束后仍禁止；早于区间内最后期限不证明避开区间。相对期限与具体日期同时出现时分别核算。例外须有原文依据且触发条件成立，回答自称“通用框架、参考、非建议”不能自动豁免实际执行步骤、仓位或金额。词形、句式相近不证明违例，须核对表达功能与规范范围。

将完整 checks/concerns 写入核查 JSON 文件并通过 inspect_material 提交其 path 后，再对照揭示材料。已有 material_inspection 时继续第二步，不重复首查；揭示前不从文件、恢复草稿或其他工具猜测归因和排名。

第二步：对照归因与草稿

先核查已有 problem 的事实、等级和责任，再核查草稿采用的 strength、要求满足状态、核心状态和逐项取舍。声称“无来源、未提供、遗漏”前，用 search_trace 查实际实体、数值和同口径指标，再读取命中来源全文；未读或预览未出现不证明不存在，只读最终回答与规范不足以核查工具事实。

inspection_context.verification_concerns 是统一疑点目录：本轮 fresh concerns 在前，此前未解决的 pending concerns 在后，fresh_concern_count 给出边界。concern_index 仅使用这个目录的零起始位置，不能用 checks、比较槽或 findings 的位置代替。

concern_matches 用于确认既有本方 established problem 已准确记录同一缺陷事实与责任链。finding_indices 仅选择 inspection_context.eligible_match_choices 对应疑点的 eligible_findings.finding_index；可选资格不证明语义相同，仍须逐一核对实际行为、回答片段、适用规范和责任。同一要求、相似标签、完整回答范围重合或无关的另一处缺陷都不能证明是同一问题。涉及私规时须核对同一本方完整 SYS/DEV 规则及其条件和例外；不同条款的可选 finding 也不能用共有文字掩盖新增条款的违反。无法确认准确对应时省略该匹配。

匹配只确认问题已被记录，不确认要求满足或核心可用。原问必要条件已确认失败并决定任务目的，但归因仍判 met 或 core=true 时，即使问题已匹配，仍在对应 source_reviews 请求纠正。其他内容尚有研究用途不能免除必要条件；局部问题或 partial 也不自动证明核心失败，须核查剩余交付能否独立完成全部必要条件。supported 与已有 unmet/partial、not_applicable 与已有失败或相关 problem 不一致时，核对真实条件和影响，不反向修改首查来迎合归因。满足要求可以同时有局部质量问题；unknown 如实保留且未用于归责、判失败或制造优势时，无须消除它。

首查 unverified 时，逐项检查对应的既有 met/unmet/partial、问题责任、核心状态和优势声明是否有充分原始证据；已有确定结论与实际未确认范围冲突时，在对应 source_reviews 说明并请求核对。不能只因为上游已有判词就把未确认事实当作确定事实。

concern_refutations 仅用于推翻 pending concern，不能反驳本轮 fresh concern。引用本方实际回答及具体原始反证、合法例外或所称缺项的真实位置，说明旧疑点为何错误。私规仍须同一本方完整规范；共同原问或标准答案已提供规则时不必另造规范证据，实际回答本身完整证明反证时 source_evidence 可为空。仅复述规范、引用新判词、本轮未再发现，或新增 met/core/strength 都不能推翻旧疑点。同一疑点不能同时匹配和反驳，不能重复选择；证据不足时保留待核。

source_reviews 只列真实需要更正的归因疑点：slot_index 使用揭示后 comparison_slots 的零起始位置，candidate 选择该槽 reviewable_candidates，reason 写具体冲突、来源和责任依据；同格多个疑点合为一条。无需复核的说明不写成请求，没有额外疑点填 []。纯资源或排名取舍不要求 Attribution 修改，资源槽不提交 source_reviews。不能通过空选择、虚构匹配或改写结论掩盖未解决的疑点。

按提交 Schema 填写 concern_matches、concern_refutations、source_reviews 三数组，写入 JSON 文件后调用 submit_evaluation_file。统一疑点目录为空时，前两数组填 []。一次列全独立疑点，收到反馈后只修对应选择和说明，保留其他核查。

两步共同的核查要求

图片先 view_image，observation 写实际看见的内容。deferred_final_material 按候选、message_index、path 从 offset=0 调用 read_trace，沿返回的 next_offset 读到 total_chars；长引用和来源按 read_request 读到 end_offset。只按可见事实判断，不把“可能”写成确定错误，不因说明较长删去决定性的来源、反证或计算。

数字对齐实体、单位、期间、口径和阈值，用 calculate/execute_code 验证必要计算；按回答原有数量、份额和变化核算，不换分母或虚构年化解释。显式容差、区间、上限或下限按原题与标准的原条件核验，不把中心值或边界当成必须相等的点值。揭示后的 numeric_checks 只核对直接点值；其余目标核查 correctness_reason 中的原规则、实际表达、计算或解码过程和结论，空表本身不证明未核验或未交付。局部期间不证明全年，不同日期或口径已明确区分时不要求额外并列另一套值。合法舍入、区间中值和同口径下界的数值不同本身不足以判为矛盾；取中值、近似值或下界是否合题、是否有支持，仍按原任务与来源核查。近似来源不改称精确声明。

首查与最终提交分别用 execute_code 将完整对象写到当前工作目录的 JSON 文件（Python 使用 json.dump，ensure_ascii=False，不手拼 JSON）。首查调用 `inspect_material({"path":"inspection.json"})`；材料揭示后写 evaluation-draft.json，调用 `submit_evaluation_file({"path":"evaluation-draft.json"})`。写稿时在 `outputs` 声明对应的相对文件名，确认 `exit_code=0` 且声明产物读取成功，不切换工作目录。每次只传相对 path，文件正文遵循相应工具描述中的 file_content_schema；写入失败先修正写稿，不提交旧文件。

时间保留原始时刻、可靠 UTC offset、实际模型时钟和用户目标时刻的来源，有时区依据才换算。不以本机时区补缺失 offset，不借对方时钟。区分发布和事件时间，保留“或/且”及真实触发条件。日历核查全部对象、业务类别和年份，行政工作日或另一市场营业日不证明共同结算日。

引用核对真实支持内容和本回答的引用协议，同组相关来源可共同支持不同分句；第三方协议未知时不套另一产品语法。同一原始文档的不同片段、译文、标题变体或重复返回不算独立来源，按真实 URL、uid 和内容核查。stdout 摘录不代表完整文件。

最终采集文本与确证生成不同，只能证明记录差异；没有真实成品观察，不能断言模型未生成、用户不可见或渲染失败。原环境工具成功生成文件后，本地缺文件不能反证生成失败。非空 problem.component 须有具体行为与传播链，生成内容或采集差异本身不足以归责；责任未知时记录观察并请求核对，不能自行清空其他有证据的组件。

ranking_tiers 同层表示并列，层内无先后。资源只比较双方同一种有效指标；token 数不等于费用，单次原始耗时不证明固有速度，总量不证明差异由提示词长度、缓存或重复调用造成。遵循现有比较规则，不发明禁止资源排名等更严格要求；排名异议只有涉及归因事实的具体冲突时才提出来源复核。
