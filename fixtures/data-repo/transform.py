import json
import os
from pathlib import Path


CONFIG_ASSET = "config/settings.json"


def transform(name: str) -> None:
    with open("data/input.yaml", "r", encoding="utf-8") as source:
        rows = source.read()
    Path("data/output.json").write_text(json.dumps({"rows": rows}), encoding="utf-8")

    computed = "data/" + name + ".json"
    open(computed)
    environment = os.getenv("DATA_PATH")
    if environment:
        open(environment)
    open("../../escape.json")
    open("data/missing.json")
