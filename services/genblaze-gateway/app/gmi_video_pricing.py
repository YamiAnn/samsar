"""Validated GMICloud video charges when its request detail omits billing."""

from __future__ import annotations

import math
import re
from decimal import Decimal, InvalidOperation
from typing import Any


SEEDANCE_2_MODEL_ID = "seedance-2-0-260128"
_SEEDANCE_2_PRICING = re.compile(
    r"Per second: 480p=\$(\d+(?:\.\d+)?), "
    r"720p=\$(\d+(?:\.\d+)?), "
    r"1080p=\$(\d+(?:\.\d+)?)"
)


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


def seedance_2_cost_usd(request: dict[str, Any], model: dict[str, Any]) -> float:
    """Price a completed request using GMI's live, resolution-specific model card.

    The request endpoint has no charge field. Its original submitted payload is
    the only reliable source of duration and resolution; the authenticated
    model card supplies the rate and account discount.
    """
    if request.get("status") != "success" or request.get("model") != SEEDANCE_2_MODEL_ID:
        raise ValueError("request is not a successful Seedance 2.0 generation")
    if model.get("model") != SEEDANCE_2_MODEL_ID:
        raise ValueError("model card does not match the generated model")

    created_at = _finite_decimal(request.get("created_at"))
    price_updated_at = _finite_decimal(model.get("updated_at"))
    if created_at <= 0 or price_updated_at <= 0 or price_updated_at > created_at:
        raise ValueError("model price changed after the request was submitted")

    price_info = model.get("price_info")
    if not isinstance(price_info, dict) or price_info.get("pricing_type") != "per_second":
        raise ValueError("model card has no per-second price")
    if price_info.get("unit") != "second":
        raise ValueError("model card has an unexpected price unit")
    pricing_details = model.get("pricing_details")
    if not isinstance(pricing_details, str):
        raise ValueError("model card has no pricing schedule")
    match = _SEEDANCE_2_PRICING.fullmatch(pricing_details)
    if match is None:
        raise ValueError("model card has an unknown pricing schedule")
    rates = dict(zip(("480p", "720p", "1080p"), map(Decimal, match.groups())))
    if any(rate <= 0 for rate in rates.values()):
        raise ValueError("model card has a non-positive price")

    payload = request.get("payload")
    if not isinstance(payload, dict) or payload.get("resolution") not in rates:
        raise ValueError("request resolution has no verified price")
    duration = _finite_decimal(payload.get("duration"))
    if duration <= 0 or duration > 15:
        raise ValueError("request duration is outside the supported range")
    discount = _finite_decimal(model.get("percentage_discount"))
    if discount < 0 or discount > 100:
        raise ValueError("model card has an invalid discount")

    charge = duration * rates[payload["resolution"]] * (Decimal(100) - discount) / Decimal(100)
    cost = float(charge)
    if not math.isfinite(cost):
        raise ValueError("computed charge is not finite")
    return cost
