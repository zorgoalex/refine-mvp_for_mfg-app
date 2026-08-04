from __future__ import annotations

import unittest
import sys
import tempfile
import types
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.telegram_source import is_image_message, is_vector_message
from cnc_telegram_worker.packet import external_packet_key
from cnc_telegram_worker.ocr import OcrResult
from cnc_telegram_worker.state import StateStore
from cnc_telegram_worker.worker import (
    CncTelegramWorker,
    SvgGroup,
    apply_cutting_sequence_reply_index,
    apply_known_cutting_sequence_state,
    collect_cutting_sequence_reply_search_index,
    cutting_sequence_reply_number,
    group_has_thumbs_up,
    group_svg_messages,
    group_source_fingerprint,
    is_cutting_sequence_reply_text,
    parse_cutting_sequence_reply,
)


VALID_SVG = """
<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 10000 5000">
  <rect id="_1234_PartContour" width="2000" height="1000">
    <metadata><odm name="Comments" value="1234#7#X@200*100@"/></metadata>
  </rect>
</svg>
"""


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
        media_content: str | None = None,
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
        self.media_content = media_content

    async def download_media(self, *, file: str) -> str | None:
        if self.media_content is None:
            return None
        Path(file).write_text(self.media_content, encoding="utf-8")
        return file


class FakeTelegramClient:
    def __init__(self, messages: list[FakeMessage]) -> None:
        self.messages = messages
        self.iter_messages_calls: list[dict[str, object]] = []
        self.sent_messages: list[dict[str, object]] = []

    def iter_messages(self, entity: object, **kwargs: object):
        self.iter_messages_calls.append(kwargs)
        return self._iter_messages()

    async def _iter_messages(self):
        for message in self.messages:
            yield message

    async def send_message(self, entity: object, text: str, *, reply_to: int) -> None:
        self.sent_messages.append({"entity": entity, "text": text, "reply_to": reply_to})


class FakeErpClient:
    def __init__(self) -> None:
        self.packets: list[dict[str, object]] = []

    async def ingest_packet(self, packet: dict[str, object], idempotency_key: str) -> dict[str, object]:
        self.packets.append(packet)
        return {"applied": True, "packet": {"cuttingSequenceNo": 12}}


