from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import SessionLocal
from models import SearchTask, User

PLAN_LIMITS = {
    "free": {"max_searches": 1, "duration_hours": 24},
    "pro": {"max_searches": 3, "duration_hours": 24 * 7},
    "business": {"max_searches": 10, "duration_hours": 24 * 30},
}


def get_plan_limits(plan: str) -> dict[str, int]:
    return PLAN_LIMITS.get(plan, PLAN_LIMITS["free"]).copy()


async def get_or_create_user(
    session: AsyncSession,
    telegram_id: int,
    username: str | None = None,
) -> User:
    result = await session.execute(
        select(User).where(User.telegram_id == telegram_id)
    )
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            telegram_id=telegram_id,
            username=username,
            plan="free",
        )
        session.add(user)
        await session.flush()
    elif username and user.username != username:
        user.username = username

    return user


async def check_subscription(telegram_id: int) -> str:
    async with SessionLocal() as session:
        result = await session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
        user = result.scalar_one_or_none()

    if user is None:
        return "free"

    if user.plan == "free":
        return "free"

    if user.plan_expires_at is None:
        return "free"

    expires_at = user.plan_expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at <= datetime.now(timezone.utc):
        return "free"

    return user.plan


async def can_create_search(telegram_id: int) -> bool:
    now = datetime.now(timezone.utc)

    async with SessionLocal() as session:
        result = await session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
        user = result.scalar_one_or_none()
        plan = user.plan if user and user.plan in PLAN_LIMITS else "free"
        limit = get_plan_limits(plan)["max_searches"]

        if user is None:
            return True

        result = await session.execute(
            select(SearchTask.id).where(
                SearchTask.user_id == user.id,
                SearchTask.is_active.is_(True),
                SearchTask.expires_at > now,
            )
        )
        return len(result.scalars().all()) < limitдба
