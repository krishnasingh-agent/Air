"""Browser-facing FastAPI service for AirPad."""

from __future__ import annotations

import asyncio
import time
import threading
from contextlib import suppress
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Config
from .engine import AirPadEngine
from .model import ensure_model

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
MODEL_LOCK = threading.Lock()

app = FastAPI(title="AirPad Web")
app.state.model_ready = False
app.state.model_error = None
app.mount("/static", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def decode_frame(data: bytes, max_width: int = 640, max_height: int = 480) -> np.ndarray:
    encoded = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if frame is None or frame.size == 0:
        raise ValueError("invalid image frame")
    height, width = frame.shape[:2]
    scale = min(1.0, max_width / width, max_height / height)
    if scale < 1.0:
        frame = cv2.resize(frame, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)
    return frame


def encode_frame(frame: np.ndarray, quality: int = 72) -> bytes:
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("could not encode processed frame")
    return encoded.tobytes()


def ensure_web_model(cfg: Config) -> None:
    if app.state.model_ready:
        return
    with MODEL_LOCK:
        if app.state.model_ready:
            return
        try:
            ensure_model(cfg.model_path)
            app.state.model_ready = True
            app.state.model_error = None
        except Exception as exc:
            app.state.model_error = str(exc)
            raise


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse({
        "status": "ok" if app.state.model_ready else "starting",
        "model_ready": bool(app.state.model_ready),
        "model_error": app.state.model_error,
    })


async def send_error(websocket: WebSocket, message: str) -> None:
    with suppress(RuntimeError):
        await websocket.send_json({"type": "error", "message": message})


@app.websocket("/ws")
async def websocket_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    cfg = Config(width=640, height=480, fps=15, infer_width=640, headless=True)
    engine: AirPadEngine | None = None
    loop = asyncio.get_running_loop()

    try:
        await loop.run_in_executor(None, ensure_web_model, cfg)
        await websocket.send_json({"type": "ready"})

        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            if "text" in message:
                import json
                try:
                    payload = json.loads(message["text"])
                    action = payload.get("action")
                    allowed = {"undo", "redo", "clear", "save", "board", "help", "landmarks",
                               "mirror", "toggle_eraser", "picker", "tool:pen", "tool:eraser",
                               "size:-", "size:+"}
                    if action in allowed:
                        if engine is None:
                            await send_error(websocket, "Camera frames have not started yet")
                        else:
                            await loop.run_in_executor(None, engine.do_action, action)
                            await websocket.send_json({"type": "action", "action": action})
                    else:
                        await send_error(websocket, "Unknown action")
                except (json.JSONDecodeError, AttributeError):
                    await send_error(websocket, "Invalid control message")
                continue

            data = message.get("bytes")
            if not data:
                continue

            try:
                frame = await loop.run_in_executor(None, decode_frame, data)
                if engine is None:
                    engine = AirPadEngine(cfg, (frame.shape[1], frame.shape[0]))
                processed = await loop.run_in_executor(None, engine.process, frame, time.monotonic())
                encoded = await loop.run_in_executor(None, encode_frame, processed)
                await websocket.send_bytes(encoded)
            except Exception as exc:
                # Keep the camera preview and connection alive when one frame is
                # invalid or the model encounters a transient processing error.
                await send_error(websocket, f"Frame processing failed: {exc}")
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        await send_error(websocket, f"Frame processing failed: {exc}")
    finally:
        if engine is not None:
            engine.close()


__all__ = ["app", "decode_frame", "encode_frame"]
