from __future__ import annotations

import unittest
from datetime import date, datetime, timezone

from cnc_telegram_worker.gcode import parse_gcode_text
from cnc_telegram_worker.ocr import OcrResult
from cnc_telegram_worker.packet import (
    GcodeMeta,
    ImageMeta,
    apply_source_version,
    build_structured_packet,
    canonical_payload_hash,
    idempotency_key,
)


class PacketBuilderTest(unittest.TestCase):
    def test_builds_raw_free_packet_from_comments_ocr_reaction_and_gcode(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=55,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2689 весь ХДФ переделка присадка P12",
            thumbs_up=True,
        )
        gcode_text = "T8\nM3 S15000\nG0 X0 Y0\nG1 Z-4\nG1 X497\nG1 Y477\nG0 Z10\n"
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[{
                "orderName": "2689",
                "detailNumber": 31,
                "widthMm": 497,
                "heightMm": 477,
                "quantity": 4,
                "confidence": 0.94,
            }]),
            gcode=GcodeMeta("CNC#1_2689-HDF.TXT", gcode_text, parse_gcode_text(gcode_text, "CNC#1_2689-HDF.TXT")),
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(packet["externalPacketKey"], "telegram:-100123:55")
        self.assertEqual(packet["completionStatus"], "completed")
        self.assertTrue(packet["thumbsUp"])
        self.assertTrue(packet["rework"])
        self.assertEqual(packet["machine"], "CNC#1")
        self.assertEqual(packet["materialName"], "ХДФ")
        self.assertEqual(packet["tools"], [{"toolNumber": 8, "spindleRpm": 15000}])
        self.assertIn("Весь заказ: 2689", packet["comments"])
        self.assertEqual(packet["items"][0]["source"], "ocr")
        self.assertNotIn("gcode_text", packet)
        self.assertNotIn("image_path", packet)

    def test_falls_back_to_gcode_sizes_for_single_order(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=56,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2689",
            thumbs_up=False,
        )
        gcode_text = "T2\nM3 S18000\nG0 X10 Y20 Z10\nG1 Z-2\nG1 X110\nG1 Y70\nG1 X10\nG1 Y20\nG0 Z10\n"
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(),
            gcode=GcodeMeta("CNC#2_2689.TXT", gcode_text, parse_gcode_text(gcode_text, "CNC#2_2689.TXT")),
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(packet["parseStatus"], "needs_review")
        self.assertEqual(packet["items"][0]["source"], "gcode")
        self.assertEqual(packet["items"][0]["widthMm"], 100)
        self.assertEqual(packet["items"][0]["heightMm"], 50)

    def test_payload_hash_ignores_source_version_and_idempotency(self) -> None:
        packet = {
            "externalPacketKey": "telegram:-100:1",
            "source": {"chatId": "-100", "messageId": 1, "version": 1, "updatedAt": "2026-07-24T00:00:00Z"},
            "items": [{"sourceItemKey": "a", "orderName": "2670", "quantity": 1, "source": "manual", "confidence": 0}],
        }
        first = canonical_payload_hash(packet)
        packet["idempotencyKey"] = "ignore-me"
        packet["source"]["version"] = 9
        self.assertEqual(canonical_payload_hash(packet), first)
        self.assertEqual(apply_source_version(packet, 3)["source"]["version"], 3)
        self.assertLessEqual(len(idempotency_key("telegram:-100:1", 3)), 160)


if __name__ == "__main__":
    unittest.main()
