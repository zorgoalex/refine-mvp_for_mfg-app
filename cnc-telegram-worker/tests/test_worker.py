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
from cnc_telegram_worker.worker import ImageGroup, group_image_messages, group_source_fingerprint


class FakeFile:
    def __init__(self, name: str, mime_type: str | None = None) -> None:
        self.name = name
        self.mime_type = mime_type


class FakeMessage:
    def __init__(
        self,
        message_id: int,
        *,
        text: str = "",
        filename: str | None = None,
        mime_type: str | None = None,
    ) -> None:
        self.id = message_id
        self.date = datetime(2026, 7, 24, 5, 0, tzinfo=timezone.utc)
        self.edit_date = None
        self.raw_text = text
        self.file = FakeFile(filename, mime_type) if filename or mime_type else None
        self.reactions = None


class WorkerFingerprintTest(unittest.TestCase):
    def test_group_source_fingerprint_tracks_parser_and_comments(self) -> None:
        group = ImageGroup(
            image_message=FakeMessage(10, text="2689"),
            comments=["2689 весь"],
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


if __name__ == "__main__":
    unittest.main()
