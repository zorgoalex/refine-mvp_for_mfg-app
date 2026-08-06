from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx


INGEST_MAX_ATTEMPTS = 3
INGEST_RETRY_BASE_SECONDS = 0.5


@dataclass
class BackendAuth:
    bearer_token: str = ""
    username: str = ""
    password: str = ""


class ErpClient:
    def __init__(self, api_url: str, auth: BackendAuth, timeout_seconds: float = 60.0) -> None:
        self.api_url = api_url.rstrip("/")
        self.auth = auth
        self.timeout_seconds = timeout_seconds
        self._access_token = ""
        self._access_token_expires_at = datetime.min.replace(tzinfo=timezone.utc)

    async def ingest_packet(self, packet: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        headers = {
            "Idempotency-Key": idempotency_key,
            "Authorization": await self._authorization_header(),
        }
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            for attempt in range(INGEST_MAX_ATTEMPTS):
                response = await client.post(f"{self.api_url}/cnc-telegram/ingest", json=packet, headers=headers)
                if response.status_code == 401 and not self.auth.bearer_token:
                    self._access_token = ""
                    headers["Authorization"] = await self._authorization_header(force=True)
                    response = await client.post(f"{self.api_url}/cnc-telegram/ingest", json=packet, headers=headers)
                if response.status_code < 500 or attempt + 1 >= INGEST_MAX_ATTEMPTS:
                    response.raise_for_status()
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
                headers={"Authorization": await self._authorization_header()},
            )
            if response.status_code == 401 and not self.auth.bearer_token:
                self._access_token = ""
                response = await client.get(
                    f"{self.api_url}/cnc-telegram/worker-logs/capabilities",
                    headers={"Authorization": await self._authorization_header(force=True)},
                )
            response.raise_for_status()
            data = response.json()
        if data.get("capability") != "cnc_telegram_worker_audit_v1":
            raise RuntimeError("backend does not expose cnc_telegram_worker_audit_v1")
        return data

    async def audit_batch(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                f"{self.api_url}/cnc-telegram/worker-logs/batch",
                json=payload,
                headers={"Authorization": await self._authorization_header()},
            )
            if response.status_code == 401 and not self.auth.bearer_token:
                self._access_token = ""
                response = await client.post(
                    f"{self.api_url}/cnc-telegram/worker-logs/batch",
                    json=payload,
                    headers={"Authorization": await self._authorization_header(force=True)},
                )
            response.raise_for_status()
            return response.json()

    async def _authorization_header(self, force: bool = False) -> str:
        if self.auth.bearer_token:
            return f"Bearer {self.auth.bearer_token}"
        if not self.auth.username or not self.auth.password:
            raise RuntimeError("backend auth not configured")
        if not force and self._access_token and datetime.now(timezone.utc) + timedelta(minutes=2) < self._access_token_expires_at:
            return f"Bearer {self._access_token}"
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                f"{self.api_url}/auth/login",
                json={"username": self.auth.username, "password": self.auth.password},
            )
            response.raise_for_status()
            data = response.json()
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
