import json
from pathlib import Path

import requests

from .models import ReportRow, normalize


def build_report() -> None:
    with open("config/pipeline.json", "r", encoding="utf-8") as settings:
        settings.read()
    with open("data/source.yaml", "r", encoding="utf-8") as source:
        source.read()

    row = normalize(ReportRow(name="sample", value=1))
    Path("data/output.json").write_text(json.dumps({"rows": [row]}), encoding="utf-8")
    requests.get("https://example.invalid/audit", timeout=1)


def dynamic_target(name: str) -> None:
    Path(f"data/{name}.json").write_text("{}", encoding="utf-8")
