# 可编排评测 Host

TypeScript Host 编排 JSON 评测，Agent 通过 Profile 提供提示词、Schema 和业务校验。默认使用 Pi，也支持 Prime；Python 只用于代码工具和 Prime runtime。

开发前先读 [AGENTS.md](AGENTS.md)；当前契约、模块边界和验证要求以此为准。

主线是共同 Criteria → 每条回答 Attribution → 每场一次 Comparison，必要时在对比前补查一轮归因。正式结果默认经 Rewrite 润色，未决结果单独待核；独立核验和后置 Clustering 按需执行。流程边界见[评测质量](docs/quality.md#流程与科学边界)，操作见[使用指南](docs/usage.md)。

## Agent 开发导航

| 任务 | 先读 |
|---|---|
| 运行、配置、恢复、产物 | [使用指南](docs/usage.md) |
| 输入、Agent 输出、证据、导出 | [数据契约](docs/contract.md) · [Schema](schemas/README.md) |
| 提示词、材料文案与工具描述 | [提示词模块](packages/prompts/README.md) |
| 模块边界、Host / Worker、扩展 | [架构](docs/architecture.md) · [模块地图](docs/modules/README.md) |
| 修改、验证、测试和文档 | [开发指南](docs/development.md) |
| 评语和真实模型复核 | [评测质量](docs/quality.md) |
| 看板与界面规范 | [PRODUCT.md](PRODUCT.md) |
| 持续取数、评测改写与上传 | [自动化流水线](docs/automations.md) · [远程输入接口](docs/handoff.md) |

按任务进入对应页面；同一规则只维护一份，其他页面通过链接引用。

## Eris 评测助手

配置根目录 `.env` 后运行 `bash agent/run.sh`。模型、对话、专业评测调用与恢复见 [Agent 使用说明](agent/README.md)。批量评测看板使用 `bash run.sh`。

## 离线评测汇报

打开 [evaluation-report/index.html](evaluation-report/index.html) 查看历史案例与提示词快照；它不代表当前评测器或方法验证结果。单文件构建、快照来源和已知疑点见[模块说明](evaluation-report/README.md)。

## 最短运行路径

```bash
mise trust
mise install
cp .env.example .env
mkdir -p configs/local
cp configs/models.example.json configs/local/models.json
npm run bootstrap
npm run build
npm run doctor
```

在 `.env` 填写两种底座共用的 `EVAL_BASE_URL` 和 `EVAL_API_KEY`，在 `configs/local/models.json` 填入网关模型 ID，然后运行：

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
```

结果默认写入 `data/runs/comparison/<run-id>/`。同一个 `run-id` 续跑未完成和原选择范围内的新增任务，保留已接受结果；详见[运行与恢复](docs/usage.md#运行与恢复)。本机预检、启动和结果浏览使用 `bash run.sh`，见[看板](docs/usage.md#本机运行看板)。

输入由 [configs/host.json](configs/host.json) 指定，默认按 Fast、Expert 分组两两比较。文件与评测集选择见[输入治理](docs/usage.md#输入治理)，模型组规则见[对比组契约](docs/contract.md#对比组)。

固定工具版本见 [mise.toml](mise.toml)，底座版本与来源见 [vendor/upstream.json](vendor/upstream.json)。
