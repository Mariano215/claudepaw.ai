#!/usr/bin/env python3
# guard-sidecar/main.py
"""
FastAPI guard sidecar for ClaudePaw prompt injection defense.
Serves Nova-Hunting (L3) and LLM Guard (L4/L7) scanning endpoints.
Runs on localhost:8099.
"""

import logging
import time
from typing import Optional, List

from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

from config import HOST, PORT
from nova_scanner import init_nova, scan_nova
from ml_scanner import init_ml_scanners, is_ready, scan_input, scan_output

# Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("guard-sidecar")

app = FastAPI(title="ClaudePaw Guard Sidecar", version="1.0.0")


# --- Request/Response models ---

class TextRequest(BaseModel):
    text: str


class OutputRequest(BaseModel):
    text: str
    prompt: str


class NovaResponse(BaseModel):
    rulesTriggered: List[str]
    severity: str  # "none" | "low" | "high"
    timedOut: bool
    error: Optional[str]


class InputResponse(BaseModel):
    injectionScore: float
    toxicityScore: float
    invisibleTextDetected: bool
    isBlocked: bool
    blocker: Optional[str]


class OutputResponse(BaseModel):
    toxicityScore: float
    refusalDetected: bool
    isBlocked: bool
    blocker: Optional[str]


class HealthResponse(BaseModel):
    status: str  # "ready" | "loading" | "error"
    nova_available: bool
    ml_models_loaded: bool
    uptime_seconds: float


# --- State ---

_start_time = time.time()
_nova_ready = False
_ml_ready = False
_ml_error: Optional[str] = None


# --- Startup ---

@app.on_event("startup")
async def startup():
    global _nova_ready, _ml_ready, _ml_error
    logger.info("Starting guard sidecar on %s:%d", HOST, PORT)

    # Init Nova (fast, rule-based)
    _nova_ready = init_nova()

    # Init ML models (slow, ~20-30s)
    logger.info("Loading ML models (this may take 20-30 seconds on first run)...")
    _ml_ready = init_ml_scanners()
    if _ml_ready:
        _ml_error = None
        logger.info("Guard sidecar ready")
    else:
        _ml_error = "LLM Guard scanners failed to initialize"
        logger.error("Guard sidecar ML scanners failed to initialize")


# --- Endpoints ---

@app.get("/health", response_model=HealthResponse)
async def health():
    ml_ready = is_ready() or _ml_ready
    if ml_ready:
        status = "ready"
    elif _ml_error:
        status = "error"
    else:
        status = "loading"
    return HealthResponse(
        status=status,
        nova_available=_nova_ready,
        ml_models_loaded=ml_ready,
        uptime_seconds=round(time.time() - _start_time, 1),
    )


@app.post("/scan/nova", response_model=NovaResponse)
async def scan_nova_endpoint(req: TextRequest):
    result = await scan_nova(req.text)
    return NovaResponse(**result)


@app.post("/scan/input", response_model=InputResponse)
async def scan_input_endpoint(req: TextRequest):
    result = scan_input(req.text)
    return InputResponse(**result)


@app.post("/scan/output", response_model=OutputResponse)
async def scan_output_endpoint(req: OutputRequest):
    result = scan_output(req.text, req.prompt)
    return OutputResponse(**result)


# --- Main ---

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        reload=False,
    )
