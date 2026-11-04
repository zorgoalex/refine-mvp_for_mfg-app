from __future__ import annotations

import asyncio
import time
import traceback
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

from .erp_client import ErpResponseError, SessionLeaseLost

CAPABILITY = "cnc_sawn_signal_observation_v1"
CLAIM_STALE_CODE = "CNC_SAWN_SIGNAL_CLAIM_STALE"
THUMBS_UP = "\U0001F44D"
MAX_AUTHOR_PAGES = 5
AUTHOR_PAGE_LIMIT = 100
MAX_CLAIM_MESSAGES = 100


def _telethon_api() -> SimpleNamespace:
    """Import Telethon lazily so pure helpers work without it (and tests can patch this)."""
    from telethon.errors import FloodWaitError, RPCError
    from telethon.tl.functions.messages import GetMessageReactionsListRequest
    from telethon.tl.types import ReactionEmoji

    return SimpleNamespace(
        FloodWaitError=FloodWaitError,
        RPCError=RPCError,
        GetMessageReactionsListRequest=GetMessageReactionsListRequest,
        ReactionEmoji=ReactionEmoji,
    )


def thumbs_count(message: Any) -> int:
    reactions = getattr(message, "reactions", None)
    if reactions is None:
        return 0
    for item in getattr(reactions, "results", None) or []:
        if getattr(getattr(item, "reaction", None), "emoticon", None) == THUMBS_UP:
            return max(int(getattr(item, "count", 0) or 0), 0)
    return 0


def can_see_list(message: Any) -> bool | None:
    reactions = getattr(message, "reactions", None)
    if reactions is None:
        return None
    value = getattr(reactions, "can_see_list", None)
    return None if value is None else bool(value)


def peer_identity(peer: Any) -> tuple[str, str] | None:
    """Map a Telethon Peer* object to (peerType, digits-only id)."""
    for name, kind, attr in (
        ("PeerUser", "user", "user_id"),
        ("PeerChannel", "channel", "channel_id"),
        ("PeerChat", "chat", "chat_id"),
    ):
        if type(peer).__name__ == name:
            value = getattr(peer, attr, None)
            if value is None:
                return None
            digits = str(abs(int(value)))
            return kind, digits
    return None


def display_name(entity: Any) -> str | None:
    if entity is None:
        return None
    title = getattr(entity, "title", None)
    if title:
        return str(title)[:200]
    parts = [getattr(entity, "first_name", None), getattr(entity, "last_name", None)]
    name = " ".join(str(part) for part in parts if part).strip()
    if name:
        return name[:200]
    username = getattr(entity, "username", None)
    return str(username)[:200] if username else None


def username_of(entity: Any) -> str | None:
    value = getattr(entity, "username", None) if entity is not None else None
    return str(value) if value else None


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_message_report(
    message_id: int,
    message: Any,
    *,
    authors: dict[str, Any] | None = None,
    read_error: str | None = None,
) -> dict[str, Any]:
    if read_error:
        return {
            "messageId": message_id,
            "present": True,
            "thumbsCount": 0,
            "canSeeList": None,
            "authors": None,
            "readError": read_error[:64],
        }
    if message is None:
        return {
            "messageId": message_id,
            "present": False,
            "thumbsCount": 0,
            "canSeeList": None,
            "authors": None,
            "readError": None,
        }
    return {
        "messageId": message_id,
        "present": True,
        "thumbsCount": thumbs_count(message),
        "canSeeList": can_see_list(message),
        "authors": authors,
        "readError": None,
    }


def authors_needed(message: Any, last_thumbs_count: int, authors_due: bool) -> bool:
    count = thumbs_count(message)
    return count > 0 and (bool(authors_due) or count != last_thumbs_count)


async def fetch_authors(
    client: Any,
    entity: Any,
    message_id: int,
    *,
    max_pages: int = MAX_AUTHOR_PAGES,
    page_limit: int = AUTHOR_PAGE_LIMIT,
    deadline: float | None = None,
) -> dict[str, Any]:
    api = _telethon_api()
    reactors: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    offset: str | None = None
    for _ in range(max_pages):
        if deadline is not None and time.monotonic() >= deadline:
            return {"state": "partial", "reactors": reactors}
        try:
            result = await client(api.GetMessageReactionsListRequest(
                peer=entity,
                id=message_id,
                reaction=api.ReactionEmoji(emoticon=THUMBS_UP),
                limit=page_limit,
                offset=offset,
            ))
        except api.FloodWaitError:
            return {"state": "partial", "reactors": reactors}
        except api.RPCError:
            if reactors:
                return {"state": "partial", "reactors": reactors}
            return {"state": "unavailable", "reactors": []}
        lookup: dict[tuple[str, str], Any] = {}
        for user in getattr(result, "users", None) or []:
            lookup[("user", str(abs(int(user.id))))] = user
        for chat in getattr(result, "chats", None) or []:
            kind = "channel" if type(chat).__name__ in {"Channel", "ChannelForbidden"} else "chat"
            lookup[(kind, str(abs(int(chat.id))))] = chat
        for item in getattr(result, "reactions", None) or []:
            identity = peer_identity(getattr(item, "peer_id", None))
            if identity is None or identity in seen:
                continue
            seen.add(identity)
            source = lookup.get(identity)
            reactors.append({
                "peerType": identity[0],
                "peerId": identity[1],
                "displayName": display_name(source),
                "username": username_of(source),
                "reactedAt": iso_utc(getattr(item, "date", None)),
            })
        offset = getattr(result, "next_offset", None)
        if not offset:
            return {"state": "complete", "reactors": reactors}
    return {"state": "partial", "reactors": reactors}


