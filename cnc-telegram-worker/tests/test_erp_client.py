from __future__ import annotations

import unittest
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx

from cnc_telegram_worker.erp_client import (
    BackendAuth,
    ErpClient,
    ErpResponseError,
    SessionLeaseLost,
    WorkerItemLease,
    WorkerSessionLease,
)


class FakeAsyncClient:
    def __init__(self, responses: list[httpx.Response]) -> None:
        self.responses = responses
        self.post_calls = 0
        self.requests: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    async def post(self, *args: Any, **kwargs: Any) -> httpx.Response:
        self.requests.append((args, kwargs))
        response = self.responses[self.post_calls]
        self.post_calls += 1
        return response


def response(
    status_code: int,
    payload: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    request = httpx.Request("POST", "http://backend/api/v1/cnc-telegram/ingest")
    return httpx.Response(status_code, request=request, headers=headers, json=payload or {})


class ErpClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_backend_login_retries_429_using_retry_after(self) -> None:
        fake_http = FakeAsyncClient([
            response(429, {"code": "RATE_LIMIT_EXCEEDED"}, {"Retry-After": "7"}),
            response(200, {"accessToken": "access-token", "accessTokenExpiresAt": "2026-08-19T01:00:00Z"}),
        ])
        client = ErpClient(
            "http://backend/api/v1",
            BackendAuth(username="worker", password="secret"),
        )

        with (
            patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http),
            patch("cnc_telegram_worker.erp_client.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            authorization = await client._authorization_header()

        self.assertEqual(authorization, "Bearer access-token")
        self.assertEqual(fake_http.post_calls, 2)
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [7.0])

    async def test_backend_login_uses_bounded_reset_ms_delay_when_retry_after_invalid(self) -> None:
        fake_http = FakeAsyncClient([
            response(
                429,
                {"code": "RATE_LIMIT_EXCEEDED", "details": {"resetMs": 22_795}},
                {"Retry-After": "not-a-delay"},
            ),
            response(200, {"accessToken": "access-token"}),
        ])
        client = ErpClient(
            "http://backend/api/v1",
            BackendAuth(username="worker", password="secret"),
        )

        with (
            patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http),
            patch("cnc_telegram_worker.erp_client.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            await client._authorization_header()

        self.assertEqual(fake_http.post_calls, 2)
        self.assertAlmostEqual(sleep.await_args_list[0].args[0], 23.045)

    async def test_backend_login_uses_bounded_fallback_when_429_has_no_delay(self) -> None:
        fake_http = FakeAsyncClient([
            response(429, {"code": "RATE_LIMIT_EXCEEDED"}),
            response(200, {"accessToken": "access-token"}),
        ])
        client = ErpClient(
            "http://backend/api/v1",
            BackendAuth(username="worker", password="secret"),
        )

        with (
            patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http),
            patch("cnc_telegram_worker.erp_client.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            await client._authorization_header()

        self.assertEqual(fake_http.post_calls, 2)
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [0.5])

    async def test_backend_login_stops_after_bounded_429_retries(self) -> None:
        fake_http = FakeAsyncClient([
            response(429, {"code": "RATE_LIMIT_EXCEEDED"}),
            response(429, {"code": "RATE_LIMIT_EXCEEDED"}),
            response(429, {"code": "RATE_LIMIT_EXCEEDED"}),
        ])
        client = ErpClient(
            "http://backend/api/v1",
            BackendAuth(username="worker", password="secret"),
        )

        with (
            patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http),
            patch("cnc_telegram_worker.erp_client.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            with self.assertRaises(ErpResponseError):
                await client._authorization_header()

        self.assertEqual(fake_http.post_calls, 3)
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [0.5, 1.0])

    async def test_backend_login_does_not_retry_other_client_errors(self) -> None:
        fake_http = FakeAsyncClient([response(422, {"code": "VALIDATION_ERROR"})])
        client = ErpClient(
            "http://backend/api/v1",
            BackendAuth(username="worker", password="secret"),
        )

        with (
            patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http),
            patch("cnc_telegram_worker.erp_client.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            with self.assertRaises(ErpResponseError):
                await client._authorization_header()

        self.assertEqual(fake_http.post_calls, 1)
        sleep.assert_not_awaited()

    async def test_retries_transient_server_errors_with_same_request(self) -> None:
        fake_http = FakeAsyncClient([
            response(500),
            response(503),
            response(200, {"applied": True}),
        ])
        client = ErpClient("http://backend/api/v1", BackendAuth(bearer_token="test-token"))

        with (
            patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http),
            patch("cnc_telegram_worker.erp_client.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            result = await client.ingest_packet({"externalPacketKey": "packet-1"}, "idem-1")

        self.assertEqual(result, {"applied": True})
        self.assertEqual(fake_http.post_calls, 3)
        self.assertEqual([call.args[0] for call in sleep.await_args_list], [0.5, 1.0])

    async def test_does_not_retry_client_errors(self) -> None:
        fake_http = FakeAsyncClient([response(400)])
        client = ErpClient("http://backend/api/v1", BackendAuth(bearer_token="test-token"))

        with (
            patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http),
            patch("cnc_telegram_worker.erp_client.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            with self.assertRaises(ErpResponseError):
                await client.ingest_packet({"externalPacketKey": "packet-1"}, "idem-1")

        self.assertEqual(fake_http.post_calls, 1)
        sleep.assert_not_awaited()

    async def test_claims_and_completes_media_restore_with_worker_auth(self) -> None:
        fake_http = FakeAsyncClient([
            response(200, {"capability": "cnc_telegram_media_restore_v1", "tasks": []}),
            response(200, {"status": "completed"}),
        ])
        client = ErpClient("http://backend/api/v1", BackendAuth(bearer_token="test-token"))

        with patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http):
            await client.claim_media_restores()
            await client.complete_media_restore("request-1", {
                "storageKey": "tg_100_10.jpg", "contentType": "image/jpeg", "sizeBytes": 123,
            })

        self.assertTrue(fake_http.requests[0][0][0].endswith("/cnc-telegram/media-restores/claim"))
        self.assertTrue(fake_http.requests[1][0][0].endswith("/media-restores/request-1/complete"))
        self.assertEqual(fake_http.requests[1][1]["json"]["sizeBytes"], 123)

    async def test_claim_and_heartbeat_fence_queue_requests(self) -> None:
        fake_http = FakeAsyncClient([
            response(200, {"leaseToken": "lease-1", "leaseGeneration": 4, "expiresAt": "2026-08-18T23:00:00Z"}),
            response(200, {"leaseToken": "lease-1", "leaseGeneration": 4, "expiresAt": "2026-08-18T23:01:00Z"}),
            response(200, {"capability": "cnc_telegram_media_restore_v1", "tasks": []}),
        ])
        client = ErpClient("http://backend/api/v1", BackendAuth(bearer_token="test-token"))
        client.set_worker_identity("worker-1")

        with patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http):
            lease = await client.claim_worker_session(
                chat_id="-100", image_revision="image-abc", lease_ttl_seconds=90,
            )
            await client.heartbeat_worker_session()
            await client.claim_media_restores()

        self.assertEqual(lease, WorkerSessionLease("lease-1", 4, "2026-08-18T23:00:00Z"))
        claim_headers = fake_http.requests[0][1]["headers"]
        heartbeat_headers = fake_http.requests[1][1]["headers"]
        queue_headers = fake_http.requests[2][1]["headers"]
        self.assertNotIn("X-CNC-Telegram-Session-Token", claim_headers)
        self.assertEqual(heartbeat_headers["X-CNC-Telegram-Session-Token"], "lease-1")
        self.assertEqual(heartbeat_headers["X-CNC-Telegram-Session-Generation"], "4")
        self.assertEqual(heartbeat_headers["X-CNC-Telegram-Chat-Id"], "-100")
        self.assertEqual(queue_headers["X-CNC-Telegram-Worker-Instance"], "worker-1")

    async def test_heartbeat_rejection_is_fatal_and_clears_lease(self) -> None:
        fake_http = FakeAsyncClient([response(409, {"code": "CNC_TELEGRAM_SESSION_LEASE_LOST"})])
        client = ErpClient("http://backend/api/v1", BackendAuth(bearer_token="test-token"))
        client.set_worker_identity("worker-1")
        client.set_session_lease(WorkerSessionLease("lease-1", 4))

        with patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http):
            with self.assertRaises(SessionLeaseLost):
                await client.heartbeat_worker_session()

        self.assertIsNone(client.session_lease)

    async def test_item_lease_is_sent_on_queue_completion_and_failure(self) -> None:
        fake_http = FakeAsyncClient([
            response(200, {"status": "completed"}),
            response(200, {"status": "failed"}),
        ])
        client = ErpClient("http://backend/api/v1", BackendAuth(bearer_token="test-token"))
        item_lease = WorkerItemLease("item-token", 7, "worker-instance")

        with patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http):
            await client.complete_media_restore(
                "request-1",
                {"storageKey": "tg_100_10.jpg", "contentType": "image/jpeg", "sizeBytes": 123},
                item_lease,
            )
            await client.fail_manual_svg_telegram_send("request-2", "bad media", item_lease)

        self.assertEqual(fake_http.requests[0][1]["json"]["itemLeaseToken"], "item-token")
        self.assertEqual(fake_http.requests[0][1]["json"]["itemLeaseGeneration"], 7)
        self.assertEqual(fake_http.requests[0][1]["json"]["itemLeaseOwner"], "worker-instance")
        self.assertEqual(fake_http.requests[1][1]["json"]["itemLeaseToken"], "item-token")

    async def test_item_lease_stale_response_is_fatal(self) -> None:
        fake_http = FakeAsyncClient([response(409, {"code": "CNC_TELEGRAM_ITEM_LEASE_STALE"})])
        client = ErpClient("http://backend/api/v1", BackendAuth(bearer_token="test-token"))

        with patch("cnc_telegram_worker.erp_client.httpx.AsyncClient", return_value=fake_http):
            with self.assertRaises(SessionLeaseLost):
                await client.fail_media_restore("request-1", "stale", WorkerItemLease("item-token", 7, "worker-instance"))


if __name__ == "__main__":
    unittest.main()
