from __future__ import annotations

import asyncio
import hashlib
import importlib
import os
import sys
import types
import unittest

try:
    import telethon  # noqa: F401
except ImportError:
    telethon_stub = types.ModuleType("telethon")
    telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
    sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.observation import ObservationReadError, fetch_observation_facts


CLAIM_ID = "f7f6d9ab-1791-41b7-99ae-31a3bfe38880"
CHAT_ID = "-100123"


class FakeFile:
    def __init__(self, name: str, size: int) -> None:
        self.name = name
        self.size = size
        self.mime_type = "application/octet-stream"


class FakeMessage:
    def __init__(self, message_id: int, chat_id: str, role: str, payload: bytes, thumbs_up: bool = False) -> None:
        self.id = message_id
        self.chat_id = int(chat_id)
        suffix = {"svg": ".svg", "gcode": ".nc", "image": ".png"}[role]
        self.file = FakeFile(f"source{suffix}", len(payload))
        self.payload = payload
        self.reactions = types.SimpleNamespace(results=[types.SimpleNamespace(
            reaction=types.SimpleNamespace(emoticon="👍"), count=1,
        )]) if thumbs_up else None
        self.download_count = 0

    async def download_media(self, *, file: object) -> str:
        self.download_count += 1
        file.write(self.payload)  # type: ignore[attr-defined]
        return getattr(file, "name")


class FakeTelegram:
    def __init__(self, messages: list[FakeMessage]) -> None:
        self.messages = {message.id: message for message in messages}
        self.calls: list[int | list[int]] = []
        self.failure: Exception | None = None

    async def get_messages(self, _entity: object, *, ids: int | list[int]) -> object:
        self.calls.append(ids)
        if self.failure is not None:
            raise self.failure
        if isinstance(ids, list):
            return [self.messages.get(message_id) for message_id in ids]
        return self.messages.get(ids)


def message_identity(message_id: int, role: str, payload: bytes) -> dict[str, object]:
    return {"messageId": message_id, "role": role, "sha256": hashlib.sha256(payload).hexdigest()}


def claim(*, messages: list[dict[str, object]] | None = None, source_chat_id: str = CHAT_ID) -> dict[str, object]:
    return {
        "claimId": CLAIM_ID,
        "claimToken": "a" * 64,
        "claimGeneration": 2,
        "expiresAt": "2026-09-23T10:00:00Z",
        "packetId": "36c5788e-98f0-4e88-a236-8735294bd602",
        "sourceChatId": source_chat_id,
        "messages": messages or [
            message_identity(10, "svg", b"<svg/>") ,
            message_identity(11, "gcode", b"G1 X1"),
            message_identity(12, "image", b"image-bytes"),
        ],
        "acceptedRevisionKey": "import:1",
        "headVersion": "2",
        "correctionEpoch": "0",
        "rawSourceVersion": "1",
        "observationVersion": "1",
    }


