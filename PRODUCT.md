# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: plain HTML/CSS/JavaScript served by the existing TypeScript Host; keep the service dependency-free and local-only.

## Users

评测 Host 的操作者，在可信的单机环境中启动、停止和续跑评测任务，并查看当前运行状态与有效配置。

## Product Purpose

这是一个可编排评测 Host。它读取 A / AA 输入，调度 Pi 或 Prime Worker，保存可恢复的评测结果。看板的成功标准是操作者无需盯住终端，就能知道运行是否健康、控制运行启停，并核对当前配置。

## Positioning

看板直接读取 Host 的运行状态和控制接口；它不是第二套调度器，也不复制输入或结果状态。

## Operating Context

服务运行在本机回环地址，操作者通过浏览器查看 `data/runs/pairwise` 中的运行。启动、停止和同 run ID 续跑沿用现有 CLI、run lock 与恢复规则。

## Capabilities and Constraints

看板需要展示运行列表、任务进度和只读配置，并允许以 Pi 或 Prime 启动新 run、停止运行和继续未完成 run。当前不提供远程访问、用户鉴权、任务级独立调度或配置编辑；Host 仍是唯一写入者。

## Product Principles

- 控制入口复用现有 Host 协议，不建立旁路状态。
- 运行状态优先于装饰，失败和中止必须可辨认。
- 配置只读展示，密钥和值不进入浏览器。
- 默认只监听回环地址，适合可信单机操作。

## Evidence on Hand

现有命令、运行状态和控制协议见 `apps/host/src/cli.ts`、`packages/host/src/runner.ts`、`docs/usage.md`；没有现成 Web UI 或品牌资产。

## Accessibility & Inclusion

看板应支持键盘操作、可见焦点、足够的文字对比度，并在窄屏下保持任务控制可用。
