from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .core import Config, Json, read_json, write_json


def save_presentation(run: Path, config: Config) -> None:
    """Freeze export settings separately from the judge's original audit schema."""
    names = {v["id"]: v.get("display_name", v["name"]) for v in config.versions}
    if (run / "manifest.json").exists():
        required = {r["version"] for task in read_json(run / "manifest.json")["tasks"] for r in task["candidates"].values()}
        if required - names.keys():
            raise ValueError("输出配置缺少运行中已有的版本，不能更新显示名称")
    write_json(run / "output_schema.json", config.schema)
    write_json(run / "version_names.json", names)


def version_names(run: Path) -> dict[str, str]:
    return read_json(run / "version_names.json")


def display_text(value: Any, names: dict[str, str]) -> Any:
    """Translate judge roles, never source quotations or substrings of Latin words."""
    if isinstance(value, list):
        return [display_text(item, names) for item in value]
    if isinstance(value, dict):
        return {key: child if key == "quote" else display_text(child, names) for key, child in value.items()}
    if not isinstance(value, str):
        return value
    # Bracketed handles are the current protocol. Bare roles support existing results.
    pattern = r"【候选([AB])】|候选\s*([AB])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])([AB])(?![A-Za-z0-9_]|股|类|级|轮|组)"
    return re.sub(pattern, lambda match: names[next(group for group in match.groups() if group)], value)


def role_names(task: Json, names: dict[str, str]) -> dict[str, str]:
    return {label: names[identity["version"]] for label, identity in task["candidates"].items()}
