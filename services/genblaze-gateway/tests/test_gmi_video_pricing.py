"""GMICloud Seedance charges must come from verified request and card data."""

from __future__ import annotations

import copy

import pytest

from app.gmi_video_pricing import SEEDANCE_2_MODEL_ID, seedance_2_cost_usd


@pytest.fixture
def completed_request():
    return {
        "model": SEEDANCE_2_MODEL_ID,
        "status": "success",
        "created_at": 200,
        "payload": {"duration": 5, "resolution": "720p", "generate_audio": True},
    }


@pytest.fixture
def model_card():
    return {
        "model": SEEDANCE_2_MODEL_ID,
        "updated_at": 100,
        "price_info": {"pricing_type": "per_second", "unit": "second"},
        "pricing_details": "Per second: 480p=$0.07, 720p=$0.152, 1080p=$0.374",
        "percentage_discount": 0,
    }


@pytest.mark.parametrize("generate_audio", [True, False])
def test_prices_720p_with_or_without_audio(completed_request, model_card, generate_audio):
    completed_request["payload"]["generate_audio"] = generate_audio
    assert seedance_2_cost_usd(completed_request, model_card) == 0.76


def test_applies_account_discount(completed_request, model_card):
    model_card["percentage_discount"] = 10
    assert seedance_2_cost_usd(completed_request, model_card) == pytest.approx(0.684)


@pytest.mark.parametrize(
    ("request_change", "card_change"),
    [
        ({"model": "seedance-2-0-fast-260128"}, {}),
        ({"payload": {"duration": 5, "resolution": "4k"}}, {}),
        ({"payload": {"duration": None, "resolution": "720p"}}, {}),
        ({"payload": {"duration": float("inf"), "resolution": "720p"}}, {}),
        ({"payload": {"duration": 0, "resolution": "720p"}}, {}),
        ({}, {"model": "seedance-2-0-fast-260128"}),
        ({}, {"updated_at": 300}),
        ({}, {"price_info": {"pricing_type": "per_request", "unit": "request"}}),
        ({}, {"pricing_details": "Per second: 720p=$0.152"}),
        ({}, {"percentage_discount": 101}),
    ],
)
def test_fails_closed_when_charge_cannot_be_verified(
    completed_request, model_card, request_change, card_change
):
    request = {**copy.deepcopy(completed_request), **request_change}
    card = {**copy.deepcopy(model_card), **card_change}
    with pytest.raises(ValueError):
        seedance_2_cost_usd(request, card)
