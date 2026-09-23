# 双 Agent 评测 Host

用同一套评测规则，通过独立 Worker 调度 Pi / Prime SDK，对已有回答进行可追溯的配对评测。主线为 TypeScript；Python 用于代码工具与 Prime runtime。

**项目稳定前不维护向后兼容。** 修改接口或契约时同步更新实现、调用方、测试和文档。

## 快速开始

```bash
mise trust
mise install
cp .env.example .env
```

在 `.env` 填写共用的 `EVAL_BASE_URL` 和 `EVAL_API_KEY`，两种底座使用同一组变量。随后安装和构建：

```bash
npm run bootstrap
npm run build
npm run doctor
```

将四个版本的 JSONL 放到 `data/inputs/`，在 [configs/host.json](configs/host.json) 核对文件映射与裁判模型：

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001
npm run eval -- run --engine prime --run-id prime-001
```

结果位于 `data/runs/<run-id>/`。只比较 Fast ↔ Fast、Expert ↔ Expert，候选盲测后恢复稳定版本 ID。Host 保存有效收据后才算任务成功。

## 文档

| 想了解什么 | 入口 |
|---|---|
| 配置、命令、目录、恢复与 Worker | [使用指南](docs/usage.md) |
| 输入、配对、结果与证据规则 | [数据契约](docs/contract.md) |
| Host / Worker、模块边界与扩展 | [架构](docs/architecture.md) |
| 开发、测试、依赖与文档维护 | [开发指南](docs/development.md) |
| 评语写法与真实模型人工复核 | [评测质量](docs/quality.md) |

固定工具版本见 [mise.toml](mise.toml)，底座版本和来源见 [vendor/upstream.json](vendor/upstream.json)。开发者与 Agent 的仓库约束见 [AGENTS.md](AGENTS.md)。
