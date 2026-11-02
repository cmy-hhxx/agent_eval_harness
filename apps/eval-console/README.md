# 评测控制台

[返回首页](../../README.md) · [部署](../../docs/deployment.md) · [运行与产物](../../docs/usage.md)

一个独立操作页，问财执行对比，AIME 执行归因。用户只修改评测输入、评测输出和并发；启动前预览这三项与只读日志位置，可以下载同样的业务配置。模型、双渠道、各阶段推理配置、超时与业务规则均来自服务器预设，不在页面提供调整入口。Eris 保持只读。

## 模块边界

页面在 `web/`；HTTP、任务管理、文件查询与评测适配在 `src/`；测试和配置样例也在本目录。模块单向使用 Host 的公开配置、预检、组装入口与通用 Workflow/Runtime/Data 能力，原 CLI、Worker 和 Eris 不依赖控制台。已有 case 跳过与动态模型请求额度属于评测底层能力，两种入口共用。

## 操作

1. 登录，选择问财或 AIME 及对应预设。
2. 每个模型填写服务器文件或目录；多个路径每行一个。填写输出目录和并发。
3. 预览确认后启动。重复提交同一个预览不会重复创建运行。
4. 运行中可暂停、继续、提高或降低并发；选择任务查看日志、错误详情和输出位置。

并发是单个任务两条内部渠道合计的真实模型请求上限。两条等价渠道可以借用空闲额度；多个任务的上限各自独立。提高并发同时扩大模型请求额度与调度容量。降低并发不取消在途请求，待它们完成后回落到新上限。

暂停停止派发新工作，已派发的评测工作完成并保存，期间显示“暂停中”。继续使用同一个任务；控制服务重启后不会自动发出模型请求，任务显示“已暂停”，由用户继续。

已有最终输出按模型（或模型对）、业务日期与 case 跳过，不要求旧 run、旧收据、原输入正文、配置或评测器版本匹配。Compact 等中间文件不算完成。若要对同 case 重新评测，选择另一个输出目录。旧结果保持原样，不补字段，不重新署名，也不伪造历史收据。

输出由用户指定，没有固定根目录限制。输入必须在该预设登记的输入范围内；输入输出不可重叠。预览检查文件存在与目录可写，并去掉目录名的数字前缀及 input/output/eval 等标记，轻量比对业务名称。名字未对应仅提示确认，不自动改路径。预检不调用模型，也不承诺逐行内容都有效。修改输入路径后，原配置中绑定旧文件的 records 清单会被清除，改为读取新指定的路径；保留路径时沿用原选择范围。

进度条显示当前已规划步骤的完成数量；AIME 分批读取时显示当前批次，后续输入尚未发现时不伪造全量百分比。暂停后保留进度，完成后显示完成状态。

## 部署

仅在服务器运行真实评测。本地可以构建与模拟测试。控制台使用独立 checkout，沿用已有 `config.ini`；新环境先完成 [Host 安装构建](../../docs/deployment.md#评测-host)。

复制 [config.example.json](config.example.json) 到外部配置目录，填写实际路径。`presets[].configs` 顺序与原评测的配置链一致，各文件相对路径按自身位置解析；输入白名单 `inputRoots`、管理员密码文件及状态/日志目录相对控制台配置文件解析。`concurrency` 是预设初始值。

管理员密码文件只保存密码，至少 16 位，限制文件权限为 `600`。文件不得提交到 Git。启动：

```bash
EVAL_CONFIG_FILE=/absolute/runtime/config/config.ini \
  npm run console -- --config /absolute/runtime/config/console.json
```

服务器入口为 `http://117.50.195.94:3928`，映射后端 `5004`；样例监听 `0.0.0.0:5004`。需要仅内网访问时改为本机监听并使用 SSH 转发。控制台页与 API 使用同一管理员身份，不修改旧评测进程。服务退出时等待自己管理的任务排空。

每个预览在 `stateDirectory/<任务ID>/` 保存完整的解析配置与任务元数据，不复制输入正文。日志只写 `logDirectory/runtime.log` 与 `logDirectory/evaluation.log`，Worker 沿用同一目录；两者仍由 Data 统一处理脱敏与写锁。隔离验证应使用独立状态目录和日志目录、低并发，以及独立测试输出。生产切换前由操作者停止旧任务；控制台不会代为接管。

## API

浏览器登录使用 HttpOnly、SameSite=Strict 会话 Cookie；写请求携带 `X-Console-Request: 1`。脚本可使用 `Authorization: Bearer <管理员密码>`。密码不放 URL。所有业务 API 均需认证。

| 方法与路径 | 用途 |
|---|---|
| `POST /api/login` | `{ "password": "…" }` 登录 |
| `POST /api/logout` | 退出 |
| `GET /api/presets` | 读取业务预设及四项摘要 |
| `POST /api/previews` | 校验并固定一次启动配置，不调用模型 |
| `POST /api/tasks` | `{ "previewId": "…" }` 启动已预览的配置 |
| `GET /api/tasks` | 非草稿任务、状态、在途数量及输出位置 |
| `GET /api/tasks/:id` | 单个任务 |
| `POST /api/tasks/:id/pause` | 排空在途工作后暂停 |
| `POST /api/tasks/:id/resume` | 继续缺失工作 |
| `POST /api/tasks/:id/concurrency` | `{ "concurrency": 8 }` 动态调整请求上限 |
| `GET /api/tasks/:id/configuration` | 下载业务配置与只读日志位置，可再次预览，不含模型参数或密钥 |
| `GET /api/tasks/:id/logs` | `kind=runtime\|evaluation`、`errors=1`、`cursor=字节位置` |

预览请求：

```json
{
  "preset": "aime-daily",
  "inputs": {
    "aime_fast": ["/absolute/aime/input/aime_fast/2026-11-01.jsonl"],
    "aime_expert": ["/absolute/aime/input/aime_expert/2026-11-01.jsonl"]
  },
  "output": "/absolute/aime/output/daily",
  "concurrency": 2
}
```

输入模型 ID 由预设返回，不由调用方猜测。日志按任务隔离展示，每次读取最多 1 MiB，返回 cursor 可继续查找更早记录；错误保留时间、阶段、任务/调用定位、原因和堆栈等现有字段。输入、启动、执行、持久化错误都会返回明确错误或进入运行日志；“部分完成”不冒充成功。
