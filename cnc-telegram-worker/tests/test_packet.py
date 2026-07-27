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
        self.assertEqual(packet["source"]["createdAt"], "2026-07-24T05:00:00Z")
        self.assertEqual(packet["completionStatus"], "completed")
        self.assertTrue(packet["thumbsUp"])
        self.assertTrue(packet["rework"])
        self.assertEqual(packet["machine"], "CNC#1")
        self.assertEqual(packet["materialName"], "ХДФ")
        self.assertEqual(packet["tools"], [{"toolNumber": 8, "spindleRpm": 15000}])
        self.assertIn("Весь заказ: 2689", packet["comments"])
        self.assertNotIn("2689 весь ХДФ переделка присадка P12", packet["comments"])
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

        self.assertEqual(packet["parseStatus"], "parsed")
        self.assertEqual(packet["items"][0]["source"], "gcode")
        self.assertEqual(packet["items"][0]["matchStatus"], "unmatched")
        self.assertIsNone(packet["items"][0]["reviewNote"])
        self.assertEqual(packet["items"][0]["widthMm"], 100)
        self.assertEqual(packet["items"][0]["heightMm"], 50)

    def test_vector_items_are_primary_and_aggregate_geometry_quantity(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=561,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="1200",
            thumbs_up=False,
        )
        gcode_text = """
G0 X0 Y0 Z10
G1 Z-2
G1 X2215
G1 Y493
G1 X0
G1 Y0
G0 Z10
"""
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[{
                "orderName": "1200",
                "detailNumber": 16,
                "widthMm": 2215,
                "heightMm": 493,
                "quantity": 9,
                "confidence": 0.7,
            }]),
            gcode=GcodeMeta("CNC#1_1200.TXT", gcode_text, parse_gcode_text(gcode_text, "CNC#1_1200.TXT")),
            vector_items=[
                {"orderName": "1200", "detailNumber": 16, "widthMm": 2215, "heightMm": 493},
                {"orderName": "1200", "detailNumber": 16, "widthMm": 2215, "heightMm": 493},
                {"orderName": "1200", "detailNumber": 16, "widthMm": 2215, "heightMm": 493},
            ],
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(packet["items"], [{
            "sourceItemKey": "vector:1200:16:2215x493:0",
            "orderName": "1200",
            "detailNumber": 16,
            "widthMm": 2215.0,
            "heightMm": 493.0,
            "quantity": 3,
            "source": "vector",
            "confidence": 0.99,
            "matchOrderId": None,
            "matchDetailId": None,
            "matchStatus": "unmatched",
            "reviewNote": None,
        }])

    def test_vector_quantity_beats_larger_gcode_candidate_quantity(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=562,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="1200",
            thumbs_up=False,
        )
        gcode_text = """
G0 X0 Y0 Z10
G1 Z-2
G1 X2215
G1 Y493
G1 X0
G1 Y0
G0 Z10
G0 X2300 Y0 Z10
G1 Z-2
G1 X4515
G1 Y493
G1 X2300
G1 Y0
G0 Z10
G0 X4600 Y0 Z10
G1 Z-2
G1 X6815
G1 Y493
G1 X4600
G1 Y0
G0 Z10
G0 X6900 Y0 Z10
G1 Z-2
G1 X9115
G1 Y493
G1 X6900
G1 Y0
G0 Z10
"""
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[{
                "orderName": "1200",
                "detailNumber": 16,
                "widthMm": 2215,
                "heightMm": 493,
                "quantity": 9,
                "confidence": 0.7,
            }]),
            gcode=GcodeMeta("CNC#1_1200.TXT", gcode_text, parse_gcode_text(gcode_text, "CNC#1_1200.TXT")),
            vector_items=[
                {"orderName": "1200", "detailNumber": 16, "widthMm": 2215, "heightMm": 493},
                {"orderName": "1200", "detailNumber": 16, "widthMm": 2215, "heightMm": 493},
                {"orderName": "1200", "detailNumber": 16, "widthMm": 2215, "heightMm": 493},
            ],
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(packet["items"][0]["source"], "vector")
        self.assertEqual(packet["items"][0]["quantity"], 3)

    def test_ocr_items_without_gcode_do_not_need_review(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=560,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2689",
            thumbs_up=False,
        )
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
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="rapidocr",
            parser_version="test",
        )

        self.assertEqual(packet["parseStatus"], "parsed")
        self.assertEqual(packet["analysisWarnings"], [])

    def test_ignores_rapidocr_no_detail_rows_warning(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=562,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2689",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(
                items=[{
                    "orderName": "2689",
                    "detailNumber": 31,
                    "widthMm": 497,
                    "heightMm": 477,
                    "quantity": 4,
                    "confidence": 0.94,
                }],
                analysis_warnings=["RapidOCR found text, but no detail rows with order and size"],
            ),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="rapidocr",
            parser_version="test",
        )

        self.assertEqual(packet["parseStatus"], "parsed")
        self.assertEqual(packet["analysisWarnings"], [])

    def test_does_not_treat_doweling_number_as_last_order_comment(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=57,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2689 весь. Присадка №1499",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(packet["comments"], ["Весь заказ: 2689"])
        self.assertEqual(packet["dowelingLinks"], [{"orderName": "2689", "dowelingNumber": "1499"}])
        self.assertEqual([item["orderName"] for item in packet["items"]], ["2689"])

    def test_ignores_placeholder_ocr_comments(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=60,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2678",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=["string", "null"],
            ocr=OcrResult(comments=["none"], items=[
                {"orderName": "2678", "widthMm": 1866, "heightMm": 421, "quantity": 1},
            ]),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(packet["comments"], [])

    def test_aggregates_repeated_ocr_detail_rows_into_quantity(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=58,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2678",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[
                {"sourceItemKey": "#41", "orderName": "2678", "detailNumber": 41, "widthMm": 1866, "heightMm": 421, "quantity": 1},
                {"sourceItemKey": "#41", "orderName": "2678", "detailNumber": 41, "widthMm": 1866, "heightMm": 421, "quantity": 1},
            ]),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(len(packet["items"]), 1)
        self.assertEqual(packet["items"][0]["sourceItemKey"], "ocr:2678:41:1866x421:0")
        self.assertEqual(packet["items"][0]["quantity"], 2)

    def test_preserves_unlabeled_same_size_rows_for_backend_matching(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=61,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2689",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[
                {"orderName": "2689", "detailNumber": 31, "widthMm": 497, "heightMm": 477, "quantity": 3},
                {"orderName": "2689", "widthMm": 497, "heightMm": 477, "quantity": 1},
                {"orderName": "2689", "detailNumber": 27, "widthMm": 2242, "heightMm": 477, "quantity": 4},
            ]),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="rapidocr",
            parser_version="test",
        )

        self.assertEqual(
            [(item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"]) for item in packet["items"]],
            [(31, 497.0, 477.0, 3), (None, 497.0, 477.0, 1), (27, 2242.0, 477.0, 4)],
        )

    def test_preserves_duplicate_unlabeled_same_size_rows(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=610,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2689",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[
                {"orderName": "2689", "widthMm": 497, "heightMm": 477, "quantity": 1},
                {"orderName": "2689", "widthMm": 497, "heightMm": 477, "quantity": 1},
            ]),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="rapidocr",
            parser_version="test",
        )

        self.assertEqual(
            [(item["detailNumber"], item["widthMm"], item["heightMm"], item["quantity"]) for item in packet["items"]],
            [(None, 497.0, 477.0, 1), (None, 497.0, 477.0, 1)],
        )

    def test_uses_gcode_quantity_when_single_order_ocr_only_seen_once(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=59,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2678",
            thumbs_up=False,
        )
        gcode_text = """
G0 X0 Y0 Z10
G1 Z-2
G1 X100
G1 Y50
G1 X0
G1 Y0
G0 Z10
G0 X120 Y0 Z10
G1 Z-2
G1 X220
G1 Y50
G1 X120
G1 Y0
G0 Z10
G0 X0 Y70 Z10
G1 Z-2
G1 X100
G1 Y120
G1 X0
G1 Y70
G0 Z10
G0 X120 Y70 Z10
G1 Z-2
G1 X220
G1 Y120
G1 X120
G1 Y70
G0 Z10
"""
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[
                {"orderName": "2678", "widthMm": 100, "heightMm": 50, "quantity": 1},
            ]),
            gcode=GcodeMeta("CNC#1_2678.TXT", gcode_text, parse_gcode_text(gcode_text, "CNC#1_2678.TXT")),
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="glm-ocr",
            parser_version="test",
        )

        self.assertEqual(packet["items"][0]["quantity"], 4)

    def test_does_not_apply_full_gcode_quantity_to_each_duplicate_size_item(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=62,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2678",
            thumbs_up=False,
        )
        gcode_text = """
G0 X0 Y0 Z10
G1 Z-2
G1 X100
G1 Y50
G1 X0
G1 Y0
G0 Z10
G0 X120 Y0 Z10
G1 Z-2
G1 X220
G1 Y50
G1 X120
G1 Y0
G0 Z10
G0 X0 Y70 Z10
G1 Z-2
G1 X100
G1 Y120
G1 X0
G1 Y70
G0 Z10
G0 X120 Y70 Z10
G1 Z-2
G1 X220
G1 Y120
G1 X120
G1 Y70
G0 Z10
"""
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(items=[
                {"orderName": "2678", "detailNumber": 1, "widthMm": 100, "heightMm": 50, "quantity": 2},
                {"orderName": "2678", "detailNumber": 2, "widthMm": 100, "heightMm": 50, "quantity": 1},
            ]),
            gcode=GcodeMeta("CNC#1_2678.TXT", gcode_text, parse_gcode_text(gcode_text, "CNC#1_2678.TXT")),
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="rapidocr",
            parser_version="test",
        )

        self.assertEqual(
            [(item["detailNumber"], item["quantity"]) for item in packet["items"]],
            [(1, 2), (2, 1)],
        )

    def test_corrects_ocr_doweling_order_to_known_order_when_one_digit_off(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=63,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="2690",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(
                items=[{"orderName": "2690", "detailNumber": 5, "widthMm": 584, "heightMm": 350, "quantity": 1}],
                doweling_links=[{"orderName": "2390", "dowelingNumber": "1480"}],
            ),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="rapidocr",
            parser_version="test",
        )

        self.assertEqual(packet["dowelingLinks"], [{"orderName": "2690", "dowelingNumber": "1480"}])

    def test_corrects_doweling_order_even_when_wrong_number_is_in_ocr_comment(self) -> None:
        image = ImageMeta(
            chat_id="-100123",
            message_id=64,
            thread_id=None,
            message_date=datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc),
            edited_at=None,
            text="",
            thumbs_up=False,
        )
        packet = build_structured_packet(
            image=image,
            workday=date(2026, 7, 24),
            comments=[],
            ocr=OcrResult(
                comments=["2390 присадка №1480"],
                items=[{"orderName": "2690", "detailNumber": 5, "widthMm": 584, "heightMm": 350, "quantity": 1}],
                doweling_links=[{"orderName": "2390", "dowelingNumber": "1480"}],
            ),
            gcode=None,
            default_machine="",
            default_material="МДФ 16мм",
            ocr_engine="rapidocr",
            parser_version="test",
        )

        self.assertEqual(packet["dowelingLinks"], [{"orderName": "2690", "dowelingNumber": "1480"}])
        self.assertEqual([item["orderName"] for item in packet["items"]], ["2690"])

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
