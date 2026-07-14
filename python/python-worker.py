#!/usr/bin/env python3
"""Bounded JSON worker for ArchMap's reversible native-Python parser seam.

The worker is deliberately syntax-only: Python's stdlib ``ast`` module is the authority for
deterministic symbols, imports, and entry signals. Framework-shaped CLI and route hits and
literal dynamic imports/data paths are returned in separate collections so the TypeScript
model layer can only publish them as partial relations. Replacing this worker with Tree-sitter
later does not change the adapter/model contract.
"""

from __future__ import annotations

import ast
import base64
import json
import re
import sys
from typing import Any

PROTOCOL_VERSION = 1
MAX_STDIN_BYTES = 7_000_000
ROUTE_METHODS = {"get", "post", "put", "delete", "patch", "options", "head", "route"}
# Conservative cross-version subset present throughout the supported Python 3.9+ runtimes.
# Keeping this frozen makes stdlib certainty a function of the worker version, not of whichever
# optional modules happen to be installed on the host. Local modules are still resolved first.
STDLIB_MODULES = {
    "abc", "argparse", "ast", "asyncio", "base64", "collections", "concurrent",
    "contextlib", "copy", "csv", "dataclasses", "datetime", "email", "enum", "functools",
    "glob", "hashlib", "http", "importlib", "inspect", "io", "itertools", "json", "logging",
    "math", "multiprocessing", "os", "pathlib", "pickle", "platform", "queue", "random",
    "re", "shlex", "shutil", "signal", "socket", "sqlite3", "statistics", "string",
    "subprocess", "sys", "tempfile", "textwrap", "threading", "time", "traceback", "types",
    "typing", "unittest", "urllib", "uuid", "warnings", "xml", "zipfile",
}


