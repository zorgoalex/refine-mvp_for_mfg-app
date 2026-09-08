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
        self.assertEqual(counts[("1178", 10, 559.0, 360.0)], 2)
        self.assertEqual(counts[("1197", 4, 760.0, 548.0)], 1)
        self.assertEqual(counts[("1202", 6, 723.0, 530.0)], 1)

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

    def test_preserves_printable_items_when_another_contour_is_outside_sheet(self) -> None:
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

        self.assertEqual(layout.status, "valid")
        self.assertIn("PartContour detail outlines outside sheet", layout.reasons)
        self.assertEqual(len(parse_svg_parts(path)), 1)
        self.assertEqual(len(layout_to_dict(layout)["items"]), 1)

    def test_visible_identity_and_size_override_conflicting_comments_in_both_modes(self):
        path = write_svg("""
        <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 1000 500">
          <rect id="PartContour" x="10" y="10" width="200" height="100">
            <metadata><odm name="Comments" value="9999#9#@900*800@"/></metadata>
          </rect>
          <text x="50" y="40">2872</text><text x="50" y="60"># 12</text><text x="50" y="80">201*101</text>
        </svg>""")
        for mode in ("strict", "lenient"):
            with self.subTest(mode=mode):
                layout = parse_svg_cut_layout(path, mode)
                self.assertEqual(layout.status, "valid")
                self.assertEqual(count_items(layout.items), {("2872", 12, 201.0, 101.0): 1})
                self.assertEqual(layout.items[0].placed_width_mm, 200)

    def test_metadata_identity_uses_real_geometry_before_comment_size(self):
        path = write_svg("""
        <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 1000 500">
          <rect id="PartContour" x="10" y="10" width="200" height="100">
            <metadata><odm name="Comments" value="2872#12#@900*800@"/></metadata>
          </rect>
        </svg>""")
        for mode in ("strict", "lenient"):
            layout = parse_svg_cut_layout(path, mode)
            self.assertEqual(layout.status, "valid")
            self.assertEqual(count_items(layout.items), {("2872", 12, 200.0, 100.0): 1})

    def test_mixed_sources_resolve_per_contour_and_geometry_fills_missing_label_size(self):
        path = write_svg("""
        <svg xmlns="http://www.w3.org/2000/svg" width="2000mm" height="500mm" viewBox="0 0 2000 500">
          <rect id="visual-PartContour" x="10" y="10" width="200" height="100">
            <metadata><odm name="Comments" value="9999#9#@900*800@"/></metadata>
          </rect>
          <text x="50" y="40">2872</text><text x="50" y="60"># 12</text>
          <rect id="comments-PartContour" x="1200" y="10" width="300" height="150">
            <metadata><odm name="Comments" value="2887#2#@900*800@"/></metadata>
          </rect>
        </svg>""")
        for mode in ("strict", "lenient"):
            layout = parse_svg_cut_layout(path, mode)
            self.assertEqual(layout.status, "valid")
            self.assertEqual(count_items(layout.items), {("2872", 12, 200.0, 100.0): 1, ("2887", 2, 300.0, 150.0): 1})

    def test_collapsed_contour_does_not_block_or_steal_good_detail_labels(self):
        path = write_svg("""
        <svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 1000 500">
          <rect id="good-PartContour" x="20" y="20" width="200" height="100"><metadata><odm name="Comments" value="2872#12#@900*800@"/></metadata></rect>
          <path id="collapsed-PartContour" d="M700 50 L700 50"/>
          <text x="700" y="40">2872</text><text x="700" y="60"># 13</text><text x="700" y="80">200*100</text>
        </svg>""")
        for mode in ("strict", "lenient"):
            layout = parse_svg_cut_layout(path, mode)
            self.assertEqual(layout.status, "valid")
            self.assertEqual(len(layout.items), 1)
            self.assertEqual(layout.items[0].detail_number, 12)
            self.assertIn("collapsed-PartContour", ";".join(layout.reasons))

    def test_supplied_stale_metadata_file_preserves_all_four_parts(self):
        path = Path(__file__).resolve().parents[2] / "tests/fixtures/svg-source-priority/stale-comment-size.svg"
        for mode in ("strict", "lenient"):
            layout = parse_svg_cut_layout(path, mode)
            self.assertEqual(layout.status, "valid")
            self.assertEqual(len(layout.items), 4)
            self.assertIn(("2872", 12, 1617.0, 412.0), count_items(layout.items))

    def test_supplied_test_position_does_not_block_other_labels(self):
        path = Path(__file__).resolve().parents[2] / "tests/fixtures/svg-source-priority/mixed-test-position.svg"
        for mode in ("strict", "lenient"):
            layout = parse_svg_cut_layout(path, mode)
            self.assertEqual(layout.status, "valid")
            self.assertEqual(len(layout.items), 20)
            self.assertTrue(layout.reasons)
            self.assertEqual(len(layout_to_dict(layout)["items"]), 20)


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
