from __future__ import annotations

import unittest
from pathlib import Path

from cnc_telegram_worker.vector import parse_svg_parts


FIXTURES = Path("/home/ovhtest/projects/erp_dev/spec_erp/artifacts_test/cutting_from_tg/dxf")
TELEGRAM_SVG_FIXTURES = Path(
    "/home/ovhtest/projects/erp_dev/spec_erp/artifacts_test/cutting_from_tg/cutting_svg_from_tg"
)


def count_items(items):
    counts: dict[tuple[str, int, float | None, float | None], int] = {}
    for item in items:
        key = (item.order_name, item.detail_number, item.width_mm, item.height_mm)
        counts[key] = counts.get(key, 0) + 1
    return counts


class VectorParserTest(unittest.TestCase):
    def test_extracts_part_rows_from_coreldraw_svg_metadata(self) -> None:
        items = parse_svg_parts(FIXTURES / "1200+1178+1197+1202.svg")
        counts = count_items(items)

        self.assertEqual(len(items), 9)
        self.assertEqual(counts[("1200", 16, 2215.0, 493.0)], 3)
        self.assertEqual(counts[("1178", 10, 360.0, 559.0)], 2)
        self.assertEqual(counts[("1197", 4, 760.0, 548.0)], 1)
        self.assertEqual(counts[("1202", 6, 530.0, 723.0)], 1)

    def test_extracts_path_part_contours_from_coreldraw_svg(self) -> None:
        items = parse_svg_parts(TELEGRAM_SVG_FIXTURES / "CNC#2_2712-LDSP.svg")
        counts = count_items(items)

        self.assertEqual(len(items), 3)
        self.assertEqual(counts[("2712", 4, 900.0, 1400.0)], 2)
        self.assertEqual(counts[("2712", 5, 1260.0, 1560.0)], 1)

    def test_extracts_mixed_rect_and_path_part_contours_from_coreldraw_svg(self) -> None:
        items = parse_svg_parts(TELEGRAM_SVG_FIXTURES / "CNC#1_2710+2711+2712.svg")
        counts = count_items(items)

        self.assertEqual(len(items), 17)
        self.assertEqual(counts[("2712", 6, 286.0, 764.0)], 1)
        self.assertEqual(counts[("2712", 2, 300.0, 1500.0)], 2)


if __name__ == "__main__":
    unittest.main()
