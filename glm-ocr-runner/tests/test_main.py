from __future__ import annotations

import unittest

from app.main import normalize_result, parse_json_object


class GlmOcrRunnerTest(unittest.TestCase):
    def test_parse_json_object_extracts_object_from_text(self) -> None:
        self.assertEqual(parse_json_object("```json\n{\"items\": []}\n```"), {"items": []})

    def test_normalize_result_keeps_structured_fields_only(self) -> None:
        result = normalize_result({
            "items": [{
                "orderName": "2689",
                "detailNumber": "31",
                "widthMm": "497",
                "heightMm": 477,
                "quantity": "4",
                "confidence": 0.94,
                "rawText": "must not pass",
            }],
            "comments": [" ХДФ "],
            "analysisWarnings": ["warn"],
            "materialName": "ХДФ",
            "machine": "CNC#1",
            "dowelingLinks": [{"orderName": "2689", "dowelingNumber": "P12"}],
        })

        self.assertEqual(result, {
            "items": [{
                "sourceItemKey": "ocr:2689:31:497x477:0",
                "orderName": "2689",
                "detailNumber": 31,
                "widthMm": 497.0,
                "heightMm": 477.0,
                "quantity": 4,
                "confidence": 0.94,
            }],
            "comments": ["ХДФ"],
            "analysisWarnings": ["warn"],
            "materialName": "ХДФ",
            "machine": "CNC#1",
            "dowelingLinks": [{"orderName": "2689", "dowelingNumber": "P12"}],
        })

    def test_normalize_result_repairs_order_detail_swap(self) -> None:
        result = normalize_result({
            "items": [{
                "sourceItemKey": "2670",
                "orderName": "#17",
                "detailNumber": None,
                "quantity": 1,
            }],
        })

        self.assertEqual(result["items"][0]["orderName"], "2670")
        self.assertEqual(result["items"][0]["detailNumber"], 17)
        self.assertEqual(result["items"][0]["sourceItemKey"], "ocr:2670:17:0x0:0")


if __name__ == "__main__":
    unittest.main()
