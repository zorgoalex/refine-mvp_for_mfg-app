from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from cnc_telegram_worker.ocr import run_ocr_command


class OcrCommandTest(unittest.TestCase):
    def test_quotes_image_path_with_spaces(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            image = Path(temp) / "sheet image (1).png"
            image.write_bytes(b"not-used")
            command = "python3 -c 'import json; print(json.dumps({\"items\": []}))' --image {image}"

            result = asyncio.run(run_ocr_command(command, image, timeout_seconds=10))

            self.assertEqual(result.items, [])
            self.assertEqual(result.analysis_warnings, [])


if __name__ == "__main__":
    unittest.main()
