import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from database import SessionLocal
from models import User

YOOKASSA_SHOP_ID = os.getenv("YOOKASSA_SHOP_ID", "")
YOOKASSA_SECRET_KEY = os.getenv("YOOKASSA_SECRET_KEY", "")
YOOKASSA_RETURN_URL = os.getenv("YOOKASSA_RETURN_URL", "https://t.me/")

PLAN_PRICES = {
    "pro": int(os.getenv("PRO_PRICE_RUB", "499")),
    "business": int(os.getenv("BUSINESS_PRICE_RUB", "1990")),
}

PLAN_DURATION_DAYS = {
    "pro": 30,
    "business": 30,
}


async def create_payment(telegram_id: int, plan: str) -> str:
    if plan not in PLAN_PRICES:
        raise ValueError("Неизвестный тариф.")
    if not YOOKASSA_SHOP_ID or not YOOKASSA_SECRET_KEY:
        raise RuntimeError("Не настроены учётные данные ЮKassa.")

    try:
        from yookassa import Configuration, Payment
    except ImportError as exc:
        raise RuntimeError("Установите пакет yookassa.") from exc

    Configuration.account_id = YOOKASSA_SHOP_ID
    Configuration.secret_key = YOOKASSA_SECRET_KEY

    def _create():
        return Payment.create(
            {
                "amount": {
                    "value": f"{PLAN_PRICES[plan]}.00",
                    "currency": "RUB",
                },
                "capture": True,
                "confirmation": {
                    "type": "redirect",
                    "return_url": YOOKASSA_RETURN_URL,
                },
                "description": f"Подписка {plan} для Telegram ID {telegram_id}",
                "metadata": {
                    "telegram_id": str(telegram_id),
                    "plan": plan,
                },
            },
            str(uuid.uuid4()),
        )

    payment = await asyncio.to_thread(_create)
    return payment.confirmation.confirmation_url


async def handle_webhook(data: dict[str, Any]) -> bool:
    event = data.get("event")
    obj = data.get("object") or {}

    if event != "payment.succeeded" or obj.get("status") != "succeeded":
        return False

    payment_id = obj.get("id")
    metadata = obj.get("metadata") or {}
    try:
        telegram_id = int(metadata["telegram_id"])
        plan = str(metadata["plan"])
    except (KeyError, ValueError, TypeError):
        return False

    if plan not in PLAN_PRICES or not payment_id:
        return False

    try:
        from yookassa import Configuration, Payment
    except ImportError:
        return False

    if not YOOKASSA_SHOP_ID or not YOOKASSA_SECRET_KEY:
        return False

    Configuration.account_id = YOOKASSA_SHOP_ID
    Configuration.secret_key = YOOKASSA_SECRET_KEY

    def _find():
        return Payment.find_one(payment_id)

    verified = await asyncio.to_thread(_find)
    if getattr(verified, "status", None) != "succeeded":
        return False

    verified_metadata = getattr(verified, "metadata", None) or {}
    if (
        str(verified_metadata.get("telegram_id")) != str(telegram_id)
        or verified_metadata.get("plan") != plan
    ):
        return False

    amount = getattr(verified, "amount", None)
    if not amount or str(amount.value) != f"{PLAN_PRICES[plan]}.00":
        return False

    now = datetime.now(timezone.utc)
    duration_days = PLAN_DURATION_DAYS.get(plan, 30)

    async with SessionLocal() as session:
        result = await session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                telegram_id=telegram_id,
                plan=plan,
                plan_expires_at=now + timedelta(days=duration_days),
            )
            session.add(user)
        else:
            current_expiry = user.plan_expires_at
            if current_expiry is None or current_expiry.tzinfo is None:
                base = now
            else:
                base = max(current_expiry.astimezone(timezone.utc), now)

            user.plan = plan
            user.plan_expires_at = base + timedelta(days=duration_days)

        await session.commit()

    return True
