# 旧产物清理（2026-09-22）

删除以下旧版试跑目录与失效缓存：

- `eval_output/acceptance-batch`
- `eval_output/acceptance-debug`
- `eval_output/batch-20260922-v1`
- `eval_output/debug-20260922`
- `eval_output/release-v1`
- `eval_output/smoke-5`
- `.eval-cache/results`

释放约 207.7 MiB。保留原始输入、demo格式参考、Git初版提交、prime-agent版本检查记录及用户上传回执。

实现中删除了终止工具成功返回后的不可达收尾分支和重复的不可比较分支；旧验收文档由新版5条实跑记录替换。

新版首次启动遇到共享 daemon 的 create 超时，模型请求尚未发出；该次零成功、零模型用量的失败试跑目录也已删除。随后使用独立 daemon 重跑固定五条。
