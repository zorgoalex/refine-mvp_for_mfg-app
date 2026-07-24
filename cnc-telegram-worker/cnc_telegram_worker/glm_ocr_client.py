from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

import httpx


async def post_image(image_path: Path, runner_url: str, timeout_seconds: float) -> dict:
    data = image_path.read_bytes()
    headers = {"Content-Type": "application/octet-stream"}
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.post(runner_url, content=data, headers=headers)
        response.raise_for_status()
        return response.json()


def main() -> None:
    parser = argparse.ArgumentParser(prog="glm-ocr-client")
    parser.add_argument("--image", required=True)
    parser.add_argument("--url", default=os.environ.get("GLM_OCR_RUNNER_URL", "http://glm-ocr-runner:8001/ocr"))
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("GLM_OCR_CLIENT_TIMEOUT_SECONDS", "660")))
    args = parser.parse_args()

    result = asyncio.run(post_image(Path(args.image), args.url, args.timeout))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
