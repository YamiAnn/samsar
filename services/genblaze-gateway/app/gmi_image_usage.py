"""Retain usage from the ordinary completed GMI image status response.

No price endpoint or additional request is involved. In particular, a model
card's approximate per-image price is not a substitute for token usage.
"""

from typing import Any


def completed_image_usage(step: Any, detail: Any = None) -> dict[str, Any] | None:
    roots = [detail, getattr(step, "provider_payload", None), getattr(step, "metadata", None)]
    for root in roots:
        pending = [root]
        while pending:
            value = pending.pop(0)
            if not isinstance(value, dict):
                continue
            for key in ("usageMetadata", "usage_metadata", "usage"):
                usage = value.get(key)
                if isinstance(usage, dict) and "promptTokenCount" in usage:
                    return usage
            # Do not inspect `payload`, which is the caller's submitted input.
            for key in ("outcome", "response", "result", "data", "raw", "gmicloud"):
                child = value.get(key)
                if isinstance(child, dict):
                    pending.append(child)
    return None
