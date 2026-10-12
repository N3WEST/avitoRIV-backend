import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import SessionLocal
from models import FoundItem, SearchTask, User
from parser import extract_product_info, validate_avito_url
from subscription import get_plan_limits


class SearchNotFoundError(Exception):
    pass


class SearchLimitError(Exception):
    pass


class SearchPermissionError(Exception):
    pass


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


async def _owned_search(
    session: AsyncSession,
    search_id: int,
    telegram_id: int,
) -> SearchTask:
    result = await session.execute(
        select(SearchTask)
        .join(User, SearchTask.user_id == User.id)
        .where(
            SearchTask.id == search_id,
            User.telegram_id == telegram_id,
        )
    )
    task = result.scalar_one_or_none()
    if task is None:
        raise SearchNotFoundError("Поиск не найден.")
    return task


async def create_search(
    user_id: int,
    url: str,
    filters: dict[str, Any] | None = None,
    duration_hours: int | None = None,
    *,
    region: str = "rossiya",
    max_price: int | None = None,
    username: str | None = None,
) -> dict:
    from subscription import get_or_create_user

    url = validate_avito_url(url)
    if duration_hours is not None and duration_hours <= 0:
        raise ValueError("duration_hours должен быть положительным.")

    source = await extract_product_info(url)
    now = datetime.now(timezone.utc)

    async with SessionLocal() as session:
        async with session.begin():
            user = await get_or_create_user(session, user_id, username)
            limits = get_plan_limits(user.plan)

            result = await session.execute(
                select(func.count(SearchTask.id)).where(
                    SearchTask.user_id == user.id,
                    SearchTask.is_active.is_(True),
                    SearchTask.expires_at > now,
                )
            )
            active_count = result.scalar_one()

            if active_count >= limits["max_searches"]:
                raise SearchLimitError(
                    "Достигнут лимит активных поисков для тарифа."
                )

            duration = duration_hours or limits["duration_hours"]
            if duration > limits["duration_hours"]:
                raise SearchPermissionError(
                    "Длительность превышает лимит текущего тарифа."
                )

            price_limit = (
                max_price if max_price is not None else source["price"]
            )
            if price_limit <= 0:
                raise ValueError("max_price должен быть положительным.")

            task = SearchTask(
                user_id=user.id,
                title=source["title"],
                url=url,
                filters_json=json.dumps(
                    filters or {}, ensure_ascii=False
                ),
                region=region,
                max_price=price_limit,
                created_at=now,
                expires_at=now + timedelta(hours=duration),
                is_active=True,
            )
            session.add(task)
            await session.flush()
            await session.refresh(task)
            return await _serialize_search(session, task)


async def get_search(search_id: int, telegram_id: int) -> dict:
    async with SessionLocal() as session:
        task = await _owned_search(session, search_id, telegram_id)
        return await _serialize_search(session, task)


async def get_active_searches(telegram_id: int) -> list[dict]:
    now = datetime.now(timezone.utc)

    async with SessionLocal() as session:
        result = await session.execute(
            select(SearchTask)
            .join(User, SearchTask.user_id == User.id)
            .where(
                User.telegram_id == telegram_id,
                SearchTask.is_active.is_(True),
                SearchTask.expires_at > now,
            )
            .order_by(SearchTask.created_at.desc())
        )
        tasks = result.scalars().all()
        return [
            await _serialize_search(session, task)
            for task in tasks
        ]


async def update_search(
    search_id: int,
    telegram_id: int,
    filters: dict[str, Any] | None = None,
    max_price: int | None = None,
    region: str | None = None,
) -> dict:
    if max_price is not None and max_price <= 0:
        raise ValueError("max_price должен быть положительным.")
    if region is not None and not region.strip():
        raise ValueError("region не должен быть пустым.")

    async with SessionLocal() as session:
        async with session.begin():
            task = await _owned_search(session, search_id, telegram_id)

            if filters is not None:
                task.filters_json = json.dumps(
                    filters, ensure_ascii=False
                )
            if max_price is not None:
                task.max_price = max_price
            if region is not None:
                task.region = region.strip().lower()

            await session.flush()
            return await _serialize_search(session, task)


async def pause_search(search_id: int, telegram_id: int) -> bool:
    async with SessionLocal() as session:
        async with session.begin():
            task = await _owned_search(session, search_id, telegram_id)
            task.is_active = False
    return True


