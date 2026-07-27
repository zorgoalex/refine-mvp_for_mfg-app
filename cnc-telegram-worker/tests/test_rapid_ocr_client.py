from __future__ import annotations

import unittest

from cnc_telegram_worker.packet import normalize_ocr_items
from cnc_telegram_worker.rapid_ocr_client import parse_rapidocr_response


def line(text: str, x1: float, y1: float, x2: float, y2: float, score: float = 0.99) -> dict:
    return {"text": text, "score": score, "box": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]}


class RapidOcrClientParserTest(unittest.TestCase):
    def test_parses_repeated_2689_rows_into_aggregatable_items(self) -> None:
        response = parse_rapidocr_response({
            "lines": [
                *[line("2689", x, 51, x + 82, 87) for x in (33, 160, 285, 413)],
                *[line("#31", x, 80, x + 39, 101) for x in (54, 181, 307, 435)],
                *[line("497*477", x, 98, x + 70, 119) for x in (38, 166, 292, 420)],
                *[line("2689", x, 416, x + 82, 451) for x in (32, 161, 288, 416)],
                *[line("#27", x, 445, x + 41, 465) for x in (52, 180, 308, 435)],
                *[line("2242*477", x, 462, x + 78, 481) for x in (35, 163, 290, 418)],
            ],
        })

        items = normalize_ocr_items(response["items"])

        self.assertEqual(
            [(item["orderName"], item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"]) for item in items],
            [
                ("2689", 31, 497.0, 477.0, 4),
                ("2689", 27, 2242.0, 477.0, 4),
            ],
        )

    def test_splits_merged_order_and_compact_size_text(self) -> None:
        response = parse_rapidocr_response({
            "lines": [
                line("26782678", 24, 466, 223, 502),
                line("#41", 45, 495, 85, 515),
                line("#41", 160, 495, 206, 516),
                line("1866421", 27, 513, 106, 534),
                line("1866+421", 144, 513, 217, 534),
            ],
        })

        items = normalize_ocr_items(response["items"])

        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["orderName"], "2678")
        self.assertEqual(items[0]["detailNumber"], 41)
        self.assertEqual(items[0]["widthMm"], 1866.0)
        self.assertEqual(items[0]["heightMm"], 421.0)
        self.assertEqual(items[0]["quantity"], 2)

    def test_repairs_common_hash_misreads_for_detail_numbers(self) -> None:
        response = parse_rapidocr_response({
            "lines": [
                line("2690", 111, 99, 151, 118),
                line("1100°400", 111, 122, 150, 133),
                line("84", 123, 115, 138, 123, score=0.751),
                line("2677", 216, 273, 256, 290),
                line("2297*390", 218, 294, 257, 305),
                line("89", 229, 288, 244, 296, score=0.679),
                line("2689", 115, 148, 156, 166),
                line("497*477", 118, 170, 153, 182),
                line("824", 126, 161, 146, 172, score=0.808),
            ],
        })

        items = normalize_ocr_items(response["items"])

        self.assertIn(("2690", 4, 1100.0, 400.0, 1), [
            (item["orderName"], item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"])
            for item in items
        ])
        self.assertIn(("2677", 9, 2297.0, 390.0, 1), [
            (item["orderName"], item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"])
            for item in items
        ])
        self.assertIn(("2689", 24, 497.0, 477.0, 1), [
            (item["orderName"], item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"])
            for item in items
        ])

    def test_parses_combined_detail_and_order_line(self) -> None:
        response = parse_rapidocr_response({
            "lines": [
                line("2690", 265, 381, 306, 399),
                line("584*3507", 267, 401, 324, 418),
                line("#52690", 276, 394, 328, 408, score=0.789),
            ],
        })

        items = normalize_ocr_items(response["items"])

        self.assertEqual(
            [(item["orderName"], item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"]) for item in items],
            [("2690", 5, 584.0, 350.0, 1)],
        )

    def test_does_not_attach_neighbor_detail_label_across_cells(self) -> None:
        response = parse_rapidocr_response({
            "lines": [
                line("2704", 184, 232, 224, 249),
                line("587399", 187, 255, 220, 266),
                line("#5", 196, 248, 213, 256),
                line("2704", 234, 231, 276, 250),
                line("597*397", 237, 253, 272, 266),
            ],
        })

        items = normalize_ocr_items(response["items"])

        self.assertEqual(
            [(item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"]) for item in items],
            [(5, 587.0, 399.0, 1), (None, 597.0, 397.0, 1)],
        )

    def test_extracts_service_comments_material_and_doweling(self) -> None:
        response = parse_rapidocr_response({
            "lines": [
                line("ХДФ!!!", 72, 484, 124, 504),
                line("2690 весь. Присадка №1480", 73, 565, 285, 585),
            ],
        })

        self.assertEqual(response["materialName"], "ХДФ")
        self.assertEqual(response["comments"], ["ХДФ!!!", "2690 весь. Присадка №1480"])
        self.assertEqual(response["dowelingLinks"], [{"orderName": "2690", "dowelingNumber": "1480"}])


if __name__ == "__main__":
    unittest.main()
