from __future__ import annotations

import unittest
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx

from cnc_telegram_worker.erp_client import BackendAuth, ErpClient


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


def response(status_code: int, payload: dict[str, Any] | None = None) -> httpx.Response:
    request = httpx.Request("POST", "http://backend/api/v1/cnc-telegram/ingest")
    return httpx.Response(status_code, request=request, json=payload or {})


class ErpClientTest(unittest.IsolatedAsyncioTestCase):
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
            with self.assertRaises(httpx.HTTPStatusError):
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


if __name__ == "__main__":
    unittest.main()
