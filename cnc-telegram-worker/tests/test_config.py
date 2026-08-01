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
        self.assertFalse(config.enabled)

    def test_writer_requires_prod_stack_by_default(self) -> None:
        with patch.dict(os.environ, {
            "ERP_STACK_ENV": "test",
            "CNC_TELEGRAM_WORKER_ROLE": "writer",
        }, clear=True):
            config = WorkerConfig.from_env()

        with self.assertRaisesRegex(RuntimeError, "ERP_STACK_ENV=prod"):
            config.require_worker_enabled()

    def test_writer_runs_on_prod_stack(self) -> None:
        with patch.dict(os.environ, {
            "ERP_STACK_ENV": "prod",
            "CNC_TELEGRAM_WORKER_ROLE": "writer",
        }, clear=True):
            config = WorkerConfig.from_env()

        self.assertTrue(config.enabled)
        config.require_worker_enabled()

    def test_invalid_worker_role_is_rejected(self) -> None:
        with patch.dict(os.environ, {
            "CNC_TELEGRAM_WORKER_ROLE": "reader",
        }, clear=True):
            with self.assertRaisesRegex(RuntimeError, "CNC_TELEGRAM_WORKER_ROLE"):
                WorkerConfig.from_env()


if __name__ == "__main__":
    unittest.main()
