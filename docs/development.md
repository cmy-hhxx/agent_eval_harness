# 开发指南

[返回首页](../README.md) · [仓库规则](../AGENTS.md) · [模块地图](modules/README.md)

## 修改路径

先定位职责，再同步实现、当前调用方、测试与文档。源码入口见模块地图；模型可见文字只改 [Prompts](../packages/prompts/README.md)，字段形状只改 [Schema](../schemas/README.md)，界面约束只写 [PRODUCT](../PRODUCT.md)。

### 禁止项目哈希与兼容层

[AGENTS.md](../AGENTS.md#当前契约优先)维护版本、冻结统计契约及兼容限制。A / B 输入适配、双 SDK 和同 run 续跑是当前功能。纯文档与无行为变化的测试整理不更新 `evaluatorVersion`；影响判词的变更必须更新。

## 验证

构建前停止活跃评测任务；构建不是整个应用的原子切换。

| 修改范围 | 检查 |
|---|---|
| 局部行为修复 | `npm run typecheck`，构建一次后仅运行直接覆盖改动的测试 |
| 评测契约、持久化或跨模块变更 | `npm run typecheck`、一次 `npm run test:full`，覆盖评测核心与 Host 集成 |
| Worker / SDK | `npm run test:integration` |
| 安装、构建、依赖 | `node scripts/test-clean.mjs`；本机环境用 `npm run doctor` |
| Eris 上游与浏览器 | [Eris 验证](../agent/README.md#验证) |

测试分组以 [scripts/test.mjs](../scripts/test.mjs) 和 [package.json](../package.json) 为准。`npm test` 和 `test:full` 使用 `build:test`，不构建 Eris 前端、不运行 Eris 用例；Eris 验证单独按其指南选择。完整核心最多并行两个文件，Host 集成按 CPU 数量最多并行四个文件；两组同时运行，快速组中的 Worker 预算回归单独运行。

不要把全测作为每次编辑或每次提交的机械门禁。已选全测时，不再叠加相同覆盖的 `npm test` 与目标回归；已有有效证据优先复用，不为证明已知缓慢而重跑旧版本。只有新改动、失败或尚未覆盖的具体风险才追加相关检查；失败只重跑修复涉及的用例，不自动重跑整套或延长超时。报告实际范围、耗时与未验证项。

测试只覆盖当前可观察行为：

- 修复确定性错误时，保留最小复现及对应正例；恢复、竞态、数据完整性和冻结契约的用例不能因篇幅长而删除。
- 删除被替代入口、旧格式、重复断言和未使用 fixture。不要用匹配源码片段或提示词句子代替行为验证。
- 通用提交样例使用 [tests/fixtures](../tests/fixtures/)；业务边界样例留在所属模块。只在确有重复时共享 helper，不建立通用测试框架。
- SDK 测试验证实际发出的提交格式；内部 canonical 判断和正式导出分别测试。独立核验显式构造首查与最终选择，不从待核判词反推。
- 临时资源注册清理，等待有界；不删除真实输入、结果或缓存。

类型检查包含未使用局部变量与参数；删除导出前还须检查公开入口、动态调用和测试引用。`test-clean` 在临时 checkout 独立安装与构建，不复用已安装依赖、构建或虚拟环境；npm 缓存独立，仅共享 Python 下载缓存。它只清理自身临时 checkout，`--debug` 可保留诊断。

## Git 提交与推送

远程地址、主副仓库角色、任务 ID 与提交信息格式统一由[仓库规则](../AGENTS.md#git-提交与双仓库推送)维护。GitCC 的提交信息校验在服务端钩子中执行；`git push --dry-run` 成功或 `Everything up-to-date` 只说明预检或当前引用状态，不能证明新提交会通过钩子。

### 提交前

1. 用 `git status --short --branch`、`git remote -v` 和差异确认当前分支、待提交文件与用户指定的推送目标。
2. 完成上面的[验证](#验证)，只暂存本次变更，检查 `git diff --cached --check` 与暂存差异。
3. 从创建提交时就使用约定格式，例如：

   ```bash
   git commit -m "dsw-98885 docs(git): document commit and push policy"
   ```

### 推送前与双边同步

对每个目标远程获取最新分支，检查它是本地 HEAD 的祖先，再逐条检查该目标尚未接收的提交信息。以下命令中的 `<远程>` 使用用户指定的远程名：

```bash
git fetch <远程> main
git merge-base --is-ancestor <远程>/main HEAD
git log --format='%h %s' <远程>/main..HEAD
```

发现分叉或不符合格式的提交时先处理原因。提交已经被任一远程接收后，历史改写按仓库规则单独授权。

用户明确要求两边同步时，完成两个目标的检查后依次执行：

```bash
git push origin main
git push gitcc main
```

两次推送之间保持同一个 HEAD；仅推一个目标时只执行对应命令。若某一边被拒绝，保留已有成功状态并报告拒绝原因与两端提交，不能将双边同步标为完成。

### 推送后验收

用 `git rev-parse HEAD` 取得本地提交，再对每个目标执行 `git ls-remote --heads <远程> main`；远端提交必须与本地一致。用 `git branch -vv` 确认 `main` 仍跟踪 `origin/main`，并通过 `git status --short --branch` 报告剩余工作区变更。

## 构建与依赖

安装和完整构建见 [README](../README.md#本地开发)。`build:pi` 可单独构建底座；版本与来源分别由 [mise.toml](../mise.toml)、[vendor/upstream.json](../vendor/upstream.json)维护。

根 workspace 和 Pi vendor workspace 使用独立依赖树。公共代码工具用根 `.venv`。修改 vendor 必须登记 `local_changes` 并重建。

`build:app` 先在临时目录编译和复制资源，再逐文件发布到 `dist/`，随后构建 Eris。编译阶段失败不改变旧产物，发布或后续失败可能留下部分更新。实现见 [build-app.mjs](../scripts/build-app.mjs)、[build-agent.mjs](../scripts/build-agent.mjs)和 [publishTree](../scripts/lib.mjs)。

Pi 源码检查用 `npm --prefix vendor/pi run check:sources`；上游 `check` 依赖已裁剪模型目录，不作为本项目回归入口。集成测试使用 `PI_OFFLINE=1`。

Eris 普通构建只读本仓库 [Deepseek 源码映射](../vendor/deepseek/sources.json)与[本地补丁](../vendor/deepseek/local.patch)。显式 `node scripts/vendor-deepseek.mjs <上游仓库>` 从干净的上游 checkout 同步选定源码与测试，不引入上游桌面构建。测试入口从 `agent/vitest.config.mjs` 读取，公开源导出与上游声明的 npm 依赖补丁随映射保存；本地改动清单以 `vendor/upstream.json` 为唯一维护位置。

`bootstrap`、Eris 构建和上游测试通过 `scripts/apply-agent-dependency-patches.mjs` 应用这些 npm 补丁。安装包的名称、版本和补丁内容必须匹配；已经应用时保持幂等，不匹配直接失败。补丁文件保留原始上下文，源码继续接受空白检查。

## 文档维护

| 内容 | 唯一维护位置 |
|---|---|
| 导航与首次安装 | README |
| 仓库约束 | AGENTS |
| 操作、恢复、产物 | 使用指南与 Eris 指南 |
| 字段与语义边界 | Schema、数据契约 |
| 依赖、接口、生命周期 | 架构、模块地图 |
| 界面与验收 | PRODUCT、评测质量 |

修改现有条目，不在文末追加补丁说明。同一事实只解释一次；默认值、字段全集和工具参数链接到配置、类型或 Schema。长期文档不记录完成清单、某次测试数量、个人绝对路径或逐次故障经过；历史交给 Git，临时验证放 `.artifacts/`。

文档链接和锚点由架构测试检查；所有项目自有说明须从 README 可达。提示词资源是运行输入，历史研究快照是报告材料，各自按模块入口维护，不与当前操作规则混写。测试能拦截断链，事实过期仍须在每次行为变更时对照实现审查。
