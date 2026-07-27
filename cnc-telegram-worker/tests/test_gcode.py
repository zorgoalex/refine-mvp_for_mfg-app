from __future__ import annotations

import unittest

from cnc_telegram_worker.gcode import extract_order_names, infer_machine, parse_gcode_text


class GcodeParserTest(unittest.TestCase):
    def test_parses_tools_orders_machine_and_size_candidates(self) -> None:
        text = """
G90 G54
T8
M3 S15000
G43 H8
G0 X0 Y0
G0 X10 Y20 Z10
G1 Z-8 F1000
G1 X110
G1 Y70
G1 X10
G1 Y20
G1 Z-16 F1000
G1 X110
G1 Y70
G1 X10
G1 Y20
G0 Z10
G0 X200 Y20
G1 Z-8
G1 X260
G1 Y100
G1 X200
G1 Y20
G0 Z10
"""
        analysis = parse_gcode_text(text, "CNC#1_2670+2678.TXT")

        self.assertEqual(analysis.tools[0].toolNumber, 8)
        self.assertEqual(analysis.tools[0].spindleRpm, 15000)
        self.assertEqual(analysis.order_names, ["2670", "2678"])
        self.assertEqual(analysis.machine, "CNC#1")
        self.assertEqual(analysis.bounds_width_mm, 260)
        self.assertEqual(analysis.bounds_height_mm, 100)
        self.assertEqual([(c.widthMm, c.heightMm, c.quantity) for c in analysis.size_candidates], [(60, 80, 1), (100, 50, 1)])
        self.assertEqual(
            [(p.xMm, p.yMm, p.widthMm, p.heightMm) for p in analysis.sheet_placements],
            [(0, 0, 100, 50), (190, 0, 60, 80)],
        )

    def test_extract_order_names_dedupes(self) -> None:
        self.assertEqual(extract_order_names("CNC#1_2670+2670+2698.TXT"), ["2670", "2698"])

    def test_infer_machine_normalizes(self) -> None:
        self.assertEqual(infer_machine("cnc#2_2686.txt"), "CNC#2")


if __name__ == "__main__":
    unittest.main()
