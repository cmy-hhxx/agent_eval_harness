# 可编排评测 Host

TypeScript Host 编排评测任务，Pi / Prime Worker 执行模型与工具调用。主线为共同 Criteria → 单回答 Attribution → 两两 Comparison；改写默认开启，独立核验与聚类按需执行。

开发先读 [AGENTS.md](AGENTS.md)。当前行为以源码、配置和 Schema 为准。

## 最短运行路径

```bash
mise trust
mise install
cp config.example.ini config.ini
mkdir -p configs/local
cp configs/models.example.json configs/local/models.json
npm run bootstrap
npm run build
npm run doctor
```

在 `config.ini` 填写渠道地址与密钥，在 `configs/local/models.json` 填写网关模型 ID，然后运行：

```bash
npm run eval -- preflight
npm run eval -- run --engine pi --run-id pi-001 \
  --config configs/host.json --config configs/local/models.json
```

结果写入 `data/runs/comparison/pi-001/`；同一 `run-id` 续跑未完成任务，保留已接受结果。新日期或重评使用新 ID。

## 按任务阅读

| 任务 | 文档 |
|---|---|
| 配置、输入、运行、恢复、产物 | [使用指南](docs/usage.md) |
| 输入、阶段结果、判决与证据 | [数据契约](docs/contract.md) · [Schema](schemas/README.md) · [字段用途](docs/schema-fields.md) |
| 模块、生命周期与扩展 | [架构](docs/architecture.md) · [模块地图](docs/modules/README.md) |
| 修改、测试与文档维护 | [开发指南](docs/development.md) |
| 人工复核与评测实验 | [评测质量](docs/quality.md) |
| 提示词与工具描述 | [Prompts](packages/prompts/README.md) |
| 本机界面规则 | [PRODUCT.md](PRODUCT.md) |
| 持续取数、评测与交付 | [自动化](docs/automations.md) · [远程接口](docs/handoff.md) |
| Eris 对话、数据与工具 | [Agent 说明](agent/README.md) |
| 离线汇报与历史快照 | [汇报模块](evaluation-report/README.md) |

配置完成后，`bash run.sh` 启动评测看板，`bash agent/run.sh` 启动 Eris，`bash automation.sh` 启动自动化流水线与监控。各入口的运行条件见对应指南。
