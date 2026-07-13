"""
Fake syntax must not become facts:
import fake_docstring
def fake_symbol(): pass
"""

import importlib
import os
import requests
import mystery
import bs4
import email
import dupe
from . import util
from pkg.helper import (
    Helper,
)

# import fake_comment
FAKE = "import fake_string"

class Service:
    pass

def build():
    def nested_definition():
        pass
    import nested_only
    importlib.import_module("pkg.dynamic")
    importlib.import_module(computed_name)
    return Helper(), nested_definition

@app.get("/health")
def health():
    return {"ok": True}

@cli.command("serve")
def serve():
    pass

if __name__ == "__main__":
    build()
