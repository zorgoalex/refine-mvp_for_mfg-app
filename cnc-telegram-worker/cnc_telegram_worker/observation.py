from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass
from pathlib import PurePath
from typing import Any

from .telegram_source import is_gcode_message, is_image_message, message_filename, peer_id


MAX_OBSERVATION_MESSAGES = 3
MAX_TELEGRAM_MESSAGE_ID = 2_147_483_647
MAX_OBSERVATION_MEDIA_BYTES = 15 * 1024 * 1024
OBSERVATION_FETCH_TIMEOUT_SECONDS = 60
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CLAIM_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


class ObservationReadError(RuntimeError):
    def __init__(self, reason: str, message: str) -> None:
        self.reason = reason
        super().__init__(message)


@dataclass(frozen=True)
class ObservationMessageFact:
    message_id: int
    chat_id: str
    role: str
    sha256: str
    present: bool
    thumbs_up: bool

    def as_report(self) -> dict[str, Any]:
        return {
            "messageId": self.message_id,
            "chatId": self.chat_id,
            "role": self.role,
            "sha256": self.sha256,
            "present": self.present,
            "thumbsUp": self.thumbs_up,
        }


class _HashBoundedSink:
    """File-like bounded sink accepted by Telethon; bytes are never spooled."""

    def __init__(self, message_id: int) -> None:
        self.name = f"cnc-observation-{message_id}.bin"
        self.size = 0
        self._digest = hashlib.sha256()
        self._closed = False

    def write(self, data: bytes) -> int:
        if self._closed:
            raise ValueError("observation media sink is closed")
        if not isinstance(data, bytes):
            raise TypeError("Telegram media chunk must be bytes")
        if self.size + len(data) > MAX_OBSERVATION_MEDIA_BYTES:
            raise ObservationReadError("MESSAGE_MEDIA_MISMATCH", "Telegram media exceeds the observation bound")
        self.size += len(data)
        self._digest.update(data)
        return len(data)

    def flush(self) -> None:
        return None

    def close(self) -> None:
        self._closed = True

    def hexdigest(self) -> str:
        return self._digest.hexdigest()

def _message_batch(value: Any, expected_ids: set[int]) -> dict[int, Any]:
    if value is None:
        return {}
    items = value if isinstance(value, (list, tuple)) else [value]
    messages: dict[int, Any] = {}
    for item in items:
        message_id = getattr(item, "id", None)
        if isinstance(message_id, bool) or not isinstance(message_id, int):
            continue
        if message_id not in expected_ids:
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Telegram returned an unrequested group message")
        if message_id in messages:
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Telegram returned a duplicate group message")
        messages[message_id] = item
    return messages


def _message_chat_id(message: Any) -> str | None:
    value = getattr(message, "chat_id", None)
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    peer = getattr(message, "peer_id", None)
    if peer is not None:
        try:
            return peer_id(peer)
        except Exception:
            return None
    return None


def _matches_role(message: Any, role: str) -> bool:
    filename = message_filename(message)
    suffix = PurePath(filename or "").suffix.lower()
    if role == "svg":
        return suffix == ".svg"
    if role == "gcode":
        return is_gcode_message(message)
    if role == "image":
        return is_image_message(message)
    return False


def _observation_has_thumbs_up(message: Any) -> bool:
    """Parse this observation's exact reaction snapshot strictly; malformed is never absence."""
    reactions = getattr(message, "reactions", None)
    if reactions is None:
        return False
    results = getattr(reactions, "results", None)
    if not isinstance(results, (list, tuple)):
        raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Telegram reaction state is malformed")
    thumbs_up = False
    for result in results:
        count = getattr(result, "count", None)
        reaction = getattr(result, "reaction", None)
        if isinstance(count, bool) or not isinstance(count, int) or count < 0 or reaction is None:
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Telegram reaction state is malformed")
        emoticon = getattr(reaction, "emoticon", None)
        # ReactionCustomEmoji is a valid non-emoji reaction type and has no
        # `emoticon`; other non-string values indicate a malformed payload.
        if emoticon is not None and not isinstance(emoticon, str):
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Telegram reaction state is malformed")
        if emoticon == "👍" and count > 0:
            thumbs_up = True
    return thumbs_up


