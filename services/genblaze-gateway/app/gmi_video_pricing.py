"""Checked-in GMICloud Seedance 2.0 base prices for completed video calls."""

from __future__ import annotations

import math
from decimal import Decimal, InvalidOperation
from typing import Any


SEEDANCE_2_MODEL_ID = "seedance-2-0-260128"

# One-time read-only snapshot of this account's model card on 2026-10-23.
# The account discount was 0%. Review these constants when provider prices
# change; completion must not fetch a live price or gate a saved output on it.
SEEDANCE_2_USD_PER_SECOND_BY_RESOLUTION = {
    "480p": Decimal("0.07"),
    "720p": Decimal("0.152"),
    "1080p": Decimal("0.374"),
}
SEEDANCE_2_TARIFF_EFFECTIVE_AT = Decimal("1792017234")


def _finite_decimal(value: Any) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ValueError("invalid numeric value")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("invalid numeric value") from exc
    if not result.is_finite():
        raise ValueError("non-finite numeric value")
    return result


def seedance_2_cost_usd(request: dict[str, Any]) -> float:
    """Price the submitted duration and resolution from checked-in base rates."""
    if request.get("status") != "success" or request.get("model") != SEEDANCE_2_MODEL_ID:
        raise ValueError("request is not a successful Seedance 2.0 generation")
    created_at = _finite_decimal(request.get("created_at"))
    if created_at < SEEDANCE_2_TARIFF_EFFECTIVE_AT:
        raise ValueError("request predates the checked-in Seedance 2.0 price")
    payload = request.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("request payload is missing")
    rate = SEEDANCE_2_USD_PER_SECOND_BY_RESOLUTION.get(payload.get("resolution"))
    if rate is None:
        raise ValueError("request resolution has no checked-in price")
    duration = _finite_decimal(payload.get("duration"))
    if duration <= 0 or duration > 15:
        raise ValueError("request duration is outside the supported range")

    cost = float(duration * rate)
    if not math.isfinite(cost):
        raise ValueError("computed charge is not finite")
    return cost
