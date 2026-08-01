from __future__ import annotations

import unittest
import sys
import tempfile
import types
from datetime import date, datetime, timezone
from pathlib import Path

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.telegram_source import is_image_message, is_vector_message
from cnc_telegram_worker.packet import external_packet_key
from cnc_telegram_worker.state import StateStore
from cnc_telegram_worker.worker import (
    ImageGroup,
    apply_cutting_sequence_reply_index,
    apply_known_cutting_sequence_state,
    collect_cutting_sequence_reply_search_index,
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


class FakeTelegramClient:
    def __init__(self, messages: list[FakeMessage]) -> None:
        self.messages = messages
        self.iter_messages_calls: list[dict[str, object]] = []

    def iter_messages(self, entity: object, **kwargs: object):
        self.iter_messages_calls.append(kwargs)
        return self._iter_messages()

    async def _iter_messages(self):
        for message in self.messages:
            yield message


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


class WorkerCuttingSequenceIndexTest(unittest.IsolatedAsyncioTestCase):
    async def test_collects_cutting_sequence_reply_numbers_with_one_search(self) -> None:
        image_a = FakeMessage(100, text="2700", mime_type="image/jpeg")
        image_b = FakeMessage(200, text="2718", mime_type="image/jpeg")
        client = FakeTelegramClient([
            FakeMessage(901, text="Раскрой №8", reply_to=200),
            FakeMessage(902, text="не номер", reply_to=100),
            FakeMessage(903, text="Раскрой №7", reply_to=100),
            FakeMessage(904, text="Раскрой №99", reply_to=999),
        ])

        index = await collect_cutting_sequence_reply_search_index(client, object(), {100, 200})
        groups = apply_cutting_sequence_reply_index(group_image_messages([image_a, image_b]), index)

        self.assertEqual(index, {100: 7, 200: 8})
        self.assertEqual(groups[0].cutting_sequence_no, 7)
        self.assertEqual(groups[1].cutting_sequence_no, 8)
        self.assertEqual(len(client.iter_messages_calls), 1)
        self.assertEqual(client.iter_messages_calls[0], {"search": "Раскрой", "limit": 1000})


class WorkerCuttingSequenceStateTest(unittest.TestCase):
    def test_applies_known_replied_cutting_sequence_before_telegram_search(self) -> None:
        image_a = FakeMessage(100, text="2700", mime_type="image/jpeg")
        image_b = FakeMessage(200, text="2718", mime_type="image/jpeg")
        groups = group_image_messages([image_a, image_b])
        chat_id = "-100123"

        with tempfile.TemporaryDirectory() as temp:
            state = StateStore(Path(temp) / "state.json")
            key_a = external_packet_key(chat_id, 100)
            key_b = external_packet_key(chat_id, 200)
            state.assign_cutting_sequence_number(key_a, existing_number=7)
            state.mark_cutting_sequence_replied(key_a)
            state.assign_cutting_sequence_number(key_b, existing_number=8)

            updated = apply_known_cutting_sequence_state(groups, chat_id, state)

        self.assertEqual(updated[0].cutting_sequence_no, 7)
        self.assertIsNone(updated[1].cutting_sequence_no)


if __name__ == "__main__":
    unittest.main()
