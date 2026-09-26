# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: plain HTML/CSS/JavaScript served by the existing TypeScript Host; keep the service dependency-free and local-only.

## Users

评测 Host 的操作者，在可信的单机环境中查看评测输入与正式输出、按样本定位 Agent 任务，预检并启动、停止或续跑评测。

## Product Purpose

这是一个可编排评测 Host。它读取 A / AA 输入，调度 Pi 或 Prime Worker，保存可恢复的评测结果。看板的成功标准是操作者无需盯住终端，就能按样本核对原始回答与归因、对比、改写结果，知道运行是否健康并控制运行。

## Positioning

看板直接读取 Host 的运行状态和控制接口；它不是第二套调度器，也不复制输入或结果状态。

## Operating Context

服务运行在本机回环地址，操作者通过浏览器查看 `data/runs/comparison` 中的运行及其登记的数据源。启动、停止和同 run ID 续跑沿用现有 CLI、run lock 与恢复规则。

## Capabilities and Constraints

看板按批次与 case 查看输入、正式结果和 Attribution / Comparison / Rewrite 阶段状态；运行设置可编辑本次启动的模型 ID、推理等级与部分预算，并预检输入。看板支持以 Pi 或 Prime 启动新 run、停止运行、调整并发和续跑。当前不提供远程访问、用户鉴权、任务级独立调度或持久化配置编辑；Host 仍是唯一写入者。

## Product Principles

- 控制入口复用现有 Host 协议，不建立旁路状态。
- 运行状态优先于装饰，失败和中止必须可辨认。
- 配置以受限的本次运行草稿提交，密钥值和运行控制令牌不进入浏览器；原始输入正文不复制到 run。
- 默认只监听回环地址，适合可信单机操作。

## Evidence on Hand

命令、运行状态、看板读取与控制见 `apps/host/src/cli.ts`、`apps/host/src/dashboard.ts`、`packages/workflows/src/comparison/dashboard-view.ts`、`docs/usage.md`。

## Accessibility & Inclusion

看板应支持键盘操作、可见焦点、足够的文字对比度，并在窄屏下保持任务控制可用。
