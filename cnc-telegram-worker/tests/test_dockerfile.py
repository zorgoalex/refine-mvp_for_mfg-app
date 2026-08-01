from __future__ import annotations

import unittest
from pathlib import Path


class DockerfileTest(unittest.TestCase):
    def test_worker_package_permissions_are_normalized_after_copy(self) -> None:
        dockerfile = Path(__file__).resolve().parents[1] / "Dockerfile"
        source = dockerfile.read_text(encoding="utf-8")

        self.assertIn("chown -R worker:worker /app/cnc_telegram_worker", source)
        self.assertIn("find /app/cnc_telegram_worker -type d -exec chmod 0755", source)
        self.assertIn("find /app/cnc_telegram_worker -type f -exec chmod 0644", source)


if __name__ == "__main__":
    unittest.main()
