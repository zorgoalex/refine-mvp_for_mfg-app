import unittest
from cnc_telegram_worker.vector import parse_detail_comment, parse_visual_order_line


class UnicodeNamesTest(unittest.TestCase):
    def test_explicit_comments_preserve_names(self):
        for name in ["Кухня Ёлка", "Әлия-1234", "12"]:
            self.assertEqual(parse_detail_comment(f"{name}#2#", (100, 200))["orderName"], name)
        self.assertIsNone(parse_detail_comment("   #2#", None))
        self.assertIsNone(parse_detail_comment("Bad\x00#2#", None))

    def test_explicit_visual_name(self):
        self.assertEqual(parse_visual_order_line("Заказ: Кухня Әлия"), "Кухня Әлия")
        self.assertEqual(parse_visual_order_line("Заказ: 12"), "12")
        self.assertEqual(parse_visual_order_line("2689"), "2689")
        self.assertIsNone(parse_visual_order_line("Кухня без номера"))