def _is_flood_wait(exc: BaseException) -> bool:
    try:
        return isinstance(exc, _telethon_api().FloodWaitError)
    except ImportError:
        return type(exc).__name__ == "FloodWaitError"


def _is_claim_stale(exc: ErpResponseError) -> bool:
    response = exc.response
    return response.status_code == 409 and CLAIM_STALE_CODE in (getattr(response, "text", "") or "")


def _error_code(exc: BaseException) -> str:
    if _is_flood_wait(exc):
        return "FLOOD_WAIT"
    try:
        if isinstance(exc, _telethon_api().RPCError):
            return "RPC_ERROR"
    except ImportError:
        pass
    return "READ_ERROR"


async def run_sawn_signal_cycle(
    erp: Any,
    client: Any,
    entity: Any,
    *,
    time_budget_seconds: float,
) -> int:
    """One claim -> read -> report pass. Returns the number of messages reported."""
    claim_response = await erp.claim_sawn_signals()
    if claim_response.get("capability") != CAPABILITY:
        raise RuntimeError(f"backend does not expose {CAPABILITY}")
    claim = claim_response.get("claim")
    if not claim:
        return 0
    started = time.monotonic()
    deadline = started + time_budget_seconds

    items: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    for item in claim.get("messages") or []:
        message_id = int(item["messageId"])
        if message_id in seen_ids:
            continue
        seen_ids.add(message_id)
        items.append({
            "messageId": message_id,
            "lastThumbsCount": int(item.get("lastThumbsCount") or 0),
            "authorsDue": bool(item.get("authorsDue")),
        })
    items = items[:MAX_CLAIM_MESSAGES]
    if not items:
        return 0

    try:
        fetched = await client.get_messages(entity, ids=[item["messageId"] for item in items])
    except Exception as exc:
        if _is_flood_wait(exc):
            print("sawn signals: FloodWait on get_messages; claim left to expire", flush=True)
            return 0
        raise
    if not isinstance(fetched, (list, tuple)):
        fetched = [fetched]
    fetched = list(fetched)
    bad_response = len(fetched) != len(items)

    reports: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        message_id = item["messageId"]
        if bad_response:
            reports.append(build_message_report(message_id, None, read_error="BAD_RESPONSE"))
            continue
        message = fetched[index]
        try:
            authors: dict[str, Any] | None = None
            if message is not None and authors_needed(message, item["lastThumbsCount"], item["authorsDue"]):
                if can_see_list(message) is False:
                    authors = {"state": "unavailable", "reactors": []}
                elif time.monotonic() >= deadline:
                    authors = {"state": "partial", "reactors": []}
                else:
                    authors = await fetch_authors(client, entity, message_id, deadline=deadline)
            reports.append(build_message_report(message_id, message, authors=authors))
        except Exception as exc:
            print(f"sawn signals: message {message_id} read failed: {exc}", flush=True)
            reports.append(build_message_report(message_id, None, read_error=_error_code(exc)))

    payload = {
        "claimId": claim["claimId"],
        "claimToken": claim["claimToken"],
        "observedAt": iso_utc(datetime.now(timezone.utc)),
        "messages": reports,
    }
    try:
        await erp.report_sawn_signals(payload)
    except ErpResponseError as exc:
        if _is_claim_stale(exc):
            print("sawn signals: claim is stale; continuing next cycle", flush=True)
            return 0
        raise
    return len(reports)


async def poll_sawn_signals(
    erp: Any,
    client: Any,
    entity: Any,
    stop_event: asyncio.Event,
    *,
    interval_seconds: float,
    time_budget_seconds: float,
    fatal_event: asyncio.Event | None = None,
) -> None:
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass
        if stop_event.is_set():
            break
        try:
            await run_sawn_signal_cycle(erp, client, entity, time_budget_seconds=time_budget_seconds)
        except SessionLeaseLost:
            if fatal_event is not None:
                fatal_event.set()
            stop_event.set()
            return
        except Exception as exc:
            print(f"sawn signal polling failed: {exc}", flush=True)
            traceback.print_exception(exc)
