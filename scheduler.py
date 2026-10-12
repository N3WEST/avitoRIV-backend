import asyncio
import json
import logging
import os
from datetime import datetime, timezone

from aiogram import Bot
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import select

from database import SessionLocal
from filters import filter_by_condition
from models import FoundItem, SearchTask
from parser import parse_new_items
from search_manager import _as_utc as _utc

logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
CHECK_CONCURRENCY = int(os.getenv("CHECK_CONCURRENCY", "3"))

bot: Bot | None = None
scheduler = AsyncIOScheduler(timezone="UTC")
check_lock = asyncio.Lock()


def configure_scheduler(bot_instance: Bot) -> None:
    global bot
    bot = bot_instance

    if not scheduler.running:
        scheduler.add_job(
            check_searches,
            trigger="interval",
            minutes=15,
            id="check_searches",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        scheduler.start()


async def _check_one(task_id: int, semaphore: asyncio.Semaphore) -> None:
    async with semaphore:
        try:
            async with SessionLocal() as session:
                task = await session.get(SearchTask, task_id)
                if task is None or not task.is_active:
                    return

                now = datetime.now(timezone.utc)
                if _utc(task.expires_at) <= now:
                    task.is_active = False
                    await session.commit()
                    return

                url = task.url
                title = task.title
                max_price = task.max_price
                region = task.region
                filters = json.loads(task.filters_json or "{}")

            items = await parse_new_items(
                url,
                None,
                title=title,
                max_price=max_price,
                region=region,
                filters=filters,
            )
            items = filter_by_condition(items, filters)
            items = [
                item for item in items
                if isinstance(item.get("price"), int)
                and item["price"] < max_price
                and item.get("url")
            ]

            new_items: list[dict] = []
            async with SessionLocal() as session:
                task = await session.get(SearchTask, task_id)
                if task is None or not task.is_active:
                    return

                now = datetime.now(timezone.utc)
                if _utc(task.expires_at) <= now:
                    task.is_active = False
                    await session.commit()
                    return

                for item in items:
                    existing = await session.execute(
                        select(FoundItem.id).where(
                            FoundItem.search_task_id == task_id,
                            FoundItem.url == item["url"],
                        )
                    )
                    if existing.scalar_one_or_none() is not None:
                        continue

                    found = FoundItem(
                        search_task_id=task_id,
                        title=str(item["title"])[:500],
                        price=int(item["price"]),
                        url=item["url"],
                        image=item.get("image"),
                        found_at=now,
                        is_new=True,
                    )
                    session.add(found)
                    new_items.append(item)

                task.last_checked_at = now
                await session.commit()

            if bot is not None and new_items:
                try:
                    telegram_id = await _get_telegram_id(task_id)
                    batch = new_items[:5]

                    text_lines = ["🟢 Новые выгодные находки:\n"]
                    for i, item in enumerate(batch, 1):
                        text_lines.append(
                            f"{i}. {str(item['title'])[:120]}\n"
                            f"💰 {int(item['price']):,} ₽\n"
                            f"🔗 {item['url']}\n"
                        )
                    text = "\n".join(text_lines).replace(",", " ")
                    text += f"\nПоказано {len(batch)} из {len(new_items)}."

                    await bot.send_message(
                        chat_id=telegram_id,
                        text=text[:4096],
                        disable_web_page_preview=True,
                    )
                except Exception:
                    logger.exception(
                        "Ошибка отправки уведомления по поиску %s",
                        task_id,
                    )

        except Exception:
            logger.exception("Ошибка мониторинга search_id=%s", task_id)


async def _get_telegram_id(task_id: int) -> int:
    from models import User

    async with SessionLocal() as session:
        result = await session.execute(
            select(User.telegram_id)
            .join(SearchTask, SearchTask.user_id == User.id)
            .where(SearchTask.id == task_id)
        )
        telegram_id = result.scalar_one_or_none()
        if telegram_id is None:
            raise LookupError("Владелец поиска не найден.")
        return int(telegram_id)


async def check_searches() -> None:
    if check_lock.locked():
        return

    async with check_lock:
        now = datetime.now(timezone.utc)
        async with SessionLocal() as session:
            expired = await session.execute(
                select(SearchTask).where(
                    SearchTask.is_active.is_(True),
                    SearchTask.expires_at <= now,
                )
            )
            for task in expired.scalars().all():
                task.is_active = False
            await session.commit()

            result = await session.execute(
                select(SearchTask.id).where(
                    SearchTask.is_active.is_(True),
                    SearchTask.expires_at > now,
                )
            )
            task_ids = result.scalars().all()

        semaphore = asyncio.Semaphore(max(1, CHECK_CONCURRENCY))
        await asyncio.gather(
            *(_check_one(task_id, semaphore) for task_id in task_ids),
            return_exceptions=True,
        )


async def shutdown_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