class ObservationReaderTest(unittest.TestCase):
    def test_fetches_only_exact_postclaim_messages_hashes_all_media_and_reports_any_thumbsup(self) -> None:
        messages = [
            FakeMessage(10, CHAT_ID, "svg", b"<svg/>"),
            FakeMessage(11, CHAT_ID, "gcode", b"G1 X1", thumbs_up=True),
            FakeMessage(12, CHAT_ID, "image", b"image-bytes"),
        ]
        client = FakeTelegram(messages)
        facts = asyncio.run(fetch_observation_facts(client, object(), claim(), CHAT_ID))

        self.assertEqual(client.calls, [[10, 11, 12]])
        self.assertEqual([message.download_count for message in messages], [1, 1, 1])
        self.assertEqual([item["thumbsUp"] for item in facts], [False, True, False])
        self.assertTrue(all(item["present"] is True for item in facts))
        self.assertEqual([item["sha256"] for item in facts], [item["sha256"] for item in claim()["messages"]])
        self.assertEqual([item["chatId"] for item in facts], [CHAT_ID] * 3)

    def test_complete_no_reaction_snapshot_is_pending_fact(self) -> None:
        messages = [FakeMessage(10, CHAT_ID, "svg", b"<svg/>")]
        payload = [message_identity(10, "svg", b"<svg/>")]
        facts = asyncio.run(fetch_observation_facts(FakeTelegram(messages), object(), claim(messages=payload), CHAT_ID))
        self.assertEqual(facts, [{
            "messageId": 10,
            "chatId": CHAT_ID,
            "role": "svg",
            "sha256": hashlib.sha256(b"<svg/>").hexdigest(),
            "present": True,
            "thumbsUp": False,
        }])

    def test_missing_group_member_never_becomes_pending(self) -> None:
        client = FakeTelegram([FakeMessage(10, CHAT_ID, "svg", b"<svg/>")])
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(client, object(), claim(), CHAT_ID))
        self.assertEqual(raised.exception.reason, "MESSAGE_MISSING")
        self.assertEqual(client.calls, [[10, 11, 12]])

    def test_remote_fetch_error_is_reportable_failure_not_pending(self) -> None:
        client = FakeTelegram([])
        client.failure = OSError("offline")
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(client, object(), claim(), CHAT_ID))
        self.assertEqual(raised.exception.reason, "FETCH_FAILED")

    def test_wrong_chat_id_or_media_role_never_reports_completion(self) -> None:
        wrong_chat = FakeTelegram([FakeMessage(10, "-100999", "svg", b"<svg/>")])
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(
                wrong_chat, object(), claim(messages=[message_identity(10, "svg", b"<svg/>")]), CHAT_ID,
            ))
        self.assertEqual(raised.exception.reason, "MESSAGE_MEDIA_MISMATCH")
        self.assertEqual(wrong_chat.messages[10].download_count, 0)

        wrong_role = FakeTelegram([FakeMessage(10, CHAT_ID, "image", b"<svg/>")])
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(
                wrong_role, object(), claim(messages=[message_identity(10, "svg", b"<svg/>")]), CHAT_ID,
            ))
        self.assertEqual(raised.exception.reason, "MESSAGE_MEDIA_MISMATCH")
        self.assertEqual(wrong_role.messages[10].download_count, 0)

    def test_hash_mismatch_fails_closed(self) -> None:
        message = FakeMessage(10, CHAT_ID, "svg", b"<svg/>changed")
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(
                FakeTelegram([message]), object(), claim(messages=[message_identity(10, "svg", b"<svg/>")]), CHAT_ID,
            ))
        self.assertEqual(raised.exception.reason, "MESSAGE_MEDIA_MISMATCH")

    def test_oversize_media_fails_closed(self) -> None:
        message = FakeMessage(10, CHAT_ID, "svg", b"<svg/>")
        message.file.size = 15 * 1024 * 1024 + 1
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(
                FakeTelegram([message]), object(), claim(messages=[message_identity(10, "svg", b"<svg/>")]), CHAT_ID,
            ))
        self.assertEqual(raised.exception.reason, "MESSAGE_MEDIA_MISMATCH")
        self.assertEqual(message.download_count, 0)

    def test_missing_reaction_state_or_invalid_claim_does_not_call_telegram(self) -> None:
        message = FakeMessage(10, CHAT_ID, "svg", b"<svg/>")
        del message.reactions
        client = FakeTelegram([message])
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(
                client, object(), claim(messages=[message_identity(10, "svg", b"<svg/>")]), CHAT_ID,
            ))
        self.assertEqual(raised.exception.reason, "MESSAGE_GROUP_INCOMPLETE")

        invalid_client = FakeTelegram([])
        with self.assertRaises(ObservationReadError):
            asyncio.run(fetch_observation_facts(invalid_client, object(), claim(source_chat_id="-100999"), CHAT_ID))
        self.assertEqual(invalid_client.calls, [])

    def test_message_ids_obey_the_wire_int32_bound_before_telegram_fetch(self) -> None:
        oversized = 2_147_483_648
        client = FakeTelegram([FakeMessage(oversized, CHAT_ID, "svg", b"<svg/>")])
        with self.assertRaises(ObservationReadError) as raised:
            asyncio.run(fetch_observation_facts(
                client, object(), claim(messages=[message_identity(oversized, "svg", b"<svg/>")]), CHAT_ID,
            ))
        self.assertEqual(raised.exception.reason, "MESSAGE_GROUP_INCOMPLETE")
        self.assertEqual(client.calls, [])

        max_id = 2_147_483_647
        valid_client = FakeTelegram([FakeMessage(max_id, CHAT_ID, "svg", b"<svg/>")])
        facts = asyncio.run(fetch_observation_facts(
            valid_client, object(), claim(messages=[message_identity(max_id, "svg", b"<svg/>")]), CHAT_ID,
        ))
        self.assertEqual(facts[0]["messageId"], max_id)

    def test_malformed_reaction_counts_and_results_never_become_pending_or_completed(self) -> None:
        malformed_reactions = [
            types.SimpleNamespace(results=[types.SimpleNamespace(reaction=types.SimpleNamespace(emoticon="👍"), count=None)]),
            types.SimpleNamespace(results=[types.SimpleNamespace(reaction=types.SimpleNamespace(emoticon="👍"), count="1")]),
            types.SimpleNamespace(results=[types.SimpleNamespace(reaction=types.SimpleNamespace(emoticon="👍"), count=True)]),
            types.SimpleNamespace(results=[types.SimpleNamespace(reaction=types.SimpleNamespace(emoticon="👍"), count=-1)]),
            types.SimpleNamespace(results=[types.SimpleNamespace(reaction=types.SimpleNamespace(emoticon="👍"))]),
            types.SimpleNamespace(results=None),
            types.SimpleNamespace(),
        ]
        for reactions in malformed_reactions:
            with self.subTest(reactions=reactions):
                message = FakeMessage(10, CHAT_ID, "svg", b"<svg/>")
                message.reactions = reactions
                with self.assertRaises(ObservationReadError) as raised:
                    asyncio.run(fetch_observation_facts(
                        FakeTelegram([message]), object(),
                        claim(messages=[message_identity(10, "svg", b"<svg/>")]), CHAT_ID,
                    ))
                self.assertEqual(raised.exception.reason, "MESSAGE_GROUP_INCOMPLETE")

    def test_file_sink_is_not_pathlike_and_uses_telethon_stream_selection_when_available(self) -> None:
        from cnc_telegram_worker.observation import _HashBoundedSink

        sink = _HashBoundedSink(10)
        self.assertFalse(isinstance(sink, os.PathLike))
        self.assertFalse(hasattr(sink, "__fspath__"))
        self.assertTrue(callable(sink.write))

        current_telethon = sys.modules.get("telethon")
        had_test_stub = current_telethon is not None and not hasattr(current_telethon, "__path__")
        if had_test_stub:
            del sys.modules["telethon"]
        try:
            downloads = importlib.import_module("telethon.client.downloads")
        except ImportError:
            if had_test_stub and current_telethon is not None:
                sys.modules["telethon"] = current_telethon
            self.skipTest("Telethon is provided by the worker image, not installed in this test environment")
        DownloadMethods = downloads.DownloadMethods
        self.assertIs(DownloadMethods._get_proper_filename(sink, "document", ".svg"), sink)

    def test_exact_group_fetch_has_one_overall_timeout(self) -> None:
        class SlowMessage(FakeMessage):
            async def download_media(self, *, file: object) -> str:
                await asyncio.sleep(0.015)
                return await super().download_media(file=file)

        from unittest.mock import patch

        messages = [
            SlowMessage(10, CHAT_ID, "svg", b"<svg/>"),
            SlowMessage(11, CHAT_ID, "gcode", b"G1 X1"),
            SlowMessage(12, CHAT_ID, "image", b"image-bytes"),
        ]
        client = FakeTelegram(messages)
        with patch("cnc_telegram_worker.observation.OBSERVATION_FETCH_TIMEOUT_SECONDS", 0.025):
            with self.assertRaises(ObservationReadError) as raised:
                asyncio.run(fetch_observation_facts(client, object(), claim(), CHAT_ID))
        self.assertEqual(raised.exception.reason, "FETCH_FAILED")
        self.assertEqual(client.calls, [[10, 11, 12]])


if __name__ == "__main__":
    unittest.main()
