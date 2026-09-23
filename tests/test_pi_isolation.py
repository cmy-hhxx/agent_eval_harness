from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import pytest

from pi_eval.core import load_config, read_json, write_json
from pi_eval.pi import prepare, prepared_pi, probe_pi

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("module,blocked", [("pi_eval", "prime_eval"), ("prime_eval", "pi_eval")])
def test_modules_import_without_the_other_engine(module, blocked):
    script = f"""
import importlib, importlib.abc, sys
class BlockOtherEngine(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == {blocked!r} or fullname.startswith({blocked!r} + '.'):
            raise ImportError('Other engine must not be imported: ' + fullname)
sys.meta_path.insert(0, BlockOtherEngine())
for name in ('cli', 'core', 'runner', 'annotations', 'presentation', 'summaries'):
    importlib.import_module({module!r} + '.' + name)
"""
    subprocess.run([sys.executable, "-c", script], cwd=ROOT, check=True, capture_output=True, text=True)


def test_defaults_preserve_evaluation_rules_but_use_independent_resources():
    from prime_eval.core import load_config as load_prime_config

    pi = load_config(ROOT / "configs/pi-eval.toml")
    prime = load_prime_config(ROOT / "configs/eval.toml")
    assert pi.prompts != prime.prompts
    assert pi.schema["properties"]["schema_version"]["const"] == "3.4"
    assert prime.schema["properties"]["schema_version"]["const"] == "3.3"
    assert pi.data["inputs"] == prime.data["inputs"]
    assert pi.data["execution"] == prime.data["execution"]
    assert pi.data["judge"]["api_key_env"] == prime.data["judge"]["api_key_env"] == "PRIME_EVAL_API_KEY"
    for stage in ("correctness", "pairwise"):
        assert pi.data["judge"][stage] == prime.data["judge"][stage]
    for kind in ("output_dir", "cache_dir", "extension", "schema"):
        assert pi.data["artifacts"][kind] != prime.data["artifacts"][kind]
    for name, path in pi.data["prompts"].items():
        assert Path(path).is_relative_to(ROOT / "pi_eval")
        assert path != prime.data["prompts"][name]
    assert pi.fingerprint() != prime.fingerprint()
    with pytest.raises(ValueError, match="pi_binary"):
        load_config(ROOT / "configs/eval.toml")


def test_prepare_pins_runtime_and_expires_without_updating_installation(tmp_path):
    config = load_config(ROOT / "configs/pi-eval.toml")
    package = tmp_path / "pi-package"
    write_json(package / "package.json", {"name": "@earendil-works/pi-coding-agent", "version": "0.86.1"})
    (package / "dist").mkdir()
    binary = package / "dist/cli.js"
    binary.write_text(f"#!{sys.executable}\nprint('0.86.1')\n")
    binary.chmod(0o755)
    runtime = package / "dist/rpc.js"
    runtime.write_text("// original runtime\n")
    config.data["judge"]["pi_binary"] = str(binary)
    config.data["artifacts"]["cache_dir"] = str(tmp_path / "cache")
    with pytest.raises(ValueError, match="prepare"):
        prepared_pi(config)
    prepared = prepare(config)
    assert prepared_pi(config) == {key: value for key, value in prepared.items() if key != "checked_at"}
    runtime.write_text("// changed runtime, same CLI and version\n")
    assert probe_pi(str(binary))["sha256"] != prepared["sha256"]
    with pytest.raises(ValueError, match="已变化"):
        prepared_pi(config)
    prepare(config)
    record_path = tmp_path / "cache/pi-prepared.json"
    record = read_json(record_path)
    write_json(record_path, {**record, "checked_at": time.time() - 86401})
    with pytest.raises(ValueError, match="已变化"):
        prepared_pi(config)
