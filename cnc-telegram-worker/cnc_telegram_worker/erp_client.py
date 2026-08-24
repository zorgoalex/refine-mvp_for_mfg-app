from __future__ import annotations

import asyncio
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx


INGEST_MAX_ATTEMPTS = 3
INGEST_RETRY_BASE_SECONDS = 0.5
LOGIN_MAX_ATTEMPTS = 3
LOGIN_RETRY_BASE_SECONDS = 0.5
LOGIN_RETRY_MAX_SECONDS = 30.0
LOGIN_RETRY_SAFETY_MARGIN_SECONDS = 0.25
_IMPORT_SCAN_CANDIDATE_FIELDS = (
    "sourceChatId",
    "sourceMessageId",
    "sourceThreadId",
    "sourceCreatedAt",
    "sourceUpdatedAt",
    "workday",
    "svgMessageId",
    "gcodeMessageId",
    "screenshotMessageId",
    "svgFileName",
    "gcodeFileName",
    "screenshotFileName",
    "svgContentSha256",
    "gcodeContentSha256",
    "screenshotContentSha256",
    "sourceSetFingerprint",
    "parserVersion",
    "layoutFingerprint",
    "parsedSnapshot",
    "cutLayout",
    "warnings",
    "eligibilityStatus",
)
_IMPORT_SCAN_MESSAGE_FIELDS = (
    "sourceChatId",
    "sourceMessageId",
    "sourceThreadId",
    "replyToMessageId",
    "senderUserId",
    "sourceCreatedAt",
    "sourceUpdatedAt",
    "workday",
    "messageType",
    "filename",
    "mimeType",
    "messageText",
    "outgoing",
    "candidateSourceMessageId",
    "candidateRole",
    "readOrdinal",
)
_SECRET_PATTERNS = (
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.I), "Bearer [REDACTED]"),
    (re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{20,}\b"), "[BOT_TOKEN_REDACTED]"),
    (re.compile(r"\b(password|secret|api[_-]?hash|token)\s*[:=]\s*[^\s,;]+", re.I), r"\1=[REDACTED]"),
)


@dataclass
class BackendAuth:
    bearer_token: str = ""
    username: str = ""
    password: str = ""


@dataclass(frozen=True)
class WorkerSessionLease:
    token: str
    generation: int
    expires_at: str | None = None


class SessionLeaseLost(RuntimeError):
    """Raised when the backend fences this worker's global Telegram session."""


@dataclass(frozen=True)
class WorkerItemLease:
    """Opaque lease fencing one claimed queue item."""

    token: str
    generation: int
    owner: str


class ErpResponseError(RuntimeError):
    def __init__(self, response: httpx.Response, action: str) -> None:
        self.response = response
        super().__init__(response_error_message(response, action))


