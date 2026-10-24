"""Exercise the actual gateway polling method without provider credentials."""

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest
import runpy


class ImageBillingTests(unittest.IsolatedAsyncioTestCase):
    async def poll(self, *, modality="image", cost=None, detail=None):
        source = Path(__file__).resolve().parents[1] / "app" / "runtime.py"
        tree = ast.parse(source.read_text())
        method = next(node for node in ast.walk(tree)
                      if isinstance(node, ast.AsyncFunctionDef) and node.name == "poll_media")
        usage_module = runpy.run_path(str(source.parent / "gmi_image_usage.py"))
        namespace = {"Any": Any, "asyncio": asyncio, "_terminal_status": lambda step: "succeeded",
                     "completed_image_usage": usage_module["completed_image_usage"]}
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(source), "exec"), namespace)
        step = SimpleNamespace(cost_usd=cost, metadata={},
                               assets=[SimpleNamespace(url="https://example/image.png", media_type="image/png")])
        calls = []
        cache = {"upstream-id": detail}
        consumed = []

        def fetch_output(request_id, pending):
            consumed.append(cache.pop(request_id, None))
            return step

        provider = SimpleNamespace(
            poll=lambda request_id: calls.append(request_id) or True,
            fetch_output=fetch_output,
            _get_cached_poll_result=lambda request_id: cache.pop(request_id, None),
            _cache_poll_result=lambda request_id, body: cache.update({request_id: body}),
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
        self.assertEqual(consumed, [detail])
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

    async def test_token_usage_survives_normal_poll_without_a_second_upstream_request(self):
        usage = {"promptTokenCount": 1000, "candidatesTokenCount": 1120,
                 "candidatesTokensDetails": [{"modality": "IMAGE", "tokenCount": 1120}]}
        result = await self.poll(detail={"status": "success", "outcome": {"usageMetadata": usage}})
        self.assertEqual(result["billing"], {"usage": usage})

    async def test_request_payload_cannot_supply_billing_usage(self):
        result = await self.poll(detail={"status": "success", "payload": {
            "usageMetadata": {"promptTokenCount": 0, "candidatesTokenCount": 0}}})
        self.assertNotIn("billing", result)

    async def test_missing_usage_keeps_result_without_inventing_model_card_estimates(self):
        result = await self.poll(detail={"status": "success", "outcome": {
            "media_urls": [{"url": "https://example/image.png"}]}})
        self.assertNotIn("billing", result)


if __name__ == "__main__":
    unittest.main()
