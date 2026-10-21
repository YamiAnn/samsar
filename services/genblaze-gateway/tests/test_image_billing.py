"""Exercise the actual gateway polling method without provider credentials."""

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest


class ImageBillingTests(unittest.IsolatedAsyncioTestCase):
    async def poll(self, *, modality="image", cost=None):
        source = Path(__file__).resolve().parents[1] / "app" / "runtime.py"
        tree = ast.parse(source.read_text())
        method = next(node for node in ast.walk(tree)
                      if isinstance(node, ast.AsyncFunctionDef) and node.name == "poll_media")
        namespace = {"Any": Any, "asyncio": asyncio, "_terminal_status": lambda step: "succeeded"}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), namespace)
        step = SimpleNamespace(cost_usd=cost, assets=[SimpleNamespace(url="https://example/image.png", media_type="image/png")])
        calls = []
        provider = SimpleNamespace(
            poll=lambda request_id: calls.append(request_id) or True,
            fetch_output=lambda request_id, pending: step,
        )
        runtime = SimpleNamespace(
            _require_ready=lambda: (SimpleNamespace(provider_error_type=RuntimeError),
                                    SimpleNamespace(decode=lambda request_id: ("image-model", "upstream-id"))),
            _resolve_model=lambda model: SimpleNamespace(modality=modality),
            _provider_for=lambda route: provider,
            _build_media_step=lambda *args: step,
        )
        result = await namespace["poll_media"](runtime, "opaque-request")
        self.assertEqual(calls, ["upstream-id"])
        self.assertEqual(result["assets"], [{"url": "https://example/image.png", "media_type": "image/png"}])
        return result

    async def test_completed_image_preserves_reported_charge(self):
        self.assertEqual((await self.poll(cost=0.125))["billing"], {"cost_usd": 0.125})

    async def test_reported_zero_charge_is_preserved(self):
        self.assertEqual((await self.poll(cost=0))["billing"], {"cost_usd": 0})

    async def test_missing_charge_is_not_invented(self):
        self.assertNotIn("billing", await self.poll())

    async def test_video_and_audio_preserve_actual_charge(self):
        for modality in ["video", "audio"]:
            self.assertEqual((await self.poll(modality=modality, cost=0.125))["billing"], {"cost_usd": 0.125})


if __name__ == "__main__":
    unittest.main()
