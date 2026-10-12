from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    telegram_id: Mapped[int] = mapped_column(
        BigInteger, unique=True, index=True, nullable=False
    )
    username: Mapped[str | None] = mapped_column(String(128))
    plan: Mapped[str] = mapped_column(String(32), default="free", nullable=False)
    plan_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    searches: Mapped[list["SearchTask"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    favorites: Mapped[list["Favorite"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class SearchTask(Base):
    __tablename__ = "search_tasks"
    __table_args__ = (
        Index("ix_search_owner_active_expiry", "user_id", "is_active", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    filters_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    region: Mapped[str] = mapped_column(String(100), default="rossiya", nullable=False)
    max_price: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship(back_populates="searches")
    items: Mapped[list["FoundItem"]] = relationship(
        back_populates="search_task", cascade="all, delete-orphan"
    )


class FoundItem(Base):
    __tablename__ = "found_items"
    __table_args__ = (
        UniqueConstraint("search_task_id", "url", name="uq_found_task_url"),
        Index("ix_found_task_found_at", "search_task_id", "found_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    search_task_id: Mapped[int] = mapped_column(
        ForeignKey("search_tasks.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    price: Mapped[int] = mapped_column(Integer, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    image: Mapped[str | None] = mapped_column(Text)
    found_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    is_new: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    search_task: Mapped["SearchTask"] = relationship(back_populates="items")
    favorites: Mapped[list["Favorite"]] = relationship(
        back_populates="item", cascade="all, delete-orphan"
    )


class Favorite(Base):
    __tablename__ = "favorites"
    __table_args__ = (
        UniqueConstraint("user_id", "item_id", name="uq_favorite_user_item"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("found_items.id", ondelete="CASCADE"), nullable=False
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    user: Mapped["User"] = relationship(back_populates="favorites")
    item: Mapped["FoundItem"] = relationship(back_populates="favorites")