async def resume_search(search_id: int, telegram_id: int) -> bool:
    now = datetime.now(timezone.utc)

    async with SessionLocal() as session:
        async with session.begin():
            task = await _owned_search(session, search_id, telegram_id)

            if _as_utc(task.expires_at) <= now:
                raise ValueError("Срок поиска истёк.")

            result = await session.execute(
                select(func.count(SearchTask.id)).where(
                    SearchTask.user_id == task.user_id,
                    SearchTask.id != task.id,
                    SearchTask.is_active.is_(True),
                    SearchTask.expires_at > now,
                )
            )
            user = await session.get(User, task.user_id)
            limit = get_plan_limits(
                user.plan if user else "free"
            )["max_searches"]

            if result.scalar_one() >= limit:
                raise SearchLimitError(
                    "Достигнут лимит активных поисков."
                )

            task.is_active = True
    return True


async def delete_search(search_id: int, telegram_id: int) -> bool:
    async with SessionLocal() as session:
        async with session.begin():
            task = await _owned_search(session, search_id, telegram_id)
            await session.delete(task)
    return True


async def extend_search(
    search_id: int,
    telegram_id: int,
    additional_hours: int,
) -> dict:
    if additional_hours <= 0:
        raise ValueError("additional_hours должен быть положительным.")

    async with SessionLocal() as session:
        async with session.begin():
            task = await _owned_search(session, search_id, telegram_id)
            user = await session.get(User, task.user_id)
            limit_hours = get_plan_limits(
                user.plan if user else "free"
            )["duration_hours"]

            now = datetime.now(timezone.utc)
            current_expiry = max(_as_utc(task.expires_at), now)
            new_expiry = current_expiry + timedelta(
                hours=additional_hours
            )

            if new_expiry > now + timedelta(hours=limit_hours):
                raise SearchPermissionError(
                    "Продление превышает лимит тарифа."
                )

            task.expires_at = new_expiry
            await session.flush()
            return await _serialize_search(session, task)


async def get_search_status(
    search_id: int,
    telegram_id: int,
) -> dict:
    return await get_search(search_id, telegram_id)


async def _serialize_search(
    session: AsyncSession,
    task: SearchTask,
) -> dict:
    count_result = await session.execute(
        select(func.count(FoundItem.id)).where(
            FoundItem.search_task_id == task.id
        )
    )
    now = datetime.now(timezone.utc)
    expires_at = _as_utc(task.expires_at)
    remaining = max(timedelta(0), expires_at - now)

    return {
        "id": task.id,
        "title": task.title,
        "url": task.url,
        "filters": json.loads(task.filters_json or "{}"),
        "region": task.region,
        "max_price": task.max_price,
        "created_at": _as_utc(task.created_at).isoformat(),
        "expires_at": expires_at.isoformat(),
        "expires_in_hours": round(
            remaining.total_seconds() / 3600, 2
        ),
        "found_count": count_result.scalar_one(),
        "is_active": (
            task.is_active and remaining.total_seconds() > 0
        ),
        "last_checked_at": (
            _as_utc(task.last_checked_at).isoformat()
            if task.last_checked_at else None
        ),
    }


async def list_found_items(
    search_id: int,
    telegram_id: int,
    limit: int = 100,
) -> list[dict]:
    async with SessionLocal() as session:
        task = await _owned_search(session, search_id, telegram_id)

        result = await session.execute(
            select(FoundItem)
            .where(FoundItem.search_task_id == task.id)
            .order_by(FoundItem.found_at.desc())
            .limit(limit)
        )
        items = result.scalars().all()

        return [
            {
                "id": item.id,
                "title": item.title,
                "price": item.price,
                "url": item.url,
                "image": item.image,
                "found_at": _as_utc(item.found_at).isoformat(),
                "is_new": item.is_new,
            }
            for item in items
        ]


async def mark_items_read(search_id: int, telegram_id: int) -> int:
    async with SessionLocal() as session:
        async with session.begin():
            task = await _owned_search(session, search_id, telegram_id)

            result = await session.execute(
                select(FoundItem).where(
                    FoundItem.search_task_id == task.id,
                    FoundItem.is_new.is_(True),
                )
            )
            items = result.scalars().all()

            for item in items:
                item.is_new = False

            return len(items)


async def save_found_items(
    search_id: int,
    items: list[dict],
) -> int:
    now = datetime.now(timezone.utc)
    saved = 0

    async with SessionLocal() as session:
        async with session.begin():
            for item in items:
                if not item.get("url") or not item.get("price"):
                    continue

                existing = await session.execute(
                    select(FoundItem.id).where(
                        FoundItem.search_task_id == search_id,
                        FoundItem.url == item["url"],
                    )
                )
                if existing.scalar_one_or_none() is not None:
                    continue

                session.add(
                    FoundItem(
                        search_task_id=search_id,
                        title=str(item["title"])[:500],
                        price=int(item["price"]),
                        url=item["url"],
                        image=item.get("image"),
                        found_at=now,
                        is_new=True,
                    )
                )
                saved += 1

    return saved