def emit(value: Any) -> None:
    sys.stdout.write(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def literal_string(node: ast.AST | None) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def dotted_name(node: ast.AST) -> str | None:
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if not isinstance(current, ast.Name):
        return None
    parts.append(current.id)
    return ".".join(reversed(parts))


def explicit_all(statement: ast.stmt) -> list[str] | None:
    if not isinstance(statement, ast.Assign) or len(statement.targets) != 1:
        return None
    target = statement.targets[0]
    if not isinstance(target, ast.Name) or target.id != "__all__":
        return None
    if not isinstance(statement.value, (ast.List, ast.Tuple)):
        return None
    values = [literal_string(item) for item in statement.value.elts]
    return sorted(set(value for value in values if value is not None)) if all(value is not None for value in values) else None


def is_main_guard(statement: ast.stmt) -> bool:
    if not isinstance(statement, ast.If) or not isinstance(statement.test, ast.Compare):
        return False
    test = statement.test
    if len(test.ops) != 1 or not isinstance(test.ops[0], ast.Eq) or len(test.comparators) != 1:
        return False
    left, right = test.left, test.comparators[0]
    return (
        isinstance(left, ast.Name)
        and left.id == "__name__"
        and literal_string(right) == "__main__"
    ) or (
        isinstance(right, ast.Name)
        and right.id == "__name__"
        and literal_string(left) == "__main__"
    )


def decorator_hits(statement: ast.stmt, routes: set[str], commands: set[str]) -> None:
    if not isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return
    for decorator in statement.decorator_list:
        call = decorator if isinstance(decorator, ast.Call) else None
        target = call.func if call else decorator
        name = dotted_name(target)
        if not name:
            continue
        leaf = name.rsplit(".", 1)[-1].lower()
        if leaf in ROUTE_METHODS and call:
            path = literal_string(call.args[0]) if call.args else None
            if path and path.startswith("/"):
                method = leaf.upper() if leaf != "route" else "ROUTE"
                routes.add(f"{method} {path}")
        if leaf == "command":
            command = literal_string(call.args[0]) if call and call.args else None
            if call and command is None:
                for keyword in call.keywords:
                    if keyword.arg == "name":
                        command = literal_string(keyword.value)
            commands.add(command or statement.name)


def data_path(value: str | None) -> str | None:
    if value is None:
        return None
    lowered = value.lower().split("#", 1)[0]
    return value if lowered.endswith((".yaml", ".yml", ".json")) else None


def call_keyword(call: ast.Call, name: str) -> ast.AST | None:
    return next((keyword.value for keyword in call.keywords if keyword.arg == name), None)


def literal_argument(call: ast.Call, index: int, keyword: str) -> tuple[str, ast.Constant] | None:
    node = call.args[index] if len(call.args) > index else call_keyword(call, keyword)
    value = data_path(literal_string(node))
    return (value, node) if value is not None and isinstance(node, ast.Constant) else None


def open_accesses(call: ast.Call, mode_index: int, default_read: bool = True) -> list[str]:
    mode_node = call.args[mode_index] if len(call.args) > mode_index else call_keyword(call, "mode")
    if mode_node is None:
        return ["read"] if default_read else []
    mode = literal_string(mode_node)
    if mode is None:
        return []
    accesses: list[str] = []
    if not any(marker in mode for marker in "wax") or "+" in mode:
        accesses.append("read")
    if any(marker in mode for marker in "wax+"):
        accesses.append("write")
    return accesses


def pathlib_receiver(call: ast.Call) -> tuple[str, ast.Constant] | None:
    if not isinstance(call.func, ast.Attribute) or not isinstance(call.func.value, ast.Call):
        return None
    constructor = call.func.value
    if dotted_name(constructor.func) not in {"Path", "pathlib.Path"}:
        return None
    return literal_argument(constructor, 0, "path")


def path_builder_names(tree: ast.AST) -> tuple[set[str], set[str]]:
    join_modules = {"os.path", "posixpath", "ntpath"}
    constructor_types = {"Path", "PurePath", "PurePosixPath", "PureWindowsPath"}
    joins = {f"{module}.join" for module in join_modules}
    constructors = set(constructor_types) | {f"pathlib.{name}" for name in constructor_types}

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name
                if alias.name in join_modules:
                    joins.add(f"{local}.join")
                elif alias.name == "os":
                    joins.add(f"{local}.path.join")
                elif alias.name == "pathlib":
                    constructors.update(f"{local}.{name}" for name in constructor_types)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                local = alias.asname or alias.name
                if module in join_modules and alias.name == "join":
                    joins.add(local)
                elif module == "os" and alias.name == "path":
                    joins.add(f"{local}.join")
                elif module == "pathlib" and alias.name in constructor_types:
                    constructors.add(local)
    return joins, constructors


def risky_literal(
    node: ast.Constant,
    parents: dict[ast.AST, ast.AST],
    path_joins: set[str],
    path_constructors: set[str],
) -> bool:
    current: ast.AST = node
    while current in parents:
        current = parents[current]
        if isinstance(current, (ast.BinOp, ast.JoinedStr, ast.FormattedValue)):
            return True
        if isinstance(current, ast.Call):
            name = dotted_name(current.func)
            joinpath = isinstance(current.func, ast.Attribute) and current.func.attr == "joinpath"
            literal_string_builder = (
                isinstance(current.func, ast.Attribute)
                and current.func.attr in {"format", "join"}
                and isinstance(current.func.value, ast.Constant)
                and isinstance(current.func.value.value, str)
            )
            multi_component_path = name in path_constructors and (
                len(current.args) > 1 or any(isinstance(arg, ast.Starred) for arg in current.args)
            )
            if (
                name in {"os.getenv", "os.environ.get", "environ.get"}
                or name in path_joins
                or (name or "").endswith(".format")
                or joinpath
                or literal_string_builder
                or multi_component_path
            ):
                return True
        if isinstance(current, ast.stmt):
            break
    return False


def data_references(tree: ast.AST) -> list[dict[str, str]]:
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    path_joins, path_constructors = path_builder_names(tree)
    used_literals: set[int] = set()
    references: set[tuple[str, str]] = set()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = dotted_name(node.func)
        direct = literal_argument(node, 0, "file") if name in {"open", "io.open"} else None
        if direct is not None:
            path, literal = direct
            used_literals.add(id(literal))
            for access in open_accesses(node, 1):
                references.add((path, access))
            continue

        receiver = pathlib_receiver(node)
        if receiver is None or not isinstance(node.func, ast.Attribute):
            continue
        path, literal = receiver
        used_literals.add(id(literal))
        method = node.func.attr
        if method in {"read_text", "read_bytes"}:
            references.add((path, "read"))
        elif method in {"write_text", "write_bytes"}:
            references.add((path, "write"))
        elif method == "open":
            for access in open_accesses(node, 0):
                references.add((path, access))

    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or id(node) in used_literals:
            continue
        path = data_path(literal_string(node))
        if path is not None and not risky_literal(node, parents, path_joins, path_constructors):
            references.add((path, "bare"))

    return [
        {"path": path, "access": access}
        for path, access in sorted(references, key=lambda item: (item[0], item[1]))
    ]


def analyze(path: str, source: bytes) -> dict[str, Any]:
    try:
        tree = ast.parse(source, filename=path, type_comments=True)
    except SyntaxError:
        return {"protocol_version": PROTOCOL_VERSION, "status": "syntax-error", "path": path}

    symbols: set[str] = set()
    imports: list[dict[str, Any]] = []
    entry_signals: set[str] = set()
    routes: set[str] = set()
    commands: set[str] = set()

    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            symbols.add(statement.name)
        exported = explicit_all(statement)
        if exported is not None:
            symbols.update(exported)
        if isinstance(statement, ast.Import):
            for alias in statement.names:
                imports.append({"kind": "static", "level": 0, "module": alias.name, "names": []})
        elif isinstance(statement, ast.ImportFrom):
            imports.append({
                "kind": "static",
                "level": statement.level,
                "module": statement.module or "",
                "names": sorted(alias.name for alias in statement.names),
            })
        if is_main_guard(statement):
            entry_signals.add("__main__ guard")
        decorator_hits(statement, routes, commands)

    if source.startswith(b"#!"):
        entry_signals.add("shebang")

    dynamic_imports: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = dotted_name(node.func)
        if name in {"importlib.import_module", "__import__"} and node.args:
            module = literal_string(node.args[0])
            if module:
                dynamic_imports.add(module)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "add_parser" and node.args:
            command = literal_string(node.args[0])
            if command:
                commands.add(command)
        if isinstance(node.func, ast.Attribute) and node.func.attr == "add_api_route" and node.args:
            route = literal_string(node.args[0])
            if route and route.startswith("/"):
                routes.add(f"ROUTE {route}")

    imports.sort(key=lambda item: (item["level"], item["module"], item["names"]))
    return {
        "protocol_version": PROTOCOL_VERSION,
        "status": "ok",
        "path": path,
        "symbols": sorted(symbols),
        "imports": imports,
        "dynamic_imports": sorted(dynamic_imports),
        "entry_signals": sorted(entry_signals),
        "routes": sorted(routes),
        "cli_commands": sorted(commands),
        "data_references": data_references(tree),
    }


def dependency_names(pyproject: str, requirements: str) -> list[str]:
    """Return only distribution names that are also exact Python import identifiers."""
    declared: set[str] = set()
    if pyproject:
        try:
            import tomllib

            document = tomllib.loads(pyproject)
            values = document.get("project", {}).get("dependencies", [])
            if isinstance(values, list):
                for value in values:
                    if isinstance(value, str):
                        match = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)", value)
                        if match:
                            declared.add(match.group(1))
        except (ImportError, ValueError, TypeError):
            pass
    for line in requirements.splitlines():
        if line.lstrip().startswith(("#", "-")):
            continue
        match = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)", line)
        if match:
            declared.add(match.group(1))
    return sorted(name for name in declared if re.fullmatch(r"[A-Za-z_]\w*", name))


