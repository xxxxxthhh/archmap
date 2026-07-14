from pipeline.models import ReportRow, normalize
from pipeline.transform import build_report


def test_normalize() -> None:
    assert normalize(ReportRow(name="a", value=2)) == {"name": "a", "value": 2}


def test_transform_is_importable() -> None:
    assert callable(build_report)
