from __future__ import annotations

import asyncio
import sys
import tempfile
import time
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

import httpx

from cnc_telegram_worker import sawn_signals as ss
from cnc_telegram_worker.erp_client import ErpResponseError, SessionLeaseLost
from cnc_telegram_worker.worker import CncTelegramWorker

THUMB = "\U0001F44D"


class FloodWaitError(Exception):
    pass


class RPCError(Exception):
    pass


class FakeRequest:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs


def fake_api() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        FloodWaitError=FloodWaitError,
        RPCError=RPCError,
        GetMessageReactionsListRequest=FakeRequest,
        ReactionEmoji=lambda emoticon: types.SimpleNamespace(emoticon=emoticon),
    )


class PeerUser:
    def __init__(self, user_id: int) -> None:
        self.user_id = user_id


class PeerChannel:
    def __init__(self, channel_id: int) -> None:
        self.channel_id = channel_id


class PeerChat:
    def __init__(self, chat_id: int) -> None:
        self.chat_id = chat_id


class Channel:
    def __init__(self, id: int, title: str) -> None:
        self.id = id
        self.title = title
        self.username = None


def msg(count: int | None = None, *, other: bool = False, can_see: bool | None = True) -> types.SimpleNamespace:
    results = []
    if other:
        results.append(types.SimpleNamespace(reaction=types.SimpleNamespace(emoticon="❤"), count=5))
    if count is not None:
        results.append(types.SimpleNamespace(reaction=types.SimpleNamespace(emoticon=THUMB), count=count))
    reactions = types.SimpleNamespace(results=results, can_see_list=can_see) if results or can_see is not None and count is not None else None
    return types.SimpleNamespace(reactions=reactions)


def reaction(peer: object, date: datetime | None = None) -> types.SimpleNamespace:
    item = types.SimpleNamespace(peer_id=peer)
    if date is not None:
        item.date = date
    return item


def page(reactions: list, next_offset: str | None, users: list | None = None, chats: list | None = None):
    return types.SimpleNamespace(reactions=reactions, next_offset=next_offset, users=users or [], chats=chats or [])


class PureHelpersTest(unittest.TestCase):
    def test_thumbs_count(self) -> None:
        self.assertEqual(ss.thumbs_count(types.SimpleNamespace(reactions=None)), 0)
        self.assertEqual(ss.thumbs_count(msg(other=True)), 0)
        self.assertEqual(ss.thumbs_count(msg(0)), 0)
        self.assertEqual(ss.thumbs_count(msg(2, other=True)), 2)

    def test_can_see_list(self) -> None:
        self.assertIsNone(ss.can_see_list(types.SimpleNamespace(reactions=None)))
        self.assertTrue(ss.can_see_list(msg(1, can_see=True)))
        self.assertFalse(ss.can_see_list(msg(1, can_see=False)))

    def test_peer_identity(self) -> None:
        self.assertEqual(ss.peer_identity(PeerUser(5)), ("user", "5"))
        self.assertEqual(ss.peer_identity(PeerChannel(1996415689)), ("channel", "1996415689"))
        self.assertEqual(ss.peer_identity(PeerChat(7)), ("chat", "7"))
        self.assertIsNone(ss.peer_identity(object()))

    def test_names_without_phone(self) -> None:
        user = types.SimpleNamespace(first_name="Иван", last_name="П", username="ivan", phone="+7")
        self.assertEqual(ss.display_name(user), "Иван П")
        self.assertEqual(ss.username_of(user), "ivan")
        self.assertEqual(ss.display_name(Channel(1, "Канал")), "Канал")

    def test_build_report_variants(self) -> None:
        missing = ss.build_message_report(1, None)
        self.assertEqual(missing, {"messageId": 1, "present": False, "thumbsCount": 0,
                                   "canSeeList": None, "authors": None, "readError": None})
        err = ss.build_message_report(2, msg(3), read_error="FLOOD_WAIT")
        self.assertEqual((err["present"], err["thumbsCount"], err["canSeeList"], err["authors"], err["readError"]),
                         (True, 0, None, None, "FLOOD_WAIT"))
        ok = ss.build_message_report(3, msg(2))
        self.assertEqual((ok["thumbsCount"], ok["canSeeList"], ok["readError"]), (2, True, None))


class FetchAuthorsTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        patcher = patch.object(ss, "_telethon_api", fake_api)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_complete_with_names_and_date(self) -> None:
        when = datetime(2026, 11, 4, 10, 0, tzinfo=timezone.utc)
        users = [types.SimpleNamespace(id=10, first_name="Иван", last_name=None, username="ivan")]
        client = AsyncMock(return_value=page(
            [reaction(PeerUser(10), when), reaction(PeerChannel(99))], None, users, [Channel(99, "Чат")],
        ))
        result = await ss.fetch_authors(client, "ent", 5)
        self.assertEqual(result["state"], "complete")
        self.assertEqual(result["reactors"][0], {
            "peerType": "user", "peerId": "10", "displayName": "Иван", "username": "ivan",
            "reactedAt": "2026-11-04T10:00:00Z",
        })
        second = result["reactors"][1]
        self.assertEqual((second["peerType"], second["peerId"], second["reactedAt"]), ("channel", "99", None))
        request = client.await_args.args[0]
        self.assertEqual(request.kwargs["reaction"].emoticon, THUMB)
        self.assertEqual(request.kwargs["limit"], 100)

    async def test_pagination_complete_on_last_page(self) -> None:
        client = AsyncMock(side_effect=[
            page([reaction(PeerUser(1))], "o1"),
            page([reaction(PeerUser(2))], None),
        ])
        result = await ss.fetch_authors(client, "ent", 5)
        self.assertEqual(result["state"], "complete")
        self.assertEqual(len(result["reactors"]), 2)
        self.assertEqual(client.await_args_list[1].args[0].kwargs["offset"], "o1")

    async def test_five_page_cap_is_partial(self) -> None:
        client = AsyncMock(side_effect=[page([reaction(PeerUser(i))], f"o{i}") for i in range(1, 9)])
        result = await ss.fetch_authors(client, "ent", 5)
        self.assertEqual(result["state"], "partial")
        self.assertEqual(client.await_count, 5)
        self.assertEqual(len(result["reactors"]), 5)

    async def test_flood_wait_partial_keeps_collected(self) -> None:
        client = AsyncMock(side_effect=[page([reaction(PeerUser(1))], "o1"), FloodWaitError()])
        result = await ss.fetch_authors(client, "ent", 5)
        self.assertEqual(result["state"], "partial")
        self.assertEqual(len(result["reactors"]), 1)

    async def test_rpc_error_unavailable(self) -> None:
        result = await ss.fetch_authors(AsyncMock(side_effect=RPCError()), "ent", 5)
        self.assertEqual(result, {"state": "unavailable", "reactors": []})


class FakeErp:
    def __init__(self, claim: dict | None, capability: str = ss.CAPABILITY) -> None:
        self.claim_payload = {"capability": capability, "claim": claim}
        self.reports: list[dict] = []
        self.report_error: Exception | None = None

    async def claim_sawn_signals(self) -> dict:
        return self.claim_payload

    async def report_sawn_signals(self, payload: dict) -> dict:
        if self.report_error is not None:
            raise self.report_error
        self.reports.append(payload)
        return {"accepted": True, "replay": False}


def claim_of(*messages: dict) -> dict:
    return {"claimId": "c1", "claimToken": "t1", "expiresAt": "2026-11-04T10:00:00Z", "messages": list(messages)}


def item(message_id: int, last: int = 0, due: bool = False) -> dict:
    return {"messageId": message_id, "lastThumbsCount": last, "authorsDue": due}


class CycleTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        patcher = patch.object(ss, "_telethon_api", fake_api)
        patcher.start()
        self.addCleanup(patcher.stop)

    def client(self, messages: list, authors: list | None = None) -> types.SimpleNamespace:
        calls = authors if authors is not None else []
        return types.SimpleNamespace(
            get_messages=AsyncMock(return_value=messages),
            __call__=None,
            calls=calls,
        )

    async def test_no_claim_returns_zero(self) -> None:
        erp = FakeErp(None)
        client = types.SimpleNamespace(get_messages=AsyncMock())
        self.assertEqual(await ss.run_sawn_signal_cycle(erp, client, "e", time_budget_seconds=10), 0)
        client.get_messages.assert_not_awaited()
        self.assertEqual(erp.reports, [])

    async def test_wrong_capability_raises(self) -> None:
        with self.assertRaises(RuntimeError):
            await ss.run_sawn_signal_cycle(FakeErp(None, "x"), types.SimpleNamespace(), "e", time_budget_seconds=1)

    async def test_missing_message_and_authors_rules(self) -> None:
        erp = FakeErp(claim_of(item(1), item(2, last=1), item(3, last=1, due=True), item(4, last=0), item(5)))
        fetch = AsyncMock(return_value={"state": "complete", "reactors": []})

        class Client:
            get_messages = AsyncMock(return_value=[None, msg(1), msg(1), msg(2), msg(0)])

        with patch.object(ss, "fetch_authors", fetch):
            count = await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=10)
        self.assertEqual(count, 5)
        Client.get_messages.assert_awaited_once()
        self.assertEqual(Client.get_messages.await_args.kwargs["ids"], [1, 2, 3, 4, 5])
        report = erp.reports[0]
        self.assertEqual((report["claimId"], report["claimToken"]), ("c1", "t1"))
        by_id = {m["messageId"]: m for m in report["messages"]}
        self.assertFalse(by_id[1]["present"])
        self.assertIsNone(by_id[2]["authors"])          # count unchanged, not due
        self.assertIsNotNone(by_id[3]["authors"])       # due
        self.assertIsNotNone(by_id[4]["authors"])       # changed
        self.assertIsNone(by_id[5]["authors"])          # zero thumbs
        self.assertEqual(fetch.await_count, 2)

    async def test_can_see_list_false_is_unavailable_without_fetch(self) -> None:
        erp = FakeErp(claim_of(item(1)))

        class Client:
            get_messages = AsyncMock(return_value=[msg(1, can_see=False)])

        fetch = AsyncMock()
        with patch.object(ss, "fetch_authors", fetch):
            await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=10)
        fetch.assert_not_awaited()
        self.assertEqual(erp.reports[0]["messages"][0]["authors"], {"state": "unavailable", "reactors": []})

    async def test_unexpected_exception_becomes_read_error(self) -> None:
        erp = FakeErp(claim_of(item(1), item(2)))

        class Client:
            get_messages = AsyncMock(return_value=[msg(1), msg(0)])

        with patch.object(ss, "fetch_authors", AsyncMock(side_effect=ValueError("boom"))):
            await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=10)
        first, second = erp.reports[0]["messages"]
        self.assertEqual(first["readError"], "READ_ERROR")
        self.assertEqual(first["thumbsCount"], 0)
        self.assertIsNone(second["readError"])

    async def test_flood_wait_on_get_messages_skips_report(self) -> None:
        erp = FakeErp(claim_of(item(1)))

        class Client:
            get_messages = AsyncMock(side_effect=FloodWaitError())

        self.assertEqual(await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=10), 0)
        self.assertEqual(erp.reports, [])

    async def test_flood_wait_during_authors_is_partial(self) -> None:
        erp = FakeErp(claim_of(item(1)))

        class Client:
            get_messages = AsyncMock(return_value=[msg(1)])

            async def __call__(self, _request: object) -> object:
                raise FloodWaitError()

        await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=10)
        self.assertEqual(erp.reports[0]["messages"][0]["authors"], {"state": "partial", "reactors": []})

    async def test_time_budget_exhausted_marks_partial(self) -> None:
        erp = FakeErp(claim_of(item(1), item(2)))

        class Client:
            get_messages = AsyncMock(return_value=[msg(1), msg(1)])

        fetch = AsyncMock()
        with patch.object(ss, "fetch_authors", fetch):
            await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=-1)
        fetch.assert_not_awaited()
        for entry in erp.reports[0]["messages"]:
            self.assertEqual(entry["authors"], {"state": "partial", "reactors": []})

    async def test_stale_claim_is_logged_not_raised(self) -> None:
        erp = FakeErp(claim_of(item(1)))
        response = httpx.Response(409, json={"code": ss.CLAIM_STALE_CODE},
                                  request=httpx.Request("POST", "http://x"))
        erp.report_error = ErpResponseError(response, "report")

        class Client:
            get_messages = AsyncMock(return_value=[msg(0)])

        self.assertEqual(await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=5), 0)

    async def test_other_report_error_propagates(self) -> None:
        erp = FakeErp(claim_of(item(1)))
        response = httpx.Response(500, json={}, request=httpx.Request("POST", "http://x"))
        erp.report_error = ErpResponseError(response, "report")

        class Client:
            get_messages = AsyncMock(return_value=[msg(0)])

        with self.assertRaises(ErpResponseError):
            await ss.run_sawn_signal_cycle(erp, Client(), "e", time_budget_seconds=5)


