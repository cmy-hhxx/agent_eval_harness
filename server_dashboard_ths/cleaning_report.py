"""Cleaning outcomes contain coordinates and reasons, never input bodies."""
from collections import Counter


class CleaningReport(Counter):
    def __init__(self):
        super().__init__()
        self.read = 0
        self.excluded = []
        self.file_errors = []
        self.metadata_issues = []

    def note_metadata(self, model, row, issues):
        self.metadata_issues.extend({"model": model, "case_id": row["case_id"],
                                     **row["_source"], **issue} for issue in issues)

    def lines(self, path, archive, member):
        try:
            with path.open("rb") as stream:
                yield from enumerate(stream, 1)
        except OSError as exc:
            self.file_errors.append({"original_file": f"{archive}/{member}", "reason": "file_read_failed", "error": str(exc)})

    def exclude(self, model, reason, archive, member, line=None, item=None, value=None):
        self[(model, reason)] += 1
        meta = value.get("meta", {}) if isinstance(value, dict) else {}
        meta = meta if isinstance(meta, dict) else {}
        case = (value.get("case_id") or meta.get("case_id") or meta.get("session_id")) if isinstance(value, dict) else None
        self.excluded.append({"model": model, "reason": reason,
                              "original_file": f"{archive}/{member}", "original_line": line,
                              "original_item": item, "case_id": str(case) if case is not None else None})

    def exclude_row(self, model, reason, row):
        source = row["_source"]
        archive, _, member = source["original_file"].partition("/")
        self.exclude(model, reason, archive, member, source.get("original_line"), source.get("original_item"), row)

    def finish(self, changes, pairs, output_dir, ready, error=None):
        accepted = []
        cases = {}
        counts = Counter((record.day, key[1]) for key, record in changes.items())
        positions = {scope: ready[scope[0]]["rows"][scope[1]] - count for scope, count in counts.items()}
        for key, record in changes.items():
            row = record.row
            accepted.append({"model": key[1], "batch_id": key[2], "case_id": key[3],
                             "date": record.day, "input_index": positions[(record.day, key[1])], **row["_source"],
                             "input_file": str(output_dir / key[1] / f"{record.day}.jsonl")})
            positions[(record.day, key[1])] += 1
            cases.setdefault((key[2], key[3]), set()).add(key[1])
        pair_counts = {name: sum(left in models and right in models for models in cases.values())
                       for name, (left, right) in pairs.items()}
        return {"read": self.read, "accepted": len(accepted), "excluded": len(self.excluded),
                "questions": len(cases), "pairs": pair_counts,
                "reasons": [{"model": model, "reason": reason, "count": count}
                            for (model, reason), count in sorted(self.items())],
                "records": accepted, "exclusions": self.excluded, "file_errors": self.file_errors, "error": error,
                "metadata_issue_count": len(self.metadata_issues), "metadata_issues": self.metadata_issues}
