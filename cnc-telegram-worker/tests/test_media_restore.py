from __future__ import annotations

import io
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from PIL import Image

telethon_stub = types.ModuleType("telethon")
telethon_stub.TelegramClient = object
telethon_stub.utils = types.SimpleNamespace(get_peer_id=lambda entity: entity)
sys.modules.setdefault("telethon", telethon_stub)

from cnc_telegram_worker.cleanup import cleanup_temp_dir
from cnc_telegram_worker.worker import (
    CncTelegramWorker,
    SHEET_PREVIEW_DIRECTORY,
    backfill_sheet_previews,
    persist_sheet_image,
    sheet_preview_key,
)


class ImageMessage:
    id = 10847
    file = SimpleNamespace(name="sheet.png", mime_type="image/png")
    photo = None

    def __init__(self, body: bytes) -> None:
        self.body = body

    async def download_media(self, *, file: str) -> str:
        Path(file).write_bytes(self.body)
        return file


class RestoreClient:
    def __init__(self, message: ImageMessage | None) -> None:
        self.message = message

    async def get_messages(self, _entity: object, *, ids: int):
        return self.message if self.message and ids == self.message.id else None


class MediaRestoreTest(unittest.IsolatedAsyncioTestCase):
    def test_persists_small_preview_and_cleanup_keeps_it(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            media_dir = Path(root, "media")
            source = Path(root, "source.png")
            source.write_bytes(png_bytes())

            media = persist_sheet_image(media_dir, "-100", 10847, source)
            preview = media_dir / SHEET_PREVIEW_DIRECTORY / sheet_preview_key(media["storageKey"])

            self.assertTrue(preview.is_file())
            with Image.open(preview) as image:
                self.assertLessEqual(image.width, 360)
                self.assertLessEqual(image.height, 240)

            old = 1_700_000_000
            os.utime(media_dir / media["storageKey"], (old, old))
            os.utime(preview, (old, old))
            cleanup_temp_dir(
                media_dir,
                1,
                excluded_relative_dirs=frozenset({SHEET_PREVIEW_DIRECTORY}),
            )
            self.assertFalse((media_dir / media["storageKey"]).exists())
            self.assertTrue(preview.exists())

    def test_backfills_missing_previews_once(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            media_dir = Path(root)
            Path(media_dir, "tg_100_10.png").write_bytes(png_bytes())

            self.assertEqual(backfill_sheet_previews(media_dir), 1)
            self.assertEqual(backfill_sheet_previews(media_dir), 0)

    def test_required_preview_failure_does_not_overwrite_existing_original(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            media_dir = Path(root, "media")
            valid = Path(root, "valid.png")
            invalid = Path(root, "invalid.png")
            valid.write_bytes(png_bytes())
            invalid.write_bytes(b"not-an-image")
            first = persist_sheet_image(media_dir, "-100", 10847, valid)
            original = media_dir / first["storageKey"]
            expected = original.read_bytes()

            with self.assertRaises(ValueError):
                persist_sheet_image(
                    media_dir,
                    "-100",
                    10847,
                    invalid,
                    require_preview=True,
                )

            self.assertEqual(original.read_bytes(), expected)

    async def test_worker_claims_downloads_and_completes_restore(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_media_restores=AsyncMock(return_value={
                    "capability": "cnc_telegram_media_restore_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000002",
                        "sourceChatId": "-100",
                        "sourceMessageId": 10847,
                        "storageKey": "tg_100_10847.png",
                    }],
                }),
                complete_media_restore=AsyncMock(return_value={}),
                fail_media_restore=AsyncMock(return_value={}),
            )

            await worker.process_media_restore_requests(RestoreClient(ImageMessage(png_bytes())), object(), "-100")

            worker.erp.complete_media_restore.assert_awaited_once()
            worker.erp.fail_media_restore.assert_not_awaited()
            self.assertTrue(Path(root, "media", "tg_100_10847.png").is_file())
            self.assertTrue(Path(root, "media", "previews", "tg_100_10847.preview.jpg").is_file())

    async def test_worker_reports_deleted_telegram_message(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = object.__new__(CncTelegramWorker)
            worker.config = SimpleNamespace(temp_dir=Path(root, "tmp"), media_dir=Path(root, "media"))
            worker.erp = SimpleNamespace(
                claim_media_restores=AsyncMock(return_value={
                    "capability": "cnc_telegram_media_restore_v1",
                    "tasks": [{
                        "requestId": "00000000-0000-4000-8000-000000000002",
                        "sourceChatId": "-100",
                        "sourceMessageId": 10847,
                        "storageKey": "tg_100_10847.png",
                    }],
                }),
                complete_media_restore=AsyncMock(return_value={}),
                fail_media_restore=AsyncMock(return_value={}),
            )

            await worker.process_media_restore_requests(RestoreClient(None), object(), "-100")

            worker.erp.complete_media_restore.assert_not_awaited()
            worker.erp.fail_media_restore.assert_awaited_once()
            self.assertIn("unavailable", worker.erp.fail_media_restore.await_args.args[1])


def png_bytes() -> bytes:
    stream = io.BytesIO()
    Image.new("RGB", (1200, 800), "#2f6fed").save(stream, format="PNG")
    return stream.getvalue()


if __name__ == "__main__":
    unittest.main()