class PollLoopTest(unittest.IsolatedAsyncioTestCase):
    async def test_lease_lost_sets_fatal_and_stops(self) -> None:
        stop, fatal = asyncio.Event(), asyncio.Event()
        with patch.object(ss, "run_sawn_signal_cycle", AsyncMock(side_effect=SessionLeaseLost("x"))):
            await asyncio.wait_for(ss.poll_sawn_signals(
                object(), object(), object(), stop,
                interval_seconds=0.001, time_budget_seconds=1, fatal_event=fatal,
            ), 2)
        self.assertTrue(fatal.is_set())
        self.assertTrue(stop.is_set())

    async def test_other_errors_continue(self) -> None:
        stop = asyncio.Event()
        calls = 0

        async def cycle(*_a: object, **_k: object) -> int:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("boom")
            stop.set()
            return 0

        with patch.object(ss, "run_sawn_signal_cycle", cycle):
            await asyncio.wait_for(ss.poll_sawn_signals(
                object(), object(), object(), stop, interval_seconds=0.001, time_budget_seconds=1,
            ), 2)
        self.assertEqual(calls, 2)


class RunServeHookTest(unittest.IsolatedAsyncioTestCase):
    async def _serve(self, enabled: bool) -> AsyncMock:
        from tests.test_worker import make_worker  # reuse the existing harness

        poll = AsyncMock()
        with tempfile.TemporaryDirectory() as temp:
            worker = make_worker(Path(temp))
            cfg = worker.config
            cfg.enabled = True
            cfg.stack_env = "test"
            cfg.worker_role = "reader"
            cfg.telegram_session_path = Path(temp) / "session"
            cfg.telegram_api_id = 1
            cfg.telegram_api_hash = "hash"
            cfg.telegram_chat = "-100"
            cfg.telegram_allowed_chat_ids = ("-100",)
            cfg.erp_bearer_token = "token"
            cfg.audit_spool_path = Path(temp) / "audit.sqlite3"
            cfg.audit_allow_unsafe_path = True
            cfg.temp_ttl_hours = 1
            cfg.attachment_ttl_hours = 1
            cfg.can_send_manual_svg_uploads = False
            cfg.manual_import_enabled = False
            cfg.sawn_signal_poll_enabled = enabled
            cfg.sawn_signal_poll_interval_seconds = 7
            cfg.sawn_signal_batch_time_budget_seconds = 9
            cfg.session_lease_heartbeat_seconds = 30
            cfg.require_worker_enabled = lambda: None
            cfg.require_telegram = lambda: None
            cfg.require_backend_auth = lambda: None
            worker._claim_session_lease = AsyncMock()
            worker.erp.audit_capabilities = AsyncMock(return_value={})
            worker._heartbeat_session = AsyncMock()
            worker.process_media_restore_requests = AsyncMock()

            async def restore_poll(_c, _e, _id, stop_event, **_k) -> None:
                await asyncio.sleep(0)
                stop_event.set()

            worker.poll_media_restore_requests = restore_poll

            class Client:
                def __init__(self, *_a: object) -> None:
                    pass

                async def connect(self) -> None: ...
                async def is_user_authorized(self) -> bool: return True
                async def get_entity(self, _c: object) -> object: return object()
                async def get_me(self) -> object: return types.SimpleNamespace(id=1)
                async def disconnect(self) -> None: ...

            with (
                patch("cnc_telegram_worker.worker.TelegramClient", side_effect=Client),
                patch("cnc_telegram_worker.worker.assert_allowed_chat"),
                patch("cnc_telegram_worker.worker.peer_id", return_value="-100"),
                patch("cnc_telegram_worker.worker.backfill_sheet_previews"),
                patch("cnc_telegram_worker.worker.flush_audit_spool", new=AsyncMock()),
                patch("cnc_telegram_worker.worker.poll_sawn_signals", new=poll),
            ):
                await worker.run_serve()
        return poll

    async def test_task_started_only_when_enabled(self) -> None:
        poll = await self._serve(True)
        poll.assert_called_once()
        self.assertEqual(poll.call_args.kwargs["interval_seconds"], 7)
        self.assertEqual(poll.call_args.kwargs["time_budget_seconds"], 9)
        self.assertFalse(poll.call_args.kwargs["fatal_event"].is_set())

    async def test_task_not_started_when_disabled(self) -> None:
        poll = await self._serve(False)
        poll.assert_not_called()


if __name__ == "__main__":
    unittest.main()
