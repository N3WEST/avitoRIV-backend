import re
from typing import Any

REPAIR_RE = re.compile(
    r"\b(?:ремонт\w*|замен\w*|не\s+работает|неисправ\w*|"
    r"под\s+ремонт|после\s+ремонта)\b",
    re.IGNORECASE,
)
ORIGINAL_RE = re.compile(
    r"\b(?:оригинал\w*|оригинальн\w*|не\s+копия)\b",
    re.IGNORECASE,
)
BATTERY_RE = re.compile(
    r"(?:акб|аккумулятор|ёмкость\s+батареи|состояние\s+батареи)"
    r"\D{0,25}(\d{1,3})\s*%",
    re.IGNORECASE,
)


def _item_text(item: dict[str, Any]) -> str:
    return " ".join(
        str(item.get(field) or "")
        for field in ("title", "description", "text", "condition")
    )


def filter_by_condition(
    items: list[dict[str, Any]],
    filters: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    filters = filters or {}
    battery_min = filters.get("battery_min")

    if battery_min is not None:
        battery_min = int(battery_min)
        if not 0 <= battery_min <= 100:
            raise ValueError("battery_min должен быть от 0 до 100.")

    result = []
    for item in items:
        text = _item_text(item)

        if battery_min is not None:
            match = BATTERY_RE.search(text)
            if not match or int(match.group(1)) < battery_min:
                continue

        if filters.get("no_repair") and REPAIR_RE.search(text):
            continue

        if filters.get("original") and not ORIGINAL_RE.search(text):
            continue

        result.append(item)

    return result
