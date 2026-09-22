from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from .core import build_plan, load_config
from .prime import prepare
from .runner import export_results, run_evaluation, validate_run


def main() -> int:
    parser = argparse.ArgumentParser(description="用本机 prime-agent 运行可追溯的两阶段比较评测")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("prepare", "preflight", "run"):
        sub = commands.add_parser(name)
        sub.add_argument("--config", type=Path, default=Path("configs/eval.toml"))
        if name == "prepare":
            sub.add_argument("--update-prime", action="store_true")
        else:
            sub.add_argument("--batch", action="append")
            sub.add_argument("--case", action="append")
            sub.add_argument("--limit-cases", type=int)
        if name == "run":
            sub.add_argument("--run-id")
            sub.add_argument("--resume", action="store_true")
            sub.add_argument("--retry-failed", action="store_true")
            sub.add_argument("--stage", choices=["all", "correctness", "pairwise"], default="all")
    for name in ("validate", "report"):
        commands.add_parser(name).add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    try:
        code = 0
        if args.command == "report":
            result = export_results(args.run.resolve())
        elif args.command == "validate":
            result = validate_run(args.run.resolve())
            code = 0 if result["valid"] else 2
        else:
            config = load_config(args.config)
            if args.command == "prepare":
                result = prepare(config, args.update_prime)
            else:
                if args.limit_cases is not None and args.limit_cases <= 0:
                    raise ValueError("--limit-cases 必须为正整数")
                plan = build_plan(config, args.batch, args.case, args.limit_cases)
                if args.command == "preflight":
                    result = plan.summary()
                    code = 2 if plan.issues else 0
                else:
                    if args.resume and not args.run_id:
                        raise ValueError("--resume 需要指定 --run-id")
                    if not plan.pairs:
                        raise ValueError("没有可评配对，请先查看 preflight")
                    run_id = args.run_id or datetime.now().strftime("%Y%m%d-%H%M%S")
                    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", run_id):
                        raise ValueError("run-id 只能含字母、数字、下划线、点、短横线")
                    run = Path(config.data["artifacts"]["output_dir"]) / run_id
                    # A lock protects atomic exports from another live runner, while resume survives crashes.
                    import fcntl
                    run.mkdir(parents=True, exist_ok=True)
                    with (run / ".lock").open("w") as lock:
                        try:
                            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        except BlockingIOError:
                            raise ValueError("该 run 正在运行，不能同时恢复") from None
                        result = asyncio.run(run_evaluation(config, plan, run, args.resume, args.retry_failed, args.stage))
                    statuses = result["task_statuses"]
                    code = 2 if statuses.get("failed") or statuses.get("blocked") or (statuses.get("pending") and args.stage != "correctness") else 0
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code
    except KeyboardInterrupt:
        print("运行已中断，已保存的任务可用 --resume 恢复。", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
