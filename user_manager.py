from datetime import timezone

from sqlalchemy import select

from database import SessionLocal
from models import User


class UserNotFoundError(Exception):
    pass


async def create_user(
    telegram_id: int,
    username: str | None = None,
) -> dict:
    if telegram_id <= 0:
        raise ValueError("telegram_id должен быть положительным.")

    async with SessionLocal() as session:
        async with session.begin():
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
            elif username is not None:
                user.username = username
                await session.flush()

            return _serialize_user(user)


async def get_user(telegram_id: int) -> dict | None:
    async with SessionLocal() as session:
        result = await session.execute(
            select(User).where(User.telegram_id == telegram_id)
        )
        user = result.scalar_one_or_none()
        return _serialize_user(user) if user else None


async def update_user(
    telegram_id: int,
    username: str | None = None,
) -> dict:
    async with SessionLocal() as session:
        async with session.begin():
            result = await session.execute(
                select(User).where(User.telegram_id == telegram_id)
            )
            user = result.scalar_one_or_none()

            if user is None:
                raise UserNotFoundError("Пользователь не найден.")

            if username is not None:
                user.username = username

            await session.flush()
            return _serialize_user(user)


async def delete_user(telegram_id: int) -> bool:
    async with SessionLocal() as session:
        async with session.begin():
            result = await session.execute(
                select(User).where(User.telegram_id == telegram_id)
            )
            user = result.scalar_one_or_none()

            if user is None:
                return False

            await session.delete(user)
            return True


def _serialize_user(user: User) -> dict:
    created_at = user.created_at
    if created_at and created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)

    expires_at = user.plan_expires_at
    if expires_at and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    return {
        "id": user.id,
        "telegram_id": user.telegram_id,
        "username": user.username,
        "plan": user.plan,
        "plan_expires_at": (
            expires_at.isoformat() if expires_at else None
        ),
        "created_at": created_at.isoformat() if created_at else None,
    }
