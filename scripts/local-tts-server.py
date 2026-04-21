#!/usr/bin/env python3
"""
Local OpenAI-compatible TTS server for ClaudeClaw.

Implements:
  POST /v1/audio/speech

Request body (subset):
  {
    "model": "kokoro",
    "input": "Text to speak",
    "voice": "en-US-GuyNeural",
    "response_format": "mp3"
  }

Returns audio bytes (MP3).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str
    voice: str | None = None
    response_format: str | None = None


DEFAULT_VOICE = os.environ.get("LOCAL_TTS_VOICE", "en-US-GuyNeural")
HOST = os.environ.get("LOCAL_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("LOCAL_TTS_PORT", "8880"))

app = FastAPI(title="ClaudeClaw Local TTS", version="1.0.0")


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "voice": DEFAULT_VOICE}


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest) -> Response:
    text = (req.input or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="input is required")

    voice = (req.voice or DEFAULT_VOICE).strip() or DEFAULT_VOICE

    with tempfile.TemporaryDirectory(prefix="claudeclaw_tts_") as tmpdir:
        out_path = Path(tmpdir) / "speech.mp3"
        try:
            communicator = edge_tts.Communicate(text, voice)
            await communicator.save(str(out_path))
            audio = out_path.read_bytes()
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"tts_failed: {exc}") from exc

    return Response(content=audio, media_type="audio/mpeg")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
