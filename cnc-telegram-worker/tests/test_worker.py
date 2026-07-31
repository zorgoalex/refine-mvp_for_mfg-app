from __future__ import annotations

import unittest
import sys
import types
from datetime import date, datetime, timezone

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.telegram_source import is_image_message, is_vector_message
from cnc_telegram_worker.worker import (
    ImageGroup,
    cutting_sequence_reply_number,
    group_has_thumbs_up,
    group_image_messages,
    group_source_fingerprint,
    is_cutting_sequence_reply_text,
    parse_cutting_sequence_reply,
)


class FakeFile:
    def __init__(self, name: str | None, mime_type: str | None = None) -> None:
        self.name = name
        self.mime_type = mime_type


class FakeReaction:
    def __init__(self, emoticon: str) -> None:
        self.emoticon = emoticon


class FakeReactionResult:
    def __init__(self, emoticon: str, count: int = 1) -> None:
        self.reaction = FakeReaction(emoticon)
        self.count = count


class FakeMessage:
    def __init__(
        self,
        message_id: int,
        *,
        text: str = "",
        filename: str | None = None,
        mime_type: str | None = None,
        thumbs_up: bool = False,
        reply_to: int | None = None,
    ) -> None:
        self.id = message_id
        self.date = datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc)
        self.edit_date = None
        self.raw_text = text
        self.file = FakeFile(filename, mime_type) if filename or mime_type else None
        self.reply_to = types.SimpleNamespace(reply_to_msg_id=reply_to) if reply_to else None
        self.reactions = (
            types.SimpleNamespace(results=[FakeReactionResult("\U0001F44D")])
            if thumbs_up
            else None
        )


class WorkerFingerprintTest(unittest.TestCase):
    def test_group_source_fingerprint_tracks_parser_and_comments(self) -> None:
        group = ImageGroup(
            image_message=FakeMessage(10, text="2689"),
            comments=["2689 весь"],
            cutting_sequence_no=None,
            gcode_message=FakeMessage(11, filename="CNC#1_2689.TXT"),
            vector_message=FakeMessage(12, filename="2689.svg"),
        )

        first = group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a")
        self.assertEqual(
            first,
            group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
        )
        self.assertNotEqual(
            first,
            group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v2", "ocr-a"),
        )
        changed_comment = ImageGroup(
            image_message=group.image_message,
            comments=["2689 весь", "ХДФ"],
            cutting_sequence_no=None,
            gcode_message=group.gcode_message,
            vector_message=group.vector_message,
        )
        self.assertNotEqual(
            first,
            group_source_fingerprint(changed_comment, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
        )

    def test_svg_attachment_is_vector_not_sheet_image(self) -> None:
        message = FakeMessage(20, filename="2689.svg", mime_type="image/svg+xml")

        self.assertFalse(is_image_message(message))
        self.assertTrue(is_vector_message(message))

    def test_groups_nearest_vector_attachment_with_image(self) -> None:
        image = FakeMessage(30, text="2689", filename="sheet.jpg", mime_type="image/jpeg")
        gcode = FakeMessage(31, filename="CNC#1_2689.TXT")
        vector = FakeMessage(32, filename="2689.svg", mime_type="image/svg+xml")

        groups = group_image_messages([image, gcode, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].gcode_message, gcode)
        self.assertIs(groups[0].vector_message, vector)

    def test_groups_file_attachments_with_previous_image_block(self) -> None:
        first_gcode = FakeMessage(10611, filename="CNC#1_2718.TXT")
        first_vector = FakeMessage(10612, filename="CNC#1_2718.svg", mime_type="image/svg+xml")
        first_image = FakeMessage(10613, text="2718", mime_type="image/jpeg")
        second_gcode = FakeMessage(10614, filename="CNC#2_2718.TXT")
        second_vector = FakeMessage(10615, filename="CNC#2_2718.svg", mime_type="image/svg+xml")
        second_image = FakeMessage(10616, text="2718", mime_type="image/jpeg")

        groups = group_image_messages([
            first_gcode,
            first_vector,
            first_image,
            second_gcode,
            second_vector,
            second_image,
        ])

        self.assertEqual(len(groups), 2)
        self.assertIs(groups[0].gcode_message, first_gcode)
        self.assertIs(groups[0].vector_message, first_vector)
        self.assertIs(groups[1].gcode_message, second_gcode)
        self.assertIs(groups[1].vector_message, second_vector)

    def test_does_not_attach_later_day_vector_outside_image_block(self) -> None:
        gcode = FakeMessage(10502, filename="CNC#1_2665-18MM.TXT")
        image = FakeMessage(10503, mime_type="image/jpeg", thumbs_up=True)
        comment = FakeMessage(10504, text="18мм!!!\nФрезы для 18мм: 1, 6, 8")
        next_gcode = FakeMessage(10505, filename="CNC#2_2665+2677+2704-18MM.TXT")
        next_image = FakeMessage(10506, mime_type="image/jpeg")
        later_vector = FakeMessage(10531, filename="2694+2665+2696+2700+2705.svg", mime_type="image/svg+xml")

        groups = group_image_messages([gcode, image, comment, next_gcode, next_image, later_vector])

        self.assertEqual(len(groups), 2)
        self.assertIs(groups[0].gcode_message, gcode)
        self.assertIsNone(groups[0].vector_message)

    def test_group_thumbs_up_uses_attachment_reactions(self) -> None:
        image = FakeMessage(40, text="2718", mime_type="image/jpeg")
        gcode = FakeMessage(41, filename="CNC#2_2718.TXT", thumbs_up=True)
        group = ImageGroup(
            image_message=image,
            comments=[],
            cutting_sequence_no=None,
            gcode_message=gcode,
            vector_message=None,
        )
        without_reaction = ImageGroup(
            image_message=image,
            comments=[],
            cutting_sequence_no=None,
            gcode_message=FakeMessage(41, filename="CNC#2_2718.TXT"),
            vector_message=None,
        )

        self.assertTrue(group_has_thumbs_up(group))
        self.assertNotEqual(
            group_source_fingerprint(group, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
            group_source_fingerprint(without_reaction, "-100123", date(2026, 7, 24), "parser-v1", "ocr-a"),
        )

    def test_cutting_sequence_reply_is_bound_to_image_and_not_a_comment(self) -> None:
        image = FakeMessage(50, text="2700", mime_type="image/jpeg")
        reply = FakeMessage(51, text="Раскрой №7", reply_to=50)
        comment = FakeMessage(52, text="2700 весь")

        groups = group_image_messages([image, reply, comment])

        self.assertEqual(parse_cutting_sequence_reply("Раскрой №7"), 7)
        self.assertTrue(is_cutting_sequence_reply_text("Раскрой №7"))
        self.assertEqual(cutting_sequence_reply_number([image, reply], image), 7)
        self.assertEqual(groups[0].cutting_sequence_no, 7)
        self.assertEqual(groups[0].comments, ["2700 весь"])


if __name__ == "__main__":
    unittest.main()
