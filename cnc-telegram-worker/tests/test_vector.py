from __future__ import annotations

import unittest
from tempfile import TemporaryDirectory
from pathlib import Path

from cnc_telegram_worker.vector import layout_to_dict, parse_svg_cut_layout, parse_svg_parts, parse_vector_file


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

    def test_valid_layout_uses_viewbox_scale_and_parent_transform(self) -> None:
        path = write_svg(
            """
            <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 10000 5000">
              <g transform="matrix(1 0 0 1 100 200)">
                <rect id="_1234_PartContour" width="2000" height="1000">
                  <metadata><odm name="Comments" value="1234#7#X@200*100@"/></metadata>
                </rect>
              </g>
            </svg>
            """
        )

        layout = parse_svg_cut_layout(path)

        self.assertEqual(layout.status, "valid")
        self.assertEqual(layout.sheet_width_mm, 1000.0)
        self.assertEqual(layout.sheet_height_mm, 500.0)
        self.assertEqual(len(layout.items), 1)
        self.assertEqual(layout.items[0].x_mm, 10.0)
        self.assertEqual(layout.items[0].y_mm, 20.0)
        self.assertEqual(layout.items[0].placed_width_mm, 200.0)
        self.assertEqual(layout.items[0].placed_height_mm, 100.0)

    def test_rejects_operation_only_svg_without_part_contours(self) -> None:
        path = write_svg(
            """
            <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 10000 5000">
              <rect id="__x007e__x007e_vyborka_1234" x="0" y="0" width="2000" height="1000">
                <metadata><odm name="Comments" value="1234#7#X@200*100@"/></metadata>
              </rect>
            </svg>
            """
        )

        layout = parse_svg_cut_layout(path)

        self.assertEqual(layout.status, "invalid")
        self.assertIn("no PartContour detail outlines", layout.reasons)
        self.assertEqual(parse_vector_file(path), [])

    def test_lenient_mode_extracts_visual_labels_and_source_svg(self) -> None:
        path = write_svg(
            """
            <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 1000 500">
              <g id="detail-a">
                <rect id="fallback-contour" x="20" y="30" width="200" height="100"/>
                <path id="milling" d="M40 50 L180 110"/>
                <text x="120" y="55">2723</text>
                <text x="120" y="80">дет. 7</text>
                <text x="120" y="105">200x100</text>
              </g>
            </svg>
            """
        )

        strict = parse_svg_cut_layout(path)
        layout = parse_svg_cut_layout(path, mode="lenient")
        item = layout_to_dict(layout)["items"][0]

        self.assertEqual(strict.status, "invalid")
        self.assertEqual(layout.status, "valid")
        self.assertEqual(len(layout.items), 1)
        self.assertEqual(item["orderName"], "2723")
        self.assertEqual(item["detailNumber"], 7)
        self.assertIn("sourceSvg", item)
        self.assertIn("<path", item["sourceSvg"]["body"])

    def test_rejects_part_contours_outside_sheet(self) -> None:
        path = write_svg(
            """
            <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 10000 5000">
              <rect id="_1234_PartContour" x="-1000" y="0" width="2000" height="1000">
                <metadata><odm name="Comments" value="1234#7#X@200*100@"/></metadata>
              </rect>
            </svg>
            """
        )

        layout = parse_svg_cut_layout(path)

        self.assertEqual(layout.status, "invalid")
        self.assertIn("PartContour detail outlines outside sheet", layout.reasons)
        self.assertEqual(parse_svg_parts(path), [])

    def test_rejects_whole_layout_when_any_detail_contour_is_outside_sheet(self) -> None:
        path = write_svg(
            """
            <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 10000 5000">
              <rect id="_1234_PartContour" x="0" y="0" width="2000" height="1000">
                <metadata><odm name="Comments" value="1234#7#X@200*100@"/></metadata>
              </rect>
              <rect id="_1234_PartContour_1" x="11000" y="0" width="2000" height="1000">
                <metadata><odm name="Comments" value="1234#8#X@200*100@"/></metadata>
              </rect>
            </svg>
            """
        )

        layout = parse_svg_cut_layout(path)

        self.assertEqual(layout.status, "invalid")
        self.assertIn("PartContour detail outlines outside sheet", layout.reasons)
        self.assertEqual(parse_svg_parts(path), [])
        self.assertEqual(layout_to_dict(layout)["items"], [])


def write_svg(content: str) -> Path:
    temp_dir = TemporaryDirectory()
    path = Path(temp_dir.name) / "layout.svg"
    path.write_text(content.strip(), encoding="utf-8")
    # Keep directory alive for the duration of the test process.
    _TEMP_DIRS.append(temp_dir)
    return path


_TEMP_DIRS: list[TemporaryDirectory[str]] = []


if __name__ == "__main__":
    unittest.main()
