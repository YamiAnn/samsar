"""GMICloud Seedance charges use checked-in rates and submitted configuration."""

from __future__ import annotations

import copy

import pytest

from app.gmi_video_pricing import SEEDANCE_2_MODEL_ID, seedance_2_cost_usd


@pytest.fixture
def completed_request():
    return {
        "model": SEEDANCE_2_MODEL_ID,
        "status": "success",
        "created_at": 1792017234,
        "payload": {"duration": 5, "resolution": "720p", "generate_audio": True},
    }


@pytest.mark.parametrize("generate_audio", [True, False])
def test_prices_720p_with_or_without_audio(completed_request, generate_audio):
    completed_request["payload"]["generate_audio"] = generate_audio
    assert seedance_2_cost_usd(completed_request) == 0.76


@pytest.mark.parametrize(("resolution", "expected"), [("480p", 0.35), ("1080p", 1.87)])
def test_prices_other_supported_resolutions(completed_request, resolution, expected):
    completed_request["payload"]["resolution"] = resolution
    assert seedance_2_cost_usd(completed_request) == expected


@pytest.mark.parametrize(
    "request_change",
    [
        {"model": "seedance-2-0-fast-260128"},
        {"status": "pending"},
        {"created_at": 1792017233},
        {"payload": {"duration": 5, "resolution": "4k"}},
        {"payload": {"duration": None, "resolution": "720p"}},
        {"payload": {"duration": float("inf"), "resolution": "720p"}},
        {"payload": {"duration": 0, "resolution": "720p"}},
    ],
)
def test_fails_closed_when_submitted_configuration_cannot_be_priced(
    completed_request, request_change
):
    request = {**copy.deepcopy(completed_request), **request_change}
    with pytest.raises(ValueError):
        seedance_2_cost_usd(request)
