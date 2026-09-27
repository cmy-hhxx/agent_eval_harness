# 评测提示词

此模块是四个内置 Agent **主动下发的评测指令与工具描述**的唯一来源：阶段系统规则与任务规则、任务材料/预算/恢复消息的固定文案，以及内置材料工具和两个提交工具的描述。`src/index.ts` 明确组装顺序；`packages/agents` 只选择所需工具并组装 Profile，Tools 只负责工具执行，Host / Worker 不再维护另一份规则正文。

按 `resources/<stage>/default/` 编辑阶段规则，按 `resources/tools/<tool>.md` 编辑工具描述；`shared/` 只存共同的消息边界。启动时读取并检查：缺失或空文件、未知工具描述均报错。修改后运行 `npm run build:app` 并重启 Host；运行中的 Worker 不热读文件。已接受任务不因提示词变化重评，同 run ID 的新 attempt 使用本次启动的文本。

技术性校验错误与工具执行结果仍由相应校验器、工具和 Runtime 按实际失败生成，不属于可独立调整的评测提示词。现有 `packages/agents/src/<stage>/fixtures/example.json` 仅为单元测试输入，**不会进入模型上下文**。将来需要专家点评、专家结论或 rubric 时，在所属阶段集中存放经人工确认的材料，显式声明选取和装配顺序，并添加测试后才启用；不依赖 Pi / Prime 原生 skills，不按运行样本自动检索，也不把原始输入复制进 run。

改动规则、工具描述、材料组装或启用专家示例等可能影响判词的内容时，人工更新配置中的 `evaluatorVersion`。纯文件搬迁且模型实际接收的文本不变不需要更新标识；禁止用摘要代替人工声明。调试时使用 `--debug` 的契约与 attempt 快照，当前看板也只显示运行应用的公开 Profile 定义。
