"""Dependency-free checks for Astra's exact text and vision gateway routes."""

import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app.catalog import CURATED_SAMSAR_MODELS, CatalogConfigurationError, load_model_catalog


class AstraCatalogTests(unittest.TestCase):
    def load(self, upstream="openai/gpt-6-astra"):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text(json.dumps({
                "version": 1,
                "provider": "gmicloud",
                "credentialFingerprint": hashlib.sha256(b"astra-test-key").hexdigest(),
                "models": {"gpt-6-astra": {
                    "text": {"modelId": upstream, "operation": "chat.completions"},
                    "vision": {"modelId": upstream, "operation": "chat.completions"},
                }},
            }))
            return load_model_catalog(str(path), gmi_api_key="astra-test-key")

    def test_curated_text_and_vision_use_astra(self):
        route = CURATED_SAMSAR_MODELS["gpt-6-astra"]
        self.assertEqual(route.model_ids, ("openai/gpt-6-astra",))
        self.assertEqual(route.vision_model_ids, ("openai/gpt-6-astra",))
        self.assertNotIn("gpt-6.1-sol", CURATED_SAMSAR_MODELS)

    def test_validated_astra_mapping_preserves_both_modalities(self):
        catalog = self.load()
        route = catalog.resolve("gpt-6-astra", modality="text")
        self.assertEqual(route.gmi_model, "openai/gpt-6-astra")
        self.assertEqual(route.gmi_vision_model, "openai/gpt-6-astra")
        self.assertEqual(catalog.openai_model_list()["data"][0]["id"], "gpt-6-astra")

    def test_stale_sol_upstream_is_not_silently_used_for_astra(self):
        with self.assertRaises(CatalogConfigurationError):
            self.load("openai/gpt-6.1-sol")
