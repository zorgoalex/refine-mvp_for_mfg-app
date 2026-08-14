from __future__ import annotations

import os
import unittest
from unittest.mock import patch

from cnc_telegram_worker.config import WorkerConfig


class WorkerConfigTest(unittest.TestCase):
    def test_defaults_keep_worker_disabled_on_test_stack(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            config = WorkerConfig.from_env()

        self.assertEqual(config.stack_env, "test")
        self.assertEqual(config.worker_role, "disabled")
        self.assertEqual(config.poll_interval_seconds, 60)
        self.assertEqual(config.manual_svg_send_poll_interval_seconds, 5)
        self.assertFalse(config.enable_glm_ocr)
        self.assertEqual(config.ocr_command_timeout_seconds, 180)
        self.assertEqual(config.glm_ocr_client_timeout_seconds, 660)
        self.assertFalse(config.enabled)
        self.assertFalse(config.can_send_manual_svg_uploads)

    def test_glm_ocr_fallback_requires_explicit_enable(self) -> None:
        with patch.dict(os.environ, {
            "CNC_ENABLE_GLM_OCR": "true",
            "CNC_OCR_COMMAND_TIMEOUT_SECONDS": "720",
        }, clear=True):
            config = WorkerConfig.from_env()

        self.assertTrue(config.enable_glm_ocr)
        self.assertEqual(config.ocr_command_timeout_seconds, 720)

    def test_enabled_glm_fallback_requires_consistent_runtime_bundle(self) -> None:
        base = {
            "ERP_STACK_ENV": "test",
            "CNC_TELEGRAM_WORKER_ROLE": "reader",
            "CNC_ENABLE_GLM_OCR": "true",
            "CNC_OCR_COMMAND": "python -m cnc_telegram_worker.rapid_ocr_client --image {image}",
            "CNC_OCR_ENGINE": "rapidocr",
            "CNC_OCR_COMMAND_TIMEOUT_SECONDS": "720",
        }
        with patch.dict(os.environ, base, clear=True):
            invalid = WorkerConfig.from_env()
        with self.assertRaisesRegex(RuntimeError, "glm_ocr_client"):
            invalid.require_worker_enabled()

        base.update({
            "CNC_OCR_COMMAND": "python -m cnc_telegram_worker.glm_ocr_client --image {image}",
            "CNC_OCR_ENGINE": "glm-ocr-0.9b-q8",
        })
        with patch.dict(os.environ, base, clear=True):
            valid = WorkerConfig.from_env()
        valid.require_worker_enabled()

    def test_writer_requires_prod_stack_by_default(self) -> None:
        with patch.dict(os.environ, {
            "ERP_STACK_ENV": "test",
            "CNC_TELEGRAM_WORKER_ROLE": "writer",
        }, clear=True):
            config = WorkerConfig.from_env()

        with self.assertRaisesRegex(RuntimeError, "ERP_STACK_ENV=prod"):
            config.require_worker_enabled()

    def test_reader_runs_without_chat_write_permission_on_test_stack(self) -> None:
        with patch.dict(os.environ, {
            "ERP_STACK_ENV": "test",
            "CNC_TELEGRAM_WORKER_ROLE": "reader",
            "CNC_TELEGRAM_ALLOW_NON_PROD_WRITER": "false",
        }, clear=True):
            config = WorkerConfig.from_env()

        self.assertTrue(config.enabled)
        self.assertFalse(config.can_write_chat)
        self.assertFalse(config.can_send_manual_svg_uploads)
        config.require_worker_enabled()

    def test_reader_can_send_only_manual_svg_uploads_when_enabled(self) -> None:
        with patch.dict(os.environ, {
            "ERP_STACK_ENV": "test",
            "CNC_TELEGRAM_WORKER_ROLE": "reader",
            "CNC_TELEGRAM_ENABLE_MANUAL_UPLOAD_SENDS": "true",
            "CNC_MANUAL_SVG_SEND_POLL_INTERVAL_SECONDS": "7",
        }, clear=True):
            config = WorkerConfig.from_env()

        self.assertTrue(config.enabled)
        self.assertFalse(config.can_write_chat)
        self.assertTrue(config.can_send_manual_svg_uploads)
        self.assertEqual(config.manual_svg_send_poll_interval_seconds, 7)
        config.require_worker_enabled()

    def test_writer_runs_on_prod_stack(self) -> None:
        with patch.dict(os.environ, {
            "ERP_STACK_ENV": "prod",
            "CNC_TELEGRAM_WORKER_ROLE": "writer",
        }, clear=True):
            config = WorkerConfig.from_env()

        self.assertTrue(config.enabled)
        self.assertTrue(config.can_write_chat)
        self.assertTrue(config.can_send_manual_svg_uploads)
        config.require_worker_enabled()

    def test_invalid_worker_role_is_rejected(self) -> None:
        with patch.dict(os.environ, {
            "CNC_TELEGRAM_WORKER_ROLE": "observer",
        }, clear=True):
            with self.assertRaisesRegex(RuntimeError, "CNC_TELEGRAM_WORKER_ROLE"):
                WorkerConfig.from_env()


if __name__ == "__main__":
    unittest.main()
