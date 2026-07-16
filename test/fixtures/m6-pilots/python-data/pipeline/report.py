from .source import load_rows


def render_report() -> str:
    return ",".join(load_rows())
