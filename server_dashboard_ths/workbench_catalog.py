"""Task/package index over the existing data-service publication engine."""
from contextlib import contextmanager
from copy import copy
import json
from pathlib import Path
import sqlite3
import sys
import threading
import time
from uuid import uuid4


class Conflict(ValueError):
    pass


class WorkbenchCatalog:
    def __init__(self, datasets, state_root, engine):
        self.datasets = datasets
        self.engine = engine
        self.path = Path(state_root) / "workbench.sqlite"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.cleaning = threading.Lock()
        self.clean_jobs = {}
        self.observed = {}
        self.stop = threading.Event()
        self.origins = {key: value for key, value in datasets.items() if not key.startswith("/data/task-")}
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
                    category TEXT NOT NULL, profile TEXT NOT NULL, dataset TEXT NOT NULL UNIQUE,
                    origin TEXT NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS routes (origin TEXT PRIMARY KEY, task_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS batches (
                    id TEXT PRIMARY KEY, origin TEXT NOT NULL, name TEXT NOT NULL,
                    size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, task_id TEXT,
                    status TEXT NOT NULL, discovered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    error TEXT, report TEXT, revises TEXT,
                    UNIQUE(origin, name, size, mtime_ns)
                );
            ''')
            labels = {"wencai": "问财日常评测", "post_training_model": "后训练评测", "aime": "AIME 日常评测", "ifind": "ifind 评测"}
            for origin, dataset in self.origins.items():
                key = origin.rsplit("/", 1)[-1]
                if db.execute("SELECT 1 FROM routes WHERE origin=?", (origin,)).fetchone():
                    if key in ("wencai", "aime"):
                        db.execute("UPDATE tasks SET category='daily' WHERE dataset=? AND origin=?", (origin, origin))
                    continue
                source = "wencai" if key in ("wencai", "post_training_model") else key
                task = (str(uuid4()), labels.get(key, key), source, "daily" if key in ("wencai", "aime") else "task",
                        "post_training_model" if key == "post_training_model" else source, origin, origin, self.now())
                db.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)", task)
                db.execute("INSERT INTO routes VALUES (?,?)", (origin, task[0]))
            # A process interruption is retryable, not evidence of a failed publication.
            db.execute("UPDATE batches SET status='interrupted', error='清洗进程中断' WHERE status IN ('cleaning','queued')")
            tasks = [dict(row) for row in db.execute("SELECT * FROM tasks")]
        for task in tasks:
            dataset = self.dataset(task)
            if task["dataset"] != task["origin"]:
                self.origins[task["dataset"]] = dataset

    @staticmethod
    def now():
        return int(time.time() * 1000)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def dataset(self, task):
        if task["dataset"] in self.datasets:
            return self.datasets[task["dataset"]]
        base = self.origins[task["origin"]]
        state = self.path.parent / "tasks" / task["id"]
        archive = base.root / "1_7z_data" / task["id"]
        output = base.root / ("2_daily_eval_input" if task["category"] == "daily" else "5_multi_task_eval_input") / task["id"]
        if task["source"] == "wencai":
            post = task["profile"] == "post_training_model"
            dataset = self.engine.Dataset(base.root, state,
                self.engine.POST_TRAINING_MODELS if post else self.engine.ROOT_MODELS,
                "post_training_model" if post else "", archive_dir=archive,
                output_dir=output, url_prefix=task["dataset"])
        else:
            from multi_agent_inputs import AgentDataset
            dataset = AgentDataset(base.root.parent, state.parent, task["source"], task["dataset"])
            dataset.state_dir = state
            dataset.progress_file = state / "evaluation-progress.json"
            dataset.root_archive_state_file = state / "root-archives.json"
            dataset.output_dir = output
            dataset.archive_dir = archive
        dataset.archive_dir.mkdir(parents=True, exist_ok=True)
        dataset.state_dir.mkdir(parents=True, exist_ok=True)
        self.datasets[task["dataset"]] = dataset
        return dataset

    def create_task(self, value):
        if not isinstance(value, dict) or set(value) != {"name", "source", "category", "profile"}:
            raise ValueError("任务字段必须为 name、source、category、profile")
        name, source, category, profile = (value[key] for key in ("name", "source", "category", "profile"))
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
            raise ValueError("任务名称须为 1–120 个字符")
        if source not in ("wencai", "aime", "ifind") or category not in ("daily", "task"):
            raise ValueError("来源或评测类型无效")
        if profile not in (("wencai", "post_training_model") if source == "wencai" else (source,)):
            raise ValueError("输入模型组不属于所选来源")
        origin = "/data/" + profile
        if origin not in self.origins:
            raise ValueError("来源目录未配置")
        identifier = str(uuid4())
        task = dict(id=identifier, name=name.strip(), source=source, category=category, profile=profile,
                    dataset="/data/task-" + identifier, origin=origin, created_at=self.now())
        with self.lock, self.db() as db:
            db.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)", tuple(task.values()))
            dataset = self.dataset(task)
            self.origins[task["dataset"]] = dataset
            db.execute("INSERT INTO routes VALUES (?,?)", (task["dataset"], identifier))
        return {**task, "archive_dir": str(dataset.archive_dir)}

    def discover(self):
        with self.lock, self.db() as db:
            for origin, dataset in self.origins.items():
                writers = dataset.open_archive_writers()
                route = db.execute("SELECT task_id FROM routes WHERE origin=?", (origin,)).fetchone()
                for info in self.engine.archive_signature(dataset.archive_dir):
                    identity = (origin, info["name"], info["size"], info["mtime_ns"])
                    observed = self.observed.setdefault(identity, time.monotonic())
                    stable = (time.monotonic() - observed >= self.engine.STABLE_SECONDS and
                              info["name"] not in writers)
                    row = db.execute("SELECT * FROM batches WHERE origin=? AND name=? AND size=? AND mtime_ns=?", identity).fetchone()
                    if row is None:
                        old = db.execute("SELECT * FROM batches WHERE origin=? AND name=? ORDER BY discovered_at DESC,rowid DESC LIMIT 1", identity[:2]).fetchone()
                        if old and old["status"] == "uploading":
                            db.execute("UPDATE batches SET size=?,mtime_ns=?,updated_at=? WHERE id=?", (info["size"], info["mtime_ns"], self.now(), old["id"]))
                            continue
                        # A revised package needs a new task/range; do not merge it into published inputs automatically.
                        task_id = None if old else (route[0] if route else None)
                        status = "ready" if stable else "uploading"
                        db.execute("INSERT INTO batches VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                                   (str(uuid4()), *identity, task_id, status, self.now(), self.now(), None, None, old["id"] if old else None))
                    elif row["status"] == "uploading" and stable:
                        db.execute("UPDATE batches SET status='ready',updated_at=? WHERE id=?", (self.now(), row["id"]))
                    current = db.execute("SELECT * FROM batches WHERE origin=? AND name=? AND size=? AND mtime_ns=?", identity).fetchone()
                    if current and current["task_id"] and current["status"] in ("uploading", "ready", "interrupted", "failed"):
                        self.sync_published_batch(db, current)

    def sync_published_batch(self, db, batch):
        """Observe a specialized ingester's committed receipt without running another cleaner."""
        if db.execute("SELECT 1 FROM batches WHERE task_id=? AND name=? AND origin<>? LIMIT 1",
                      (batch["task_id"], batch["name"], batch["origin"])).fetchone():
            return
        task = dict(db.execute("SELECT * FROM tasks WHERE id=?", (batch["task_id"],)).fetchone())
        dataset = self.dataset(task)
        index = dataset.state_dir / "archive-records.sqlite"
        if not index.is_file() or not dataset.root_archive_state_file.is_file():
            return
        expected = {key: batch[key] for key in ("name", "size", "mtime_ns")}
        if expected not in dataset.load_archive_state()["archives"]:
            return
        source = sqlite3.connect(index.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            if source.execute("SELECT 1 FROM pending").fetchone():
                return
            saved = source.execute("SELECT report FROM cleaning_reports WHERE name=? AND size=? AND mtime_ns=?",
                                   (batch["name"], batch["size"], batch["mtime_ns"])).fetchone()
        finally:
            source.close()
        if saved:
            report = json.loads(saved[0])
            if any(dataset.ready_state(day) is None for day in {record["date"] for record in report["records"]}):
                return
            self.save_report(db, batch["id"], report)

    def save_report(self, db, identifier, report):
        status = "failed" if report["error"] else "partial" if report["file_errors"] else "cleaned" if report["accepted"] else "empty"
        summary = {key: value for key, value in report.items() if key not in ("records", "exclusions", "metadata_issues")}
        db.execute("UPDATE batches SET status=?,report=?,error=?,updated_at=? WHERE id=?",
                   (status, json.dumps(summary), report["error"], self.now(), identifier))

    def assign(self, value):
        if not isinstance(value, dict) or set(value) != {"batch_ids", "task_id"}:
            raise ValueError("归属字段无效")
        identifiers = self.identifiers(value["batch_ids"])
        with self.lock, self.db() as db:
            task = db.execute("SELECT * FROM tasks WHERE id=?", (value["task_id"],)).fetchone()
            if not task:
                raise ValueError("任务不存在")
            for identifier in identifiers:
                batch = db.execute("SELECT * FROM batches WHERE id=?", (identifier,)).fetchone()
                if not batch:
                    raise ValueError("批次不存在")
                kind = self.origins[batch["origin"]].kind
                source = "wencai" if kind in ("", "post_training_model") else kind
                collision = db.execute("SELECT 1 FROM batches WHERE task_id=? AND name=? AND origin<>? LIMIT 1",
                                       (task["id"], batch["name"], batch["origin"])).fetchone()
                if collision:
                    raise Conflict("任务已有来自其他目录的同名包，请使用独立任务区分")
                if source != task["source"]:
                    raise ValueError("批次与任务来源不同")
                if batch["status"] not in ("uploading", "ready", "failed", "interrupted") or batch["report"]:
                    raise Conflict("已清洗或执行中的批次不能更换归属")
            for identifier in identifiers:
                db.execute("UPDATE batches SET task_id=?,updated_at=? WHERE id=?", (task["id"], self.now(), identifier))
        return {"assigned": len(identifiers)}

    @staticmethod
    def identifiers(value):
        if not isinstance(value, list) or not 1 <= len(value) <= 200 or any(not isinstance(item, str) for item in value) or len(set(value)) != len(value):
            raise ValueError("须选择 1–200 个不重复批次")
        return value

    def snapshot(self, query):
        self.discover()
        page = int(query.get("page", ["1"])[0])
        if page < 1:
            raise ValueError("页码无效")
        filters, values = [], []
        for name, column in (("source", "t.source"), ("category", "t.category"), ("task", "b.task_id"), ("status", "b.status")):
            value = query.get(name, [""])[0]
            if value:
                filters.append(column + "=?")
                values.append(value)
        if query.get("unassigned", [""])[0] == "true":
            filters.append("b.task_id IS NULL")
        where = " WHERE " + " AND ".join(filters) if filters else ""
        joined = " FROM batches b LEFT JOIN tasks t ON t.id=b.task_id" + where
        with self.lock, self.db() as db:
            tasks = [{**dict(row), "archive_dir": str(self.dataset(dict(row)).archive_dir)} for row in db.execute("SELECT * FROM tasks ORDER BY created_at,id")]
            total = db.execute("SELECT count(*)" + joined, values).fetchone()[0]
            rows = db.execute("SELECT b.*,t.name AS task_name,t.source,t.category,t.dataset" + joined +
                              " ORDER BY b.discovered_at DESC,b.id LIMIT 50 OFFSET ?", [*values, (page - 1) * 50]).fetchall()
            batches = []
            for row in rows:
                item = dict(row)
                saved = item.pop("report")
                report = json.loads(saved) if saved else None
                item["summary"] = {key: value for key, value in report.items() if key not in ("records", "exclusions", "metadata_issues")} if report else None
                item["archive_path"] = str(self.origins[item["origin"]].archive_dir / item["name"])
                batches.append(item)
            routes = [dict(row) for row in db.execute("SELECT * FROM routes")]
        return {"tasks": tasks, "batches": batches, "page": page, "page_size": 50, "total": total,
                "routes": [{**route, "archive_dir": str(self.origins[route["origin"]].archive_dir)} for route in routes]}

    def report(self, identifier, query):
        page = int(query.get("page", ["1"])[0])
        section = query.get("section", ["exclusions"])[0]
        if page < 1 or section not in ("exclusions", "records", "metadata_issues"):
            raise ValueError("报告分页参数无效")
        with self.lock, self.db() as db:
            row = db.execute("SELECT * FROM batches WHERE id=?", (identifier,)).fetchone()
            if not row:
                raise KeyError("批次不存在")
            if not row["report"]:
                raise Conflict("清洗报告尚未生成")
            report = self.published_report(dict(row))
        records = report[section]
        return {"batch_id": identifier, "archive_path": str(self.origins[row["origin"]].archive_dir / row["name"]),
                "status": row["status"], "summary": {k: v for k, v in report.items() if k not in ("records", "exclusions", "metadata_issues")},
                "section": section, "page": page, "page_size": 50, "total": len(records), "items": records[(page-1)*50:page*50]}

    def published_report(self, batch):
        with self.db() as db:
            task = dict(db.execute("SELECT * FROM tasks WHERE id=?", (batch["task_id"],)).fetchone())
        db = self.dataset(task).open_archive_index()
        try:
            saved = db.execute("SELECT report FROM cleaning_reports WHERE name=? AND size=? AND mtime_ns=?",
                               (batch["name"], batch["size"], batch["mtime_ns"])).fetchone()
            if saved is None:
                raise Conflict("清洗报告缺失")
            return json.loads(saved[0])
        finally:
            db.close()

    def evaluation_scope(self, value):
        identifiers = value.get("batch_ids") if isinstance(value, dict) else None
        if (not isinstance(identifiers, list) or not 1 <= len(identifiers) <= 200 or
                any(not isinstance(item, str) for item in identifiers) or len(set(identifiers)) != len(identifiers)):
            raise ValueError("选择 1–200 个不同批次")
        with self.lock, self.db() as db:
            batches = []
            for identifier in identifiers:
                row = db.execute("SELECT * FROM batches WHERE id=?", (identifier,)).fetchone()
                if not row:
                    raise KeyError("批次不存在")
                if row["status"] not in ("cleaned", "partial") or not row["report"]:
                    raise Conflict("批次尚未完成清洗")
                batches.append(dict(row))
            if len({batch["task_id"] for batch in batches}) != 1:
                raise ValueError("一次运行只能选择同一任务的批次")
            task = dict(db.execute("SELECT * FROM tasks WHERE id=?", (batches[0]["task_id"],)).fetchone())
            dataset = self.dataset(task)
            records = []
            ready = {}
            for batch in batches:
                for record in self.published_report(batch)["records"]:
                    ready.setdefault(record["date"], dataset.ready_state(record["date"]))
                    if ready[record["date"]] is None:
                        raise Conflict("输入发布中或尚未就绪")
                    records.append({**record, "package_id": batch["id"], "package_name": batch["name"]})
            if not records:
                raise Conflict("没有有效回答，不能启动空评测")
            output = dataset.root / "eval_output" / ("0_daily_eval" if task["category"] == "daily" else "1_task_eval") / task["id"]
            return {"task": task, "batch_ids": identifiers, "records": records,
                    "models": list(dataset.models), "comparisons": list(dataset.pairs.values()),
                    "output_dir": str(output)}

    def sample(self, identifier, query):
        index = int(query.get("index", ["-1"])[0])
        with self.lock, self.db() as db:
            batch = db.execute("SELECT * FROM batches WHERE id=?", (identifier,)).fetchone()
            if not batch or not batch["report"]:
                raise KeyError("批次报告不存在")
            task = dict(db.execute("SELECT * FROM tasks WHERE id=?", (batch["task_id"],)).fetchone())
            records = self.published_report(dict(batch))["records"]
        if not 0 <= index < len(records):
            raise ValueError("样本位置无效")
        location = records[index]
        dataset = self.dataset(task)
        state = dataset.ready_state(location["date"])
        if state is None:
            raise Conflict("输入文件已变化或尚未就绪")
        path = dataset.output_dir / location["model"] / f"{location['date']}.jsonl"
        positions = json.loads(dataset.record_index_path(location["date"], location["model"]).read_text())
        metadata = state["files"][location["model"]]
        if any(positions.get(key) != metadata[key] for key in ("size_bytes", "mtime_ns")):
            raise Conflict("样本偏移索引已失效")
        offset, length = positions["offsets"][location["input_index"]]
        if type(offset) is not int or type(length) is not int or offset < 0 or length < 1:
            raise Conflict("样本偏移索引无效")
        with path.open("rb") as stream:
            stream.seek(offset)
            row = json.loads(stream.read(length))
        identity = (row.get("case_id"), row.get("batch_id"), row.get("_source", {}).get("original_file"))
        if identity != (location["case_id"], location["batch_id"], location["original_file"]):
            raise Conflict("报告与输入样本身份不一致")
        if dataset.ready_state(location["date"]) != state:
            raise Conflict("输入在读取期间发生变化")
        found = self.engine.visible_record(row)
        return {"record": found, "location": location}

    def start_clean(self, value, background=True):
        if not isinstance(value, dict) or set(value) != {"batch_ids"}:
            raise ValueError("清洗字段无效")
        identifiers = self.identifiers(value["batch_ids"])
        self.discover()
        if not self.cleaning.acquire(blocking=False):
            raise Conflict("已有清洗正在执行")
        try:
            with self.lock, self.db() as db:
                for identifier in identifiers:
                    row = db.execute("SELECT * FROM batches WHERE id=?", (identifier,)).fetchone()
                    if not row or not row["task_id"]:
                        raise ValueError("批次不存在或尚未归属任务")
                    if row["status"] not in ("ready", "failed", "interrupted"):
                        raise Conflict("批次尚未稳定或已经清洗")
                    self.check_file(row)
                for identifier in identifiers:
                    db.execute("UPDATE batches SET status='queued',error=NULL,updated_at=? WHERE id=?", (self.now(), identifier))
        except BaseException:
            self.cleaning.release()
            raise
        if background:
            threading.Thread(target=self.clean, args=(identifiers,), name="workbench-cleaning", daemon=True).start()
        else:
            self.clean(identifiers)
        return {"batch_ids": identifiers, "status": "queued"}

    def clean_status(self, task_id):
        with self.lock, self.db() as db:
            if not db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                raise KeyError("任务不存在")
            job = self.clean_jobs.get(task_id)
            if job is None:
                return {"task_id": task_id, "status": "idle", "batch_ids": [], "current_batch_id": None, "completed": 0, "remaining": 0}
            return {key: value for key, value in job.items() if not key.startswith("_")}

    def start_task_clean(self, task_id, value, background=True):
        if not isinstance(value, dict) or value:
            raise ValueError("任务清洗请求必须为空对象")
        self.discover()
        with self.lock:
            previous = self.clean_jobs.get(task_id)
            if previous and previous["status"] in ("queued", "running", "stopping", "cancelling"):
                return self.clean_status(task_id)
            if not self.cleaning.acquire(blocking=False):
                raise Conflict("已有清洗正在执行")
            try:
                with self.db() as db:
                    if not db.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                        raise KeyError("任务不存在")
                    identifiers = [row[0] for row in db.execute(
                        "SELECT id FROM batches WHERE task_id=? AND status IN ('ready','interrupted') AND report IS NULL ORDER BY discovered_at,id", (task_id,))]
                    for identifier in identifiers:
                        db.execute("UPDATE batches SET status='queued',error=NULL,updated_at=? WHERE id=?", (self.now(), identifier))
                job = {"task_id": task_id, "status": "queued" if identifiers else "idle", "batch_ids": identifiers,
                       "current_batch_id": None, "completed": 0, "remaining": len(identifiers),
                       "_stop": False, "_cancel": threading.Event()}
                self.clean_jobs[task_id] = job
            except BaseException:
                self.cleaning.release()
                raise
        if not identifiers:
            self.cleaning.release()
        elif background:
            threading.Thread(target=self.clean, args=(identifiers, job), name="workbench-task-cleaning", daemon=True).start()
        else:
            self.clean(identifiers, job)
        return self.clean_status(task_id)

    def stop_task_clean(self, task_id, value, cancel=False):
        if not isinstance(value, dict) or value:
            raise ValueError("停止清洗请求必须为空对象")
        with self.lock:
            status = self.clean_status(task_id)
            job = self.clean_jobs.get(task_id)
            if job and status["status"] in ("queued", "running", "stopping", "cancelling"):
                job["_stop"] = True
                if cancel:
                    job["_cancel"].set()
                job["status"] = "cancelling" if job["_cancel"].is_set() else "stopping"
            return self.clean_status(task_id)

    def check_file(self, batch):
        dataset = self.origins[batch["origin"]]
        expected = {key: batch[key] for key in ("name", "size", "mtime_ns")}
        if self.engine.file_signature(dataset.archive_dir / batch["name"]) != expected:
            raise Conflict("压缩包已变化或不可用，请刷新并选择新批次")
        if batch["name"] in dataset.open_archive_writers():
            raise Conflict("压缩包仍在写入")
        return expected

    def clean(self, identifiers, job=None):
        try:
            for identifier in identifiers:
                with self.lock:
                    if job and (self.stop.is_set() or job["_stop"]):
                        break
                    if job:
                        job["status"] = "running"
                        job["current_batch_id"] = identifier
                try:
                    with self.lock, self.db() as db:
                        batch = dict(db.execute("SELECT * FROM batches WHERE id=?", (identifier,)).fetchone())
                        task = dict(db.execute("SELECT * FROM tasks WHERE id=?", (batch["task_id"],)).fetchone())
                        collision = db.execute("SELECT 1 FROM batches WHERE task_id=? AND name=? AND origin<>? LIMIT 1",
                                               (task["id"], batch["name"], batch["origin"])).fetchone()
                        if collision:
                            raise Conflict("任务已有来自其他目录的同名包，请使用独立任务区分")
                        db.execute("UPDATE batches SET status='cleaning',updated_at=? WHERE id=?", (self.now(), identifier))
                    dataset = copy(self.dataset(task))
                    dataset.clean_cancel = job["_cancel"] if job else None
                    dataset.check_clean_cancelled()
                    info = self.check_file(batch)
                    with dataset.archive_lock():
                        original_archive_dir = dataset.archive_dir
                        try:
                            dataset.archive_dir = self.origins[batch["origin"]].archive_dir
                            dataset.recover()
                            dataset.check_clean_cancelled()
                            dataset.process_archives([info], retry_failed=True)
                            db = dataset.open_archive_index()
                            try:
                                saved = db.execute("SELECT report FROM cleaning_reports WHERE name=? AND size=? AND mtime_ns=?",
                                                   (info["name"], info["size"], info["mtime_ns"])).fetchone()
                            finally:
                                db.close()
                        finally:
                            dataset.archive_dir = original_archive_dir
                    if not saved:
                        raise Conflict("没有本批次清洗报告；输入可能已变化，不能推测处理结果")
                    report = json.loads(saved[0])
                    with self.lock, self.db() as db:
                        self.save_report(db, identifier, report)
                except InterruptedError:
                    with self.lock, self.db() as db:
                        db.execute("UPDATE batches SET status='interrupted',error='清洗已取消',updated_at=? WHERE id=?", (self.now(), identifier))
                    break
                except Exception as exc:
                    print(f"cleaning batch {identifier} failed: {exc}", file=sys.stderr, flush=True)
                    with self.lock, self.db() as db:
                        db.execute("UPDATE batches SET status='failed',error=?,updated_at=? WHERE id=?", (str(exc), self.now(), identifier))
                with self.lock:
                    if job:
                        job["completed"] += 1
                        job["remaining"] -= 1
                        job["current_batch_id"] = None
        finally:
            try:
                with self.lock, self.db() as db:
                    for identifier in identifiers:
                        db.execute("UPDATE batches SET status='ready',updated_at=? WHERE id=? AND status='queued'", (self.now(), identifier))
                    if job:
                        job["current_batch_id"] = None
                        job["status"] = "cancelled" if job["_cancel"].is_set() else "stopped" if job["_stop"] or self.stop.is_set() else "finished"
            finally:
                self.cleaning.release()

    def loop(self):
        while not self.stop.is_set():
            try:
                self.discover()
            except Exception as exc:
                print(f"workbench discovery error: {exc}", file=sys.stderr, flush=True)
            self.stop.wait(self.engine.POLL_SECONDS)