def validate_observation_claim(claim: Any, current_chat_id: str) -> dict[str, Any]:
    if not isinstance(claim, dict):
        raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation claim is not an object")
    claim_id = claim.get("claimId")
    token = claim.get("claimToken")
    generation = claim.get("claimGeneration")
    source_chat_id = claim.get("sourceChatId")
    messages = claim.get("messages")
    if not isinstance(claim_id, str) or not _CLAIM_ID_RE.fullmatch(claim_id):
        raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation claim id is invalid")
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation claim token is invalid")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
        raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation claim generation is invalid")
    if not isinstance(source_chat_id, str) or source_chat_id != current_chat_id:
        raise ObservationReadError("MESSAGE_MEDIA_MISMATCH", "Observation claim targets a different Telegram chat")
    if not isinstance(messages, list) or not 1 <= len(messages) <= MAX_OBSERVATION_MESSAGES:
        raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation claim has an invalid message group")
    seen_ids: set[int] = set()
    seen_roles: set[str] = set()
    for item in messages:
        if not isinstance(item, dict):
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation message identity is invalid")
        message_id, role, sha = item.get("messageId"), item.get("role"), item.get("sha256")
        if (isinstance(message_id, bool) or not isinstance(message_id, int)
            or message_id <= 0 or message_id > MAX_TELEGRAM_MESSAGE_ID):
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation message id is invalid")
        if role not in {"svg", "gcode", "image"} or role in seen_roles:
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation group role is invalid")
        if message_id in seen_ids or not isinstance(sha, str) or not _SHA256_RE.fullmatch(sha):
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Observation message hash or identity is invalid")
        seen_ids.add(message_id)
        seen_roles.add(role)
    return claim


async def fetch_observation_facts(client: Any, entity: Any, claim: dict[str, Any], current_chat_id: str) -> list[dict[str, Any]]:
    """Fetch one exact post-claim group snapshot, hash media, and report facts only."""
    claim = validate_observation_claim(claim, current_chat_id)
    expected_ids = {item["messageId"] for item in claim["messages"]}
    deadline = asyncio.get_running_loop().time() + OBSERVATION_FETCH_TIMEOUT_SECONDS
    try:
        async with asyncio.timeout_at(deadline):
            fetched_batch = await client.get_messages(entity, ids=sorted(expected_ids))
    except TimeoutError as exc:
        raise ObservationReadError("FETCH_FAILED", "Telegram exact-message fetch timed out") from exc
    except Exception as exc:
        raise ObservationReadError("FETCH_FAILED", "Telegram exact-message fetch failed") from exc
    fetched_by_id = _message_batch(fetched_batch, expected_ids)
    if fetched_by_id.keys() != expected_ids:
        raise ObservationReadError("MESSAGE_MISSING", "A registered Telegram group message is unavailable")

    facts: list[dict[str, Any]] = []
    for expected in claim["messages"]:
        message_id = expected["messageId"]
        fetched = fetched_by_id[message_id]
        if _message_chat_id(fetched) != current_chat_id:
            raise ObservationReadError("MESSAGE_MEDIA_MISMATCH", "Fetched Telegram message belongs to a different chat")
        if not _matches_role(fetched, expected["role"]):
            raise ObservationReadError("MESSAGE_MEDIA_MISMATCH", "Fetched Telegram message does not match its registered role")
        if not hasattr(fetched, "reactions"):
            raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Telegram response omitted reaction state")
        media = getattr(fetched, "file", None)
        declared_size = getattr(media, "size", None)
        if isinstance(declared_size, int) and declared_size > MAX_OBSERVATION_MEDIA_BYTES:
            raise ObservationReadError("MESSAGE_MEDIA_MISMATCH", "Telegram media exceeds the observation bound")
        sink = _HashBoundedSink(message_id)
        try:
            async with asyncio.timeout_at(deadline):
                await fetched.download_media(file=sink)
        except ObservationReadError:
            raise
        except TimeoutError as exc:
            raise ObservationReadError("FETCH_FAILED", "Telegram media fetch timed out") from exc
        except Exception as exc:
            raise ObservationReadError("FETCH_FAILED", "Telegram media fetch failed") from exc
        finally:
            sink.close()
        if sink.size <= 0:
            raise ObservationReadError("MESSAGE_MISSING", "Telegram returned no media bytes")
        actual_sha = sink.hexdigest()
        if actual_sha != expected["sha256"]:
            raise ObservationReadError("MESSAGE_MEDIA_MISMATCH", "Fetched Telegram media hash does not match registration")
        facts.append(ObservationMessageFact(
            message_id=message_id,
            chat_id=current_chat_id,
            role=expected["role"],
            sha256=actual_sha,
            present=True,
            thumbs_up=_observation_has_thumbs_up(fetched),
        ).as_report())
    if len(facts) != len(claim["messages"]):
        raise ObservationReadError("MESSAGE_GROUP_INCOMPLETE", "Not all registered messages were fetched")
    return facts
