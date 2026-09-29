# 远程评测输入数据服务交接

## 远端目录

服务器上的 `/mnt/fin_bench/A_AA_comparision_data` 已准备好：

```text
0_process_code/                 处理程序、依赖、运行状态和日志
1_raw_zip_data/YYYY-MM-DD/      原始 .7z 压缩包
2_eval_data_input/<model>/      处理后的日期 JSONL
```

`1_raw_zip_data` 已建立 `2026-09-22` 至 `2026-10-07`（含）共 16 个日期目录；`2_eval_data_input` 下有 `a_fast`、`aa_fast`、`a_expert`、`aa_expert` 四个模型目录。输出直接使用 `<model>/<date>.jsonl`，不创建 `_daily`。

## 输入与处理

将完整压缩包放到对应日期目录，例如：

```text
/mnt/fin_bench/A_AA_comparision_data/1_raw_zip_data/2026-09-22/a8d6894058fa4b04.7z
```

每个压缩包需包含四类 JSONL 文件，文件名后缀分别为 `_A-fast.jsonl`、`_AA-fast.jsonl`、`_A-expert.jsonl`、`_AA-expert.jsonl`；压缩包内可有目录。处理程序约每 5 秒扫描一次，并等待压缩包大小和修改时间稳定后再处理。建议上传时先使用非 `.7z` 临时后缀，上传完成后再改为 `.7z`。

程序在 `0_process_code/app.py` 中用 `py7zr` 解压到临时目录，再逐行解析、转换并写入 JSONL；四份输出全部完成后才对外标记该日期可用。多个压缩包放在同一天时会按文件名顺序合并；已处理压缩包如需替换请使用新文件名，不要原名覆盖。程序只根据文件名、大小和修改时间发现变化，不计算内容哈希。记录保留原有内容，并补充/归一化 `request_time`、`batch_id`、`case_id`、模型 `version`、`has_standard_answer`、`trace_id` 和 `_source`；缺少 `batch_id` 时使用日期目录名。该日期压缩包缺任一模型文件或有无法解析的行时，不会发布为可取数据，原因写入 `0_process_code/service.log`。

## 取数接口

服务已启动，服务器内部监听 `8081`，外部端口映射为 `2256`，不需要鉴权：

- `GET http://117.50.195.94:2256/health`：服务状态。
- `GET http://117.50.195.94:2256/` 或 `/dates`：列出已完整处理、可取数的日期和模型。
- `GET http://117.50.195.94:2256/data/{date}/{model}.jsonl`：下载指定日期和模型的数据。模型名为 `a_fast`、`aa_fast`、`a_expert`、`aa_expert`。

例如：

```bash
curl -f http://117.50.195.94:2256/dates
curl -f -o 2026-09-22.jsonl \
  http://117.50.195.94:2256/data/2026-09-22/a_fast.jsonl
```

数据接口按 1 MiB 分块读取文件并流式返回，不会将整份 JSONL 载入内存。日期尚未完成处理时不会出现在 `/dates`，请求数据返回 404。当前原始目录还没有压缩包，因此 `/dates` 返回空列表是预期状态。

## 运行维护

程序、`py7zr` 依赖、处理状态、PID 和日志都在远端 `0_process_code/` 下。当前以 `nohup` 常驻运行，日志为 `service.log`；断开 SSH 不影响进程，但没有配置进程守护，服务器重启或进程退出后需手动重启。检查服务可访问 `/health`。如需重启，在服务器执行：

```bash
cd /mnt/fin_bench/A_AA_comparision_data/0_process_code
nohup python3 app.py >> service.log 2>&1 </dev/null &
echo $! > service.pid
```

## 验证记录

已验证远端 16 个日期目录和 4 个模型目录；使用四模型测试压缩包验证了自动处理、输出字段、`/dates` 和 JSONL 下载接口；已从本地连通性验证公网 `117.50.195.94:2256`。测试文件和测试输出已清理，当前没有已处理数据。