class WorkerFingerprintTest(unittest.TestCase):
    def test_group_source_fingerprint_tracks_parser_and_comments(self) -> None:
        group = SvgGroup(
            vector_message=FakeMessage(12, filename="2689.svg"),
            image_message=FakeMessage(10, text="2689"),
            comments=["2689 весь"],
            cutting_sequence_no=None,
            gcode_message=FakeMessage(11, filename="CNC#1_2689.TXT"),
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
        changed_comment = SvgGroup(
            vector_message=group.vector_message,
            image_message=group.image_message,
            comments=["2689 весь", "ХДФ"],
            cutting_sequence_no=None,
            gcode_message=group.gcode_message,
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

        groups = group_svg_messages([image, gcode, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].source_message, image)
        self.assertIs(groups[0].image_message, image)
        self.assertIs(groups[0].gcode_message, gcode)
        self.assertIs(groups[0].vector_message, vector)

    def test_standalone_svg_creates_group_without_image(self) -> None:
        gcode = FakeMessage(70, filename="CNC#1_2700.TXT")
        vector = FakeMessage(71, filename="CNC#1_2700.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([gcode, vector])

        self.assertEqual(len(groups), 1)
        self.assertIs(groups[0].source_message, vector)
        self.assertIsNone(groups[0].image_message)
        self.assertIs(groups[0].gcode_message, gcode)

    def test_image_without_svg_does_not_create_group(self) -> None:
        image = FakeMessage(80, filename="sheet.jpg", mime_type="image/jpeg")
        gcode = FakeMessage(81, filename="CNC#1_2700.TXT")

        self.assertEqual(group_svg_messages([image, gcode]), [])

    def test_each_svg_creates_separate_group(self) -> None:
        image = FakeMessage(90, text="2700", filename="sheet.jpg", mime_type="image/jpeg")
        gcode = FakeMessage(91, filename="CNC#1_2700.TXT")
        first_svg = FakeMessage(92, filename="CNC#1_2700-a.svg", mime_type="image/svg+xml")
        second_svg = FakeMessage(93, filename="CNC#1_2700-b.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([image, gcode, first_svg, second_svg])

        self.assertEqual(len(groups), 2)
        self.assertIs(groups[0].vector_message, first_svg)
        self.assertIs(groups[0].source_message, image)
        self.assertIs(groups[1].vector_message, second_svg)
        self.assertIs(groups[1].source_message, second_svg)

    def test_dxf_and_screenshot_do_not_create_group(self) -> None:
        image = FakeMessage(95, filename="sheet.jpg", mime_type="image/jpeg")
        dxf = FakeMessage(96, filename="sheet.dxf")

        self.assertEqual(group_svg_messages([image, dxf]), [])

    def test_groups_file_attachments_with_previous_image_block(self) -> None:
        first_gcode = FakeMessage(10611, filename="CNC#1_2718.TXT")
        first_vector = FakeMessage(10612, filename="CNC#1_2718.svg", mime_type="image/svg+xml")
        first_image = FakeMessage(10613, text="2718", mime_type="image/jpeg")
        second_gcode = FakeMessage(10614, filename="CNC#2_2718.TXT")
        second_vector = FakeMessage(10615, filename="CNC#2_2718.svg", mime_type="image/svg+xml")
        second_image = FakeMessage(10616, text="2718", mime_type="image/jpeg")

        groups = group_svg_messages([
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
        group = SvgGroup(
            vector_message=FakeMessage(42, filename="CNC#2_2718.svg"),
            image_message=image,
            comments=[],
            cutting_sequence_no=None,
            gcode_message=gcode,
        )
        without_reaction = SvgGroup(
            vector_message=group.vector_message,
            image_message=image,
            comments=[],
            cutting_sequence_no=None,
            gcode_message=FakeMessage(41, filename="CNC#2_2718.TXT"),
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

        vector = FakeMessage(53, filename="2700.svg", mime_type="image/svg+xml")

        groups = group_svg_messages([image, reply, comment, vector])

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
        vector_a = FakeMessage(101, filename="2700.svg", mime_type="image/svg+xml")
        vector_b = FakeMessage(201, filename="2718.svg", mime_type="image/svg+xml")
        groups = apply_cutting_sequence_reply_index(
            group_svg_messages([image_a, vector_a, image_b, vector_b]),
            index,
        )

        self.assertEqual(index, {100: 7, 200: 8})
        self.assertEqual(groups[0].cutting_sequence_no, 7)
        self.assertEqual(groups[1].cutting_sequence_no, 8)
        self.assertEqual(len(client.iter_messages_calls), 1)
        self.assertEqual(client.iter_messages_calls[0], {"search": "Раскрой", "limit": 1000})


class WorkerCuttingSequenceStateTest(unittest.TestCase):
    def test_applies_known_replied_cutting_sequence_before_telegram_search(self) -> None:
        image_a = FakeMessage(100, text="2700", mime_type="image/jpeg")
        image_b = FakeMessage(200, text="2718", mime_type="image/jpeg")
        vector_a = FakeMessage(101, filename="2700.svg", mime_type="image/svg+xml")
        vector_b = FakeMessage(201, filename="2718.svg", mime_type="image/svg+xml")
        groups = group_svg_messages([image_a, vector_a, image_b, vector_b])
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


class WorkerSvgProcessingTest(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_svg_does_not_post_packet(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            group = SvgGroup(
                vector_message=FakeMessage(
                    300,
                    filename="invalid.svg",
                    mime_type="image/svg+xml",
                    media_content="<svg></svg>",
                ),
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )

            await worker.process_group(FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(worker.erp.packets, [])

    async def test_valid_standalone_svg_posts_one_packet_keyed_by_svg(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            vector = FakeMessage(
                301,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )

            client = FakeTelegramClient([])
            await worker.process_group(client, object(), group, "-100123", date(2026, 7, 24))
            await worker.process_group(client, object(), group, "-100123", date(2026, 7, 24))

            self.assertEqual(len(worker.erp.packets), 1)
            packet = worker.erp.packets[0]
            self.assertEqual(packet["externalPacketKey"], "telegram:-100123:301")
            self.assertEqual(packet["cutLayout"]["status"], "valid")
            self.assertEqual(client.sent_messages, [])
            self.assertFalse(worker.state.cutting_sequence_replied("telegram:-100123:301"))

    async def test_each_valid_svg_posts_separate_packet(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            vectors = [
                FakeMessage(
                    message_id,
                    filename=f"CNC#1_1234-{message_id}.svg",
                    mime_type="image/svg+xml",
                    media_content=VALID_SVG,
                )
                for message_id in (310, 311)
            ]

            for group in group_svg_messages(vectors):
                await worker.process_group(
                    FakeTelegramClient([]),
                    object(),
                    group,
                    "-100123",
                    date(2026, 7, 24),
                )

            self.assertEqual(
                [packet["externalPacketKey"] for packet in worker.erp.packets],
                ["telegram:-100123:310", "telegram:-100123:311"],
            )

    async def test_writer_posts_cutting_sequence_reply(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp), can_write_chat=True)
            vector = FakeMessage(
                320,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=None,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )
            client = FakeTelegramClient([])
            entity = object()

            await worker.process_group(client, entity, group, "-100123", date(2026, 7, 24))

            self.assertEqual(
                client.sent_messages,
                [{"entity": entity, "text": "Раскрой №12", "reply_to": 320}],
            )
            self.assertTrue(worker.state.cutting_sequence_replied("telegram:-100123:320"))

    async def test_glm_fallback_runs_only_when_explicitly_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            vector = FakeMessage(
                331,
                filename="CNC#1_1234.svg",
                mime_type="image/svg+xml",
                media_content=VALID_SVG,
            )
            image = FakeMessage(
                330,
                filename="sheet.jpg",
                mime_type="image/jpeg",
                media_content="fake-image",
            )
            group = SvgGroup(
                vector_message=vector,
                image_message=image,
                comments=[],
                cutting_sequence_no=None,
                gcode_message=None,
            )
            ocr_result = OcrResult(items=[{
                "orderName": "1234",
                "detailNumber": 7,
                "widthMm": 200,
                "heightMm": 100,
                "quantity": 1,
            }])

            with patch(
                "cnc_telegram_worker.worker.run_ocr_command",
                new_callable=AsyncMock,
                return_value=ocr_result,
            ) as run_ocr:
                normal = make_worker(temp_path / "normal", ocr_engine="rapidocr-ppocrv5-eslav")
                await normal.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24)
                )
                run_ocr.assert_not_awaited()

                fallback = make_worker(
                    temp_path / "fallback",
                    enable_glm_ocr=True,
                    ocr_engine="glm-ocr-0.9b-q8",
                    ocr_command="python -m cnc_telegram_worker.glm_ocr_client --image {image}",
                    ocr_command_timeout_seconds=720,
                )
                await fallback.process_group(
                    FakeTelegramClient([]), object(), group, "-100123", date(2026, 7, 24)
                )

            run_ocr.assert_awaited_once()
            self.assertEqual(run_ocr.await_args.kwargs["timeout_seconds"], 720)
            self.assertEqual(fallback.erp.packets[0]["ocrEngine"], "glm-ocr-0.9b-q8")
            self.assertEqual(fallback.erp.packets[0]["items"][0]["orderName"], "1234")


def make_worker(
    temp_dir: Path,
    *,
    can_write_chat: bool = False,
    enable_glm_ocr: bool = False,
    ocr_engine: str = "none",
    ocr_command: str = "",
    ocr_command_timeout_seconds: int = 180,
) -> CncTelegramWorker:
    worker = object.__new__(CncTelegramWorker)
    worker.config = types.SimpleNamespace(
        can_write_chat=can_write_chat,
        resend_unchanged=False,
        parser_version="test-svg-v1",
        enable_glm_ocr=enable_glm_ocr,
        ocr_engine=ocr_engine,
        ocr_command=ocr_command,
        ocr_command_timeout_seconds=ocr_command_timeout_seconds,
        temp_dir=temp_dir / "tmp",
        media_dir=temp_dir / "media",
        default_machine="",
        default_material="МДФ 16мм",
    )
    worker.state = StateStore(temp_dir / "state.json")
    worker.erp = FakeErpClient()
    return worker


if __name__ == "__main__":
    unittest.main()
