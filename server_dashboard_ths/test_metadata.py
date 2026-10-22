from copy import deepcopy
import math
import unittest

from metadata import normalize_meta, rued_to_difficulty
from test_dashboard import app, archive_row
from test_multi_agent import row as session_row
import multi_agent_inputs as worker


class MetadataTest(unittest.TestCase):
    def test_rued_matches_full_precision_formula_across_ranges(self):
        for R in range(9):
            for U in range(4):
                for E in range(8):
                    for D in (1, 2, 4, 20):
                        eta = .9783441714100146 * R + 1.5687846715589533 * U + .705878816282252 * E + 1.4419084167224514 * (D - 1)
                        score = 50 * (1 / (1 + math.exp(1.3944910557482442 - eta)) + 1 / (1 + math.exp(5.496550951538168 - eta)))
                        expected = "简单" if score <= 26.261252253428474 else "中等" if score <= 73.73874774657152 else "复杂"
                        self.assertEqual(rued_to_difficulty(R, U, E, D), {"difficulty": expected, "score": score})
        self.assertEqual(round(rued_to_difficulty(0, 0, 1, 1)["score"], 1), 17.1)
        self.assertNotEqual(rued_to_difficulty(0, 0, 1, 1)["score"], 17.1)
        self.assertEqual(rued_to_difficulty(0, 0, 0, 10**400)["score"], 100)

    def test_rued_rejects_bool_strings_floats_missing_and_out_of_range(self):
        for values in ((True, 0, 0, 1), ("1", 0, 0, 1), (1.0, 0, 0, 1), (9, 0, 0, 1),
                       (-1, 0, 0, 1), (0, 4, 0, 1), (0, 0, 8, 1), (0, 0, 0, 0)):
            with self.subTest(values=values), self.assertRaises(ValueError):
                rued_to_difficulty(*values)
        for rued in ({"R": 1}, [], {"R": False, "U": 0, "E": 0, "D": 1}):
            issues = []
            result = normalize_meta({"rued": rued}, issues)
            self.assertIsNone(result["difficulty_score"])
            self.assertNotIn("difficulty", result)
            self.assertEqual(issues[0]["reason"], "rued_invalid")

    def test_labels_fill_from_info_without_overwriting_existing_or_mutating_source(self):
        source = {"task": " 交易建议 ", "difficulty": "长程", "custom": {"keep": True},
                  "info": {"task": "数据查询", "subtask": " 时机 ", "difficulty": "复杂",
                           "rued": {"R": 0, "U": 0, "E": 1, "D": 1}, "rued_reason": {"E": "理由"}}}
        original = deepcopy(source)
        issues = []
        result = normalize_meta(source, issues)
        self.assertEqual(source, original)
        self.assertEqual((result["task"], result["subtask"], result["difficulty"]), ("交易建议", "时机", "长程"))
        self.assertEqual(result["rued_reason"], {"E": "理由"})
        self.assertEqual(round(result["difficulty_score"], 1), 17.1)
        self.assertEqual(result["info"], source["info"])
        self.assertEqual([issue["reason"] for issue in issues], ["metadata_conflict", "metadata_conflict", "difficulty_conflict"])
        self.assertEqual(normalize_meta({"info": {"difficulty": "中等", "difficulty_reason": "理由"}})["difficulty"], "中等")
        self.assertNotIn("difficulty", normalize_meta({}))

    def test_a_and_aa_efficiency_share_units_and_usage_unknown_is_not_zero(self):
        cases = [({"usage": {"input_tokens": 34828, "output_tokens": 813, "total_tokens": 35641,
                              "input_tokens_details": {"cached_tokens": 17856}, "type": "o3"}}, 35641, 17856),
                 ({"input_tokens": 74733, "output_tokens": 9259, "cached_read_tokens": None,
                   "usage": {"input_tokens": 74733, "output_tokens": 9259, "cached_read_tokens": None}}, 83992, None)]
        for metrics, total, cached in cases:
            source = {**metrics, "first_token_time_cost": 0, "first_answer_time_cost": 25543,
                      "finish_answer_time_cost": 28121, "cost": "28121ms", "first_cost": "0ms", "first_answer_cost": "25543ms"}
            issues = []
            result = normalize_meta(source, issues)
            self.assertEqual(issues, [])
            self.assertEqual(result["usage"]["total_tokens"], total)
            self.assertEqual(result["usage"]["input_tokens_details"]["cached_tokens"], cached)
            self.assertEqual([result[field] for field in ("first_token_time_cost", "first_answer_time_cost", "finish_answer_time_cost")], [0, 25543, 28121])
            for field in ("input_tokens", "output_tokens", "cached_read_tokens", "cost", "first_cost", "first_answer_cost"):
                self.assertNotIn(field, result)
        self.assertNotIn("finish_answer_time_cost", normalize_meta({"cost": "28121ms", "latency": 28.05}))

    def test_invalid_optional_metrics_warn_without_dropping_answer(self):
        issues = []
        result = normalize_meta({"first_token_time_cost": "1380ms", "answer_len": True, "has_visual": "false",
                                 "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 500,
                                           "cached_read_tokens": 101}}, issues)
        self.assertIsNone(result["first_token_time_cost"])
        self.assertIsNone(result["usage"]["total_tokens"])
        self.assertIsNone(result["usage"]["input_tokens_details"]["cached_tokens"])
        self.assertEqual(len(issues), 5)
        self.assertEqual(normalize_meta(result), result)
        self.assertEqual(normalize_meta({"usage": {"input_tokens": 0, "output_tokens": 0}})["usage"]["total_tokens"], 0)
        self.assertIsNone(normalize_meta({"usage": {"input_tokens": 100}})["usage"]["total_tokens"])
        self.assertIsNone(normalize_meta({"usage": {"input_tokens": 100, "output_tokens": 1, "total_tokens": "101"}})["usage"]["total_tokens"])

    def test_request_time_uses_timestamp_not_collection_anchor(self):
        with self.assertRaisesRegex(app.InvalidRecord, "request_time_missing"):
            app.request_day_and_value({}, {"ask_time": 1792664887809})
        self.assertEqual(app.request_day_and_value({}, {"timestamp_time": 1792664837095, "ask_time": 1}),
                         ("2026-10-22", "2026-10-22 18:27:17.095+08:00"))
        for timestamp in (True, "1792664837095", -1, 10**400):
            with self.assertRaisesRegex(app.InvalidRecord, "timestamp_time_invalid"):
                app.request_day_and_value({}, {"timestamp_time": timestamp})

    def test_every_cleaning_adapter_normalizes_metadata_preserving_messages(self):
        meta = {"rued": {"R": 0, "U": 0, "E": 1, "D": 1}, "first_token_time_cost": -1,
                "info": {"task": "交易建议"}}
        for model in ("a_fast", "b_fast", "b_post_train_fast", "6_luna"):
            source = archive_row(model, "one", meta_fields=deepcopy(meta))
            if model == "6_luna":
                for message in source["messages"]:
                    message["type"] = "message"
            issues = []
            _, cleaned = app.normalize_row(source, model, "batch.7z", "data.jsonl", 1, metadata_issues=issues)
            self.assertEqual(cleaned["meta"]["difficulty"], "简单")
            self.assertEqual(cleaned["messages"], source["messages"])
            self.assertEqual(issues[0]["field"], "meta.first_token_time_cost")
        for provider, mode in (("aime", "fast"), ("ifind", "normal_agent")):
            for traced in (False, True):
                source = session_row(provider, mode)
                source["meta"].update(deepcopy(meta))
                if traced:
                    source["traces"] = [{"meta": {}, "messages": source.pop("messages")}]
                original = deepcopy(source)
                issues = []
                _, _, cleaned = worker.normalize(source, provider, "batch.7z", "data.jsonl", 1, 1, issues)
                self.assertEqual(cleaned["meta"]["difficulty"], "简单")
                self.assertEqual(cleaned["meta"]["task"], "交易建议")
                self.assertEqual(source, original)
                self.assertEqual(len(issues), 1)
                field = "traces" if traced else "messages"
                self.assertEqual(cleaned[field], source[field])


if __name__ == "__main__":
    unittest.main()
