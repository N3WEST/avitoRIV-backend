import logging
import os
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from aiogram import Bot, Dispatcher, F, Router
from aiogram.filters import Command
from aiogram.types import (
    Message,
    CallbackQuery,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    WebAppInfo,
)

logger = logging.getLogger(__name__)

API_URL = os.getenv(
    "API_URL",
    "https://avito-parser-9q1l.onrender.com",
).rstrip("/")

MINI_APP_URL = "https://n3west.github.io/Avito-miniapp./"

DEFAULT_FILTERS = {}

router = Router()

PLANS = {
    "pro": {
        "name": "Pro",
        "price": 499,
        "searches": 3,
        "days": 7,
    },
    "business": {
        "name": "Business",
        "price": 1990,
        "searches": 10,
        "days": 30,
    },
}


def start_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="🔍 Открыть приложение",
                    web_app=WebAppInfo(url=MINI_APP_URL),
                )
            ]
        ]
    )


def subscribe_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Купить Pro",
                    callback_data="buy:pro",
                )
            ],
            [
                InlineKeyboardButton(
                    text="Купить Business",
                    callback_data="buy:business",
                )
            ],
        ]
    )


def payment_keyboard(url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="💳 Перейти к оплате",
                    url=url,
                )
            ]
        ]
    )


async def api_request(
    method: str,
    path: str,
    **kwargs,
) -> dict:
    url = f"{API_URL}{path}"

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.request(
            method=method,
            url=url,
            **kwargs,
        )
        response.raise_for_status()

        if not response.content:
            return {}

        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("API вернул неожиданный формат JSON")

        return data


def is_avito_url(text: str) -> bool:
    try:
        value = text.strip()
        parsed = urlparse(value)

        return (
            parsed.scheme in {"http", "https"}
            and parsed.hostname is not None
            and (
                parsed.hostname == "avito.ru"
                or parsed.hostname.endswith(".avito.ru")
            )
        )
    except (ValueError, AttributeError):
        return False


@router.message(Command("start"))
async def cmd_start(message: Message) -> None:
    await message.answer(
        "Привет! Я RIV — ищу выгодные товары на Авито.\n"
        "Отправь ссылку на объявление, и я найду похожие дешевле.",
        reply_markup=start_keyboard(),
    )


@router.message(Command("subscribe"))
async def cmd_subscribe(message: Message) -> None:
    text = (
        "📦 Тарифы RIV\n\n"
        "🆓 Free — 1 поиск × 24 часа\n"
        "⭐ Pro — 499 ₽, 3 поиска × 7 дней\n"
        "🏢 Business — 1990 ₽, 10 поисков × 30 дней\n\n"
        "Выберите тариф для покупки:"
    )

    await message.answer(
        text,
        reply_markup=subscribe_keyboard(),
    )


@router.callback_query(F.data.startswith("buy:"))
async def buy_plan(callback: CallbackQuery, bot: Bot) -> None:
    if not callback.from_user:
        await callback.answer("Не удалось определить пользователя.")
        return

    plan_key = callback.data.split(":", maxsplit=1)[1]
    plan = PLANS.get(plan_key)

    if plan is None:
        await callback.answer("Неизвестный тариф.")
        return

    await callback.answer("Создаю платёж...")

    try:
        result = await api_request(
            "POST",
            "/api/payment/create",
            json={
                "telegram_id": callback.from_user.id,
                "plan": plan_key,
            },
        )

        confirmation_url = result.get("confirmation_url")

        if not confirmation_url:
            logger.error(
                "API оплаты не вернул confirmation_url: %s",
                result,
            )
            if callback.message:
                await callback.message.answer(
                    "Не удалось создать платёж. Попробуйте позже."
                )
            return

        parsed = urlparse(confirmation_url)
        if parsed.scheme != "https" or not parsed.hostname:
            logger.error("Некорректный confirmation_url")
            if callback.message:
                await callback.message.answer(
                    "Получена некорректная ссылка на оплату."
                )
            return

        if callback.message:
            await bot.send_message(
                chat_id=callback.from_user.id,
                text=(
                    f"Тариф {plan['name']} — {plan['price']} ₽.\n"
                    "Нажмите кнопку ниже, чтобы перейти к оплате."
                ),
                reply_markup=payment_keyboard(confirmation_url),
            )

    except (httpx.HTTPError, ValueError):
        logger.exception(
            "Ошибка создания платежа для telegram_id=%s",
            callback.from_user.id,
        )
        if callback.message:
            await callback.message.answer(
                "Сервис оплаты временно недоступен. "
                "Попробуйте позже."
            )


@router.message(Command("my_searches"))
async def cmd_my_searches(message: Message) -> None:
    if not message.from_user:
        return

    try:
        result = await api_request(
            "GET",
            "/api/search/list",
            params={"telegram_id": message.from_user.id},
        )

        searches = result.get("searches", [])

        if not searches:
            await message.answer("У вас пока нет активных поисков.")
            return

        lines = ["🔎 Ваши поиски:\n"]

        for index, search in enumerate(searches, start=1):
            if not search.get("is_active"):
                continue

            search_url = search.get("url", "Ссылка не указана")
            hours = search.get("expires_in_hours", 0)
            found = search.get("found_count", 0)

            lines.append(
                f"{index}. {search_url}\n"
                f"   ⏰ Осталось: {hours:.1f} ч.\n"
                f"   📦 Найдено: {found}"
            )

        if len(lines) == 1:
            await message.answer("У вас пока нет активных поисков.")
            return

        await message.answer("\n\n".join(lines))

    except (httpx.HTTPError, ValueError):
        logger.exception(
            "Ошибка получения поисков для telegram_id=%s",
            message.from_user.id,
        )
        await message.answer(
            "Не удалось загрузить поиски. Попробуйте позже."
        )


@router.message(F.text)
async def handle_avito_link(message: Message) -> None:
    if not message.from_user or not message.text:
        return

    url = message.text.strip()

    if not is_avito_url(url):
        return

    await message.answer("⏳ Создаю поиск...")

    try:
        await api_request(
            "POST",
            "/api/search/create",
            json={
                "telegram_id": message.from_user.id,
                "username": message.from_user.username,
                "url": url,
                "region": "moskva",
                "filters": DEFAULT_FILTERS,
            },
        )

        await message.answer(
            "✅ Поиск создан! Будет работать 24 часа.\n"
            "Как только найду что-то дешевле — пришлю уведомление."
        )

    except httpx.HTTPStatusError as e:
        logger.exception(
            "Ошибка API при создании поиска для telegram_id=%s",
            message.from_user.id,
        )
        if e.response.status_code == 403:
            await message.answer(
                "⚠️ Достигнут лимит активных поисков.\n"
                "Используйте /subscribe, чтобы купить больше."
            )
        else:
            await message.answer(
                "Не удалось создать поиск. Попробуйте позже."
            )
    except (httpx.HTTPError, ValueError):
        logger.exception(
            "Ошибка создания поиска для telegram_id=%s",
            message.from_user.id,
        )
        await message.answer(
            "Не удалось создать поиск. Попробуйте позже."
        )


def register_handlers(dp: Dispatcher) -> None:
    dp.include_router(router)
