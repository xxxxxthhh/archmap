from fastapi import FastAPI

import requests

from .transform import build_report

app = FastAPI()


@app.get("/health")
def health() -> dict[str, str]:
    requests.get("https://example.invalid/health", timeout=1)
    return {"status": "ok"}


@app.post("/reports")
def create_report() -> dict[str, str]:
    build_report()
    return {"status": "created"}
