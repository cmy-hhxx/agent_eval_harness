# 审查范围

- 只审查本次固定组件在 trace 中的调用和相邻小现场：原问上下文、调用前推理、工具参数、工具返回、下一轮实际输入、下一轮推理/输出。
- component_entrypoints 提供本组件前八个已知调用的直接读取入口；先按 read_request 打开小现场，无需重新枚举全 trace 来定位这些调用。component_entrypoints_total 是已知入口总数，超过首屏数量时须从完整执行导航继续核查其余调用；入口为空不代表没有问题。跨组件的必要因果证据仍可读取。
- 每次先看完整小现场，再决定是否继续读取。首屏之外最多三次续读；优先用 search_trace 精确定位，再用 read_trace 读取最小原文窗口。execute_code 用于计算、结构化整理和结果落盘；已有导航能定位的原文直接通过读取工具获取。
- 工具报错、空返回、零行、截断、缺失返回和调用无结果都按问题处理。finquery 零行、search/web 零结果、明确报错必须登记。
- 组件返回大量数据时，核对关键字段、行数、对象、日期、单位是否进入下一轮，以及下一轮是否遗漏或改写了关键内容。
- 只写本组件能够直接解释的问题；不要替其他组件归责，不要臆测隐藏推理。

# 输出

- 提交前合并同一技术原因、同一证据链且会由同一修复消除的重叠问题；保留一个完整问题并收齐全部证据。原因、影响范围或修复动作不同的缺陷仍分开，不能只按同一组件或同一工具机械合并。
- label 是可复用的短问题名；definition 概括该类问题的触发范围和可见结果，不重复本次个案细节。
- problem_phenomena 只写本回答中可见的具体现象；reason 只写证据如何形成技术因果链，不复述 definition 或逐条抄 evidence.reason。
- evidence 只选择本次读取得到、且 quote_chars 不超过 400 的连续原文编号；不能拼接、截断或自造引用。每项 reason 只说明该段原文直接证明了什么，不复述 problem_phenomena 或 reason。程序负责补 position、quote 和 component。
- 若收到 quote_too_long，只按 expected.suggested_evidence 选择 2–3 个能支持同一结论的合规 index 替换失败项；保留 label、definition、problem_phenomena、reason 和其他问题，不重新生成整份归因。
- 计算错误只写 calculations[].text，说明错误算式、正确结果或偏差方向，不再填写操作数结构。
- 没有问题时提交空 problems；不得为了凑数制造问题。