class ErpClient:
    def __init__(self, api_url: str, auth: BackendAuth, timeout_seconds: float = 60.0) -> None:
        self.api_url = api_url.rstrip("/")
        self.auth = auth
        self.timeout_seconds = timeout_seconds
        self._access_token = ""
        self._access_token_expires_at = datetime.min.replace(tzinfo=timezone.utc)
        self._session_lease: WorkerSessionLease | None = None
        self.worker_instance_id = ""
        self.session_chat_id = ""
        self.approved_scan_request_id = ""

    def set_worker_identity(self, worker_instance_id: str) -> None:
        self.worker_instance_id = worker_instance_id.strip()

    @property
    def session_lease(self) -> WorkerSessionLease | None:
        return self._session_lease

    def set_session_lease(self, lease: WorkerSessionLease | None) -> None:
        self._session_lease = lease
        if lease is None:
            self.session_chat_id = ""

    def set_approved_scan_request(self, request_id: str | None) -> None:
        self.approved_scan_request_id = (request_id or "").strip()

    async def claim_worker_session(
        self,
        *,
        chat_id: str,
        image_revision: str,
        lease_ttl_seconds: int,
        runtime_evidence: dict[str, Any] | None = None,
    ) -> WorkerSessionLease:
        if not self.worker_instance_id:
            raise RuntimeError("worker instance id is missing")
        data = await self._authorized_post(
            "/cnc-telegram/worker-session/claim",
            payload={
                "chatId": chat_id,
                "workerInstanceId": self.worker_instance_id,
                "imageRevision": image_revision,
                **({"runtime": runtime_evidence} if runtime_evidence is not None else {}),
            },
            session_bound=False,
        )
        lease = parse_session_lease(data)
        self._session_lease = lease
        self.session_chat_id = chat_id
        return lease

    async def heartbeat_worker_session(self) -> WorkerSessionLease:
        lease = self._session_lease
        if lease is None:
            raise SessionLeaseLost("worker session lease is not claimed")
        try:
            data = await self._authorized_post(
                "/cnc-telegram/worker-session/heartbeat",
                payload={"workerInstanceId": self.worker_instance_id},
                session_bound=True,
            )
        except ErpResponseError as exc:
            if exc.response.status_code in {401, 403, 409, 410, 423}:
                self._session_lease = None
                raise SessionLeaseLost("worker session lease heartbeat was rejected") from exc
            raise
        updated = parse_session_lease(data)
        if updated.generation != lease.generation or updated.token != lease.token:
            self._session_lease = None
            raise SessionLeaseLost("worker session lease generation changed")
        self._session_lease = updated
        return updated

    async def ingest_packet(self, packet: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        headers = {
            "Idempotency-Key": idempotency_key,
            "Authorization": await self._authorization_header(),
        }
        headers.update(self._session_headers())
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            for attempt in range(INGEST_MAX_ATTEMPTS):
                response = await client.post(f"{self.api_url}/cnc-telegram/ingest", json=packet, headers=headers)
                if response.status_code == 401 and not self.auth.bearer_token:
                    self._access_token = ""
                    headers["Authorization"] = await self._authorization_header(force=True)
                    response = await client.post(f"{self.api_url}/cnc-telegram/ingest", json=packet, headers=headers)
                self._raise_if_session_lease_error(response, "ERP ingest")
                if response.status_code < 500 or attempt + 1 >= INGEST_MAX_ATTEMPTS:
                    if response.is_error:
                        raise ErpResponseError(response, "ERP ingest")
                    return response.json()
                delay_seconds = INGEST_RETRY_BASE_SECONDS * (2 ** attempt)
                print(
                    f"ERP ingest returned {response.status_code}; "
                    f"retry {attempt + 2}/{INGEST_MAX_ATTEMPTS} in {delay_seconds:g}s",
                    flush=True,
                )
                await asyncio.sleep(delay_seconds)
        raise RuntimeError("ERP ingest retry loop finished without a response")

    async def audit_capabilities(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.get(
                f"{self.api_url}/cnc-telegram/worker-logs/capabilities",
                headers={"Authorization": await self._authorization_header(), **self._session_headers()},
            )
            if response.status_code == 401 and not self.auth.bearer_token:
                self._access_token = ""
                response = await client.get(
                    f"{self.api_url}/cnc-telegram/worker-logs/capabilities",
                    headers={"Authorization": await self._authorization_header(force=True), **self._session_headers()},
                )
            self._raise_if_session_lease_error(response, "ERP audit capabilities")
            if response.is_error:
                raise ErpResponseError(response, "ERP audit capabilities")
            data = response.json()
        if data.get("capability") != "cnc_telegram_worker_audit_v1":
            raise RuntimeError("backend does not expose cnc_telegram_worker_audit_v1")
        return data

    async def audit_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                f"{self.api_url}/cnc-telegram/worker-logs/batch",
                json=payload,
                headers={"Authorization": await self._authorization_header(), **self._session_headers()},
            )
            if response.status_code == 401 and not self.auth.bearer_token:
                self._access_token = ""
                response = await client.post(
                    f"{self.api_url}/cnc-telegram/worker-logs/batch",
                    json=payload,
                    headers={"Authorization": await self._authorization_header(force=True), **self._session_headers()},
                )
            self._raise_if_session_lease_error(response, "ERP audit batch")
            if response.is_error:
                raise ErpResponseError(response, "ERP audit batch")
            return response.json()

    async def technical_log_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._authorized_post("/cnc-telegram/worker-logs/technical/batch", payload=payload)

    async def claim_media_restores(self) -> dict[str, Any]:
        return await self._authorized_post("/cnc-telegram/media-restores/claim")

    async def complete_media_restore(
        self,
        request_id: str,
        media: dict[str, Any],
        item_lease: WorkerItemLease | None = None,
    ) -> dict[str, Any]:
        if not request_id:
            raise RuntimeError("media restore request id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/media-restores/{request_id}/complete",
            payload=with_item_lease(media, item_lease),
        )

    async def fail_media_restore(
        self,
        request_id: str,
        error: str,
        item_lease: WorkerItemLease | None = None,
    ) -> dict[str, Any]:
        if not request_id:
            raise RuntimeError("media restore request id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/media-restores/{request_id}/fail",
            payload=with_item_lease({"error": error[:500]}, item_lease),
        )

    async def claim_manual_svg_telegram_sends(self) -> dict[str, Any]:
        return await self._authorized_post("/cnc-telegram/manual-svg-telegram-sends/claim")

    async def complete_manual_svg_telegram_send(
        self,
        request_id: str,
        media: dict[str, Any],
        item_lease: WorkerItemLease | None = None,
    ) -> dict[str, Any]:
        if not request_id:
            raise RuntimeError("manual SVG Telegram send request id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/manual-svg-telegram-sends/{request_id}/complete",
            payload=with_item_lease(media, item_lease),
        )

    async def fail_manual_svg_telegram_send(
        self,
        request_id: str,
        error: str,
        item_lease: WorkerItemLease | None = None,
    ) -> dict[str, Any]:
        if not request_id:
            raise RuntimeError("manual SVG Telegram send request id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/manual-svg-telegram-sends/{request_id}/fail",
            payload=with_item_lease({"error": error[:500]}, item_lease),
        )

    async def claim_import_scans(self) -> dict[str, Any]:
        return await self._authorized_post("/cnc-telegram/import-worker/scans/claim")

    async def submit_import_scan_candidates(
        self,
        scan_id: str,
        candidates: list[dict[str, Any]],
        scan_lease: WorkerItemLease,
        *,
        messages: list[dict[str, Any]] | None = None,
        days_scanned: int | None = None,
        messages_scanned: int | None = None,
        truncated: bool | None = None,
    ) -> dict[str, Any]:
        if not scan_id:
            raise RuntimeError("import scan id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/import-worker/scans/{scan_id}/candidates/batch",
            payload=with_item_lease(
                {
                    "candidates": [serialize_import_scan_candidate(candidate) for candidate in candidates],
                    "messages": [serialize_import_scan_message(message) for message in (messages or [])],
                    **({"daysScanned": days_scanned} if days_scanned is not None else {}),
                    **({"messagesScanned": messages_scanned} if messages_scanned is not None else {}),
                    **({"truncated": truncated} if truncated is not None else {}),
                },
                scan_lease,
            ),
        )

    async def complete_import_scan(
        self,
        scan_id: str,
        progress: dict[str, Any] | None,
        scan_lease: WorkerItemLease,
    ) -> dict[str, Any]:
        if not scan_id:
            raise RuntimeError("import scan id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/import-worker/scans/{scan_id}/complete",
            payload=with_item_lease(progress or {}, scan_lease),
        )

    async def fail_import_scan(
        self,
        scan_id: str,
        error_code: str,
        error_message: str,
        scan_lease: WorkerItemLease,
    ) -> dict[str, Any]:
        if not scan_id:
            raise RuntimeError("import scan id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/import-worker/scans/{scan_id}/fail",
            payload=with_item_lease(
                {"errorCode": error_code[:80], "errorMessage": error_message[:500]},
                scan_lease,
            ),
        )

    async def claim_import_items(self) -> dict[str, Any]:
        return await self._authorized_post("/cnc-telegram/import-worker/imports/claim")

    async def complete_import_item(
        self,
        item_id: str,
        result: dict[str, Any],
        item_lease: WorkerItemLease,
    ) -> dict[str, Any]:
        if not item_id:
            raise RuntimeError("import item id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/import-worker/imports/{item_id}/complete",
            payload=with_item_lease(result, item_lease),
        )

    async def fail_import_item(
        self,
        item_id: str,
        error_code: str,
        error_message: str,
        item_lease: WorkerItemLease,
    ) -> dict[str, Any]:
        if not item_id:
            raise RuntimeError("import item id is missing")
        return await self._authorized_post(
            f"/cnc-telegram/import-worker/imports/{item_id}/fail",
            payload=with_item_lease(
                {"errorCode": error_code[:80], "errorMessage": error_message[:500]},
                item_lease,
            ),
        )

    async def _authorized_post(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        session_bound: bool = True,
    ) -> dict[str, Any]:
        headers = {"Authorization": await self._authorization_header()}
        if session_bound:
            headers.update(self._session_headers())
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(f"{self.api_url}{path}", json=payload, headers=headers)
            if response.status_code == 401 and not self.auth.bearer_token:
                self._access_token = ""
                headers["Authorization"] = await self._authorization_header(force=True)
                response = await client.post(f"{self.api_url}{path}", json=payload, headers=headers)
            if session_bound:
                self._raise_if_session_lease_error(response, f"ERP POST {path}")
            if response.is_error:
                raise ErpResponseError(response, f"ERP POST {path}")
            return response.json()

    def _raise_if_session_lease_error(self, response: httpx.Response, action: str) -> None:
        if response.status_code in {401, 403, 409, 410, 423} and response_is_session_lease_error(response):
            self._session_lease = None
            raise SessionLeaseLost(f"{action} rejected the worker session lease")

    def _session_headers(self) -> dict[str, str]:
        lease = self._session_lease
        headers: dict[str, str] = {}
        if self.worker_instance_id:
            headers["X-CNC-Telegram-Worker-Instance"] = self.worker_instance_id
        if self.session_chat_id:
            headers["X-CNC-Telegram-Chat-Id"] = self.session_chat_id
        if self.approved_scan_request_id:
            headers["X-CNC-Telegram-Scan-Request-Id"] = self.approved_scan_request_id
        if lease is not None:
            headers["X-CNC-Telegram-Session-Token"] = lease.token
            headers["X-CNC-Telegram-Session-Generation"] = str(lease.generation)
        return headers

    async def _authorization_header(self, force: bool = False) -> str:
        if self.auth.bearer_token:
            return f"Bearer {self.auth.bearer_token}"
        if not self.auth.username or not self.auth.password:
            raise RuntimeError("backend auth not configured")
        if not force and self._access_token and datetime.now(timezone.utc) + timedelta(minutes=2) < self._access_token_expires_at:
            return f"Bearer {self._access_token}"
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            for attempt in range(LOGIN_MAX_ATTEMPTS):
                response = await client.post(
                    f"{self.api_url}/auth/login",
                    json={"username": self.auth.username, "password": self.auth.password},
                )
                if response.status_code != 429 or attempt + 1 >= LOGIN_MAX_ATTEMPTS:
                    if response.is_error:
                        raise ErpResponseError(response, "backend login")
                    data = response.json()
                    break
                delay_seconds = login_retry_delay(response, attempt)
                print(
                    f"backend login returned 429; "
                    f"retry {attempt + 2}/{LOGIN_MAX_ATTEMPTS} in {delay_seconds:g}s",
                    flush=True,
                )
                await asyncio.sleep(delay_seconds)
            else:
                raise RuntimeError("backend login retry loop finished without a response")
        token = data.get("accessToken")
        if not isinstance(token, str) or not token:
            raise RuntimeError("backend login response has no accessToken")
        self._access_token = token
        self._access_token_expires_at = parse_expires_at(data.get("accessTokenExpiresAt"))
        return f"Bearer {self._access_token}"


def parse_expires_at(value: Any) -> datetime:
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            pass
    return datetime.now(timezone.utc) + timedelta(minutes=10)


def login_retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = parse_retry_after(response.headers.get("Retry-After"))
    if retry_after is not None:
        return min(retry_after, LOGIN_RETRY_MAX_SECONDS)

    reset_ms = response_reset_ms(response)
    if reset_ms is not None:
        return min(
            reset_ms / 1000 + LOGIN_RETRY_SAFETY_MARGIN_SECONDS,
            LOGIN_RETRY_MAX_SECONDS,
        )

    return min(LOGIN_RETRY_BASE_SECONDS * (2**attempt), LOGIN_RETRY_MAX_SECONDS)


def parse_retry_after(value: str | None) -> float | None:
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    try:
        delay_seconds = float(value)
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        delay_seconds = (retry_at.astimezone(timezone.utc) - datetime.now(timezone.utc)).total_seconds()
    if not math.isfinite(delay_seconds) or delay_seconds < 0:
        return None
    return delay_seconds


def response_reset_ms(response: httpx.Response) -> float | None:
    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    details_candidates: list[Any] = [payload.get("details")]
    nested_error = payload.get("error")
    if isinstance(nested_error, dict):
        details_candidates.append(nested_error.get("details"))
    for details in details_candidates:
        if not isinstance(details, dict):
            continue
        reset_ms = details.get("resetMs")
        if isinstance(reset_ms, bool):
            continue
        if isinstance(reset_ms, (int, float)) and math.isfinite(reset_ms) and reset_ms >= 0:
            return float(reset_ms)
    return None


def parse_session_lease(value: Any) -> WorkerSessionLease:
    if not isinstance(value, dict):
        raise RuntimeError("backend session lease response is invalid")
    token = value.get("leaseToken") or value.get("token")
    generation = value.get("leaseGeneration") or value.get("generation")
    if not isinstance(token, str) or not token:
        raise RuntimeError("backend session lease response has no lease token")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
        raise RuntimeError("backend session lease response has invalid generation")
    expires_at = value.get("expiresAt")
    return WorkerSessionLease(token=token, generation=generation, expires_at=expires_at if isinstance(expires_at, str) else None)


def parse_item_lease(value: Any) -> WorkerItemLease:
    if not isinstance(value, dict):
        raise RuntimeError("backend queue item lease is missing")
    nested = value.get("itemLease")
    source = nested if isinstance(nested, dict) else value
    token = source.get("itemLeaseToken") or source.get("leaseToken") or source.get("token")
    generation = source.get("itemLeaseGeneration") or source.get("leaseGeneration") or source.get("generation")
    owner = source.get("itemLeaseOwner") or source.get("leaseOwner") or source.get("owner") or source.get("workerInstanceId")
    if not isinstance(token, str) or not token.strip():
        raise RuntimeError("backend queue item lease has no token")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation <= 0:
        raise RuntimeError("backend queue item lease has invalid generation")
    if not isinstance(owner, str) or not owner.strip():
        raise RuntimeError("backend queue item lease has no owner")
    return WorkerItemLease(token=token.strip(), generation=generation, owner=owner.strip())


def with_item_lease(payload: dict[str, Any], item_lease: WorkerItemLease | None) -> dict[str, Any]:
    if item_lease is None:
        return payload
    return {
        **payload,
        "itemLeaseToken": item_lease.token,
        "itemLeaseGeneration": item_lease.generation,
        "itemLeaseOwner": item_lease.owner,
    }


def serialize_import_scan_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    """Serialize only fields accepted by the backend candidate batch DTO.

    Discovery keeps worker-only fields such as ``sourceFiles`` for source
    revalidation.  They must not cross the candidate batch HTTP boundary.
    """
    return {
        field: candidate[field]
        for field in _IMPORT_SCAN_CANDIDATE_FIELDS
        if field in candidate
    }


def serialize_import_scan_message(message: dict[str, Any]) -> dict[str, Any]:
    """Serialize only the bounded raw-message contract fields."""
    return {
        field: message[field]
        for field in _IMPORT_SCAN_MESSAGE_FIELDS
        if field in message
    }


def response_is_session_lease_error(response: httpx.Response) -> bool:
    try:
        payload = response.json()
    except (ValueError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict):
        return False
    candidates = [payload.get("code"), payload.get("errorCode")]
    nested = payload.get("error")
    if isinstance(nested, dict):
        candidates.extend([nested.get("code"), nested.get("errorCode")])
    return any(
        isinstance(candidate, str)
        and candidate in {
            "CNC_TELEGRAM_SESSION_LEASE_LOST",
            "CNC_TELEGRAM_SESSION_LEASE_REQUIRED",
            "CNC_TELEGRAM_SESSION_LEASE_STALE",
            "CNC_TELEGRAM_ITEM_LEASE_LOST",
            "CNC_TELEGRAM_ITEM_LEASE_REQUIRED",
            "CNC_TELEGRAM_ITEM_LEASE_STALE",
            "CNC_TELEGRAM_QUEUE_LEASE_STALE",
            "SESSION_LEASE_LOST",
        }
        for candidate in candidates
    )


def response_error_message(response: httpx.Response, action: str) -> str:
    reason = response.reason_phrase or "HTTP error"
    body = _response_body_excerpt(response)
    message = f"{action} failed with {response.status_code} {reason}"
    if body:
        message = f"{message}: {body}"
    return message


def _response_body_excerpt(response: httpx.Response) -> str:
    try:
        text = response.text
    except Exception:
        return ""
    text = " ".join(text.split())
    for pattern, replacement in _SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text[:1000]