def main() -> int:
    if sys.argv[1:] == ["--probe"]:
        emit({
            "protocol_version": PROTOCOL_VERSION,
            "status": "ok",
            "python_version": list(sys.version_info[:3]),
            "stdlib": sorted(STDLIB_MODULES),
        })
        return 0
    dependency_mode = sys.argv[1:] == ["--dependencies"]
    if sys.argv[1:] and not dependency_mode:
        return 2

    raw = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    if len(raw) > MAX_STDIN_BYTES:
        return 2
    try:
        request = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 2
    if not isinstance(request, dict) or request.get("protocol_version") != PROTOCOL_VERSION:
        return 2
    if dependency_mode:
        pyproject, requirements = request.get("pyproject", ""), request.get("requirements", "")
        if not isinstance(pyproject, str) or not isinstance(requirements, str):
            return 2
        emit({
            "protocol_version": PROTOCOL_VERSION,
            "status": "ok",
            "dependencies": dependency_names(pyproject, requirements),
        })
        return 0
    path, source_base64 = request.get("path"), request.get("source_base64")
    if not isinstance(path, str) or not isinstance(source_base64, str):
        return 2
    try:
        source = base64.b64decode(source_base64, validate=True)
    except (ValueError, TypeError):
        return 2
    emit(analyze(path, source))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
