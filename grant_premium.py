"""Выдаёт Premium пользователям из premium_ids.txt. Запуск: python grant_premium.py"""
import asyncio
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import select

load_dotenv()

from database import SessionLocal, init_db  # noqa: E402
from models import User  # noqa: E402

BASE_DIR = Path(__file__).resolve().parent
IDS_FILE = BASE_DIR / "premium_ids.txt"
DEFAULT_DAYS = int(os.getenv("ADMIN_PREMIUM_DAYS", "30"))


def read_ids() -> list[int]:
    if not IDS_FILE.exists():
        raise FileNotFoundError(f"Не найден файл {IDS_FILE}")
    ids: list[int] = []
    for line_no, raw in enumerate(IDS_FILE.read_text(encoding="utf-8").splitlines(), 1):
        value = raw.split("#", 1)[0].strip()
        if not value:
            continue
        try:
            telegram_id = int(value)
        except ValueError as exc:
            raise ValueError(f"Строка {line_no}: укажи только числовой Telegram ID") from exc
        if telegram_id <= 0:
            raise ValueError(f"Строка {line_no}: Telegram ID должен быть больше нуля")
        ids.append(telegram_id)
    return list(dict.fromkeys(ids))


async def main() -> None:
    if DEFAULT_DAYS < 1 or DEFAULT_DAYS > 3650:
        raise ValueError("ADMIN_PREMIUM_DAYS должен быть от 1 до 3650")

    telegram_ids = read_ids()
    if not telegram_ids:
        print("Список пуст. Добавь Telegram ID в premium_ids.txt и запусти скрипт снова.")
        return

    await init_db()
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=DEFAULT_DAYS)
    async with SessionLocal() as session:
        async with session.begin():
            for telegram_id in telegram_ids:
                result = await session.execute(
                    select(User).where(User.telegram_id == telegram_id)
                )
                user = result.scalar_one_or_none()
                if user is None:
                    user = User(telegram_id=telegram_id, plan="premium", plan_expires_at=expires_at)
                    session.add(user)
                    status = "создан пользователь"
                else:
                    user.plan = "premium"
                    user.plan_expires_at = expires_at
                    status = "тариф обновлён"
                print(f"Telegram ID {telegram_id}: Premium на {DEFAULT_DAYS} дн. до {expires_at.isoformat()} ({status})")

    print("Готово. Premium записан в базу данных.")


if __name__ == "__main__":
    asyncio.run(main())
