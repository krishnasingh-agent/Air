import cv2
import numpy as np
from fastapi.testclient import TestClient

from airpad.web import app, decode_frame, encode_frame


def test_health_endpoint():
    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json()["status"] in {"ok", "starting"}


def test_web_ui_is_served():
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert "AirPad" in response.text


def test_frame_decode_and_encode_round_trip():
    frame = np.full((480, 640, 3), 127, dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", frame)
    assert ok
    decoded = decode_frame(encoded.tobytes())
    output = encode_frame(decoded)
    assert output.startswith(b"\xff\xd8")
    assert cv2.imdecode(np.frombuffer(output, np.uint8), cv2.IMREAD_COLOR) is not None


def test_invalid_frame_is_rejected():
    try:
        decode_frame(b"not an image")
    except ValueError as exc:
        assert "invalid image frame" in str(exc)
    else:
        raise AssertionError("invalid frame was accepted")
