from dataclasses import dataclass


@dataclass(frozen=True)
class ReportRow:
    name: str
    value: int


def normalize(row: ReportRow) -> dict[str, object]:
    return {"name": row.name, "value": row.value}
