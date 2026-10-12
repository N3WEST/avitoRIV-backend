import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from aiogram import Bot
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, HttpUrl
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import SessionLocal, get_session, init_db
from models import Favorite, FoundItem, SearchTask, User
from payment import create_payment, handle_webhook
from scheduler import configure_scheduler, shutdown_scheduler
from search_manager import (
    SearchLimitError,
    SearchNotFoundError,
    SearchPermissionError,
    create_search,
    delete_search,
    extend_search,
    get_active_searches,
    get_search_status,
    list_found_items,
    mark_items_read,
    pause_search,
    resume_search,
)
from subscription import check_subscription, get_or_create_user

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")


class SearchCreateRequest(BaseModel):
    telegram_id: int = Field(gt=0)
    username: str | None = None
    url: HttpUrl
    filters: dict[str, Any] = Field(default_factory=dict)
    region: str = "rossiya"
    max_price: int | None = Field(default=None, gt=0)


class FavoriteAddRequest(BaseModel):
    telegram_id: int = Field(gt=0)
    item_id: int = Field(gt=0)


class PaymentRequest(BaseModel):
    telegram_id: int = Field(gt=0)
    plan: str


class ExtendSearchRequest(BaseModel):
    telegram_id: int = Field(gt=0)
    additional_hours: int = Field(gt=0, le=24 * 30)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    app.state.bot = None

    if BOT_TOKEN:
        bot = Bot(token=BOT_TOKEN)
        app.state.bot = bot
        configure_scheduler(bot)
    else:
        logger.warning(
            "TELEGRAM_BOT_TOKEN не задан. Мониторинг не сможет отправлять уведомления."
        )

    try:
        yield
    finally:
        await shutdown_scheduler()
        if app.state.bot:
            await app.state.bot.session.close()


app = FastAPI(
    title="Avito Active Monitor API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/search/create")
async def api_create_search(request: SearchCreateRequest):
    try:
        task = await create_search(
            user_id=request.telegram_id,
            url=str(request.url),
            filters=request.filters,
            region=request.region,
            max_price=request.max_price,
            username=request.username,
        )
        return {"search": task}
    except SearchLimitError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except SearchPermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Ошибка создания поиска")
        raise HTTPException(
            status_code=502,
            detail="Не удалось создать поиск.",
        ) from exc


@app.get("/api/search/list")
async def api_search_list(telegram_id: int = Query(gt=0)):
    searches = await get_active_searches(telegram_id)
    return {"searches": searches}


@app.post("/api/search/{search_id}/pause")
async def api_pause_search(search_id: int, telegram_id: int = Query(gt=0)):
    try:
        await pause_search(search_id, telegram_id)
        return {"ok": True, "is_active": False}
    except SearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/search/{search_id}/resume")
async def api_resume_search(search_id: int, telegram_id: int = Query(gt=0)):
    try:
        await resume_search(search_id, telegram_id)
        return {"ok": True, "is_active": True}
    except SearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (SearchLimitError, SearchPermissionError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.delete("/api/search/{search_id}")
async def api_delete_search(search_id: int, telegram_id: int = Query(gt=0)):
    try:
        await delete_search(search_id, telegram_id)
        return {"ok": True}
    except SearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/search/{search_id}/status")
async def api_search_status(search_id: int, telegram_id: int = Query(gt=0)):
    try:
        return await get_search_status(search_id, telegram_id)
    except SearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/search/{search_id}/items")
async def api_search_items(
    search_id: int,
    telegram_id: int = Query(gt=0),
    limit: int = Query(default=100, ge=1, le=500),
):
    try:
        items = await list_found_items(search_id, telegram_id, limit)
        return {"items": items}
    except SearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/search/{search_id}/items/mark_read")
async def api_mark_items_read(
    search_id: int,
    telegram_id: int = Query(gt=0),
):
    try:
        count = await mark_items_read(search_id, telegram_id)
        return {"ok": True, "marked": count}
    except SearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/search/{search_id}/extend")
async def api_extend_search(
    search_id: int,
    request: ExtendSearchRequest,
):
    try:
        status = await extend_search(
            search_id,
            request.telegram_id,
            request.additional_hours,
        )
        return {"search": status}
    except SearchNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (SearchPermissionError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/favorites/add")
async def api_add_favorite(
    request: FavoriteAddRequest,
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(User).where(User.telegram_id == request.telegram_id)
    )
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден.")

    result = await session.execute(
        select(FoundItem)
        .join(SearchTask, FoundItem.search_task_id == SearchTask.id)
        .where(
            FoundItem.id == request.item_id,
            SearchTask.user_id == user.id,
        )
    )
    item = result.scalar_one_or_none()
    if item is None:
        raise HTTPException(
            status_code=404,
            detail="Товар не найден в поисках этого пользователя.",
        )

    existing = await session.execute(
        select(Favorite).where(
            Favorite.user_id == user.id,
            Favorite.item_id == item.id,
        )
    )
    if existing.scalar_one_or_none():
        return {"ok": True, "already_favorite": True}

    session.add(Favorite(user_id=user.id, item_id=item.id))
    await session.commit()
    return {"ok": True}


@app.get("/api/favorites/list")
async def api_favorites_list(
    telegram_id: int = Query(gt=0),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(
        select(User).where(User.telegram_id == telegram_id)
    )
    user = result.scalar_one_or_none()
    if user is None:
        return {"items": []}

    result = await session.execute(
        select(Favorite, FoundItem)
        .join(FoundItem, Favorite.item_id == FoundItem.id)
        .where(Favorite.user_id == user.id)
        .order_by(Favorite.added_at.desc())
    )

    return {
        "items": [
            {
                "favorite_id": favorite.id,
                "item_id": item.id,
                "title": item.title,
                "price": item.price,
                "url": item.url,
                "image": item.image,
                "added_at": favorite.added_at.isoformat(),
            }
            for favorite, item in result.all()
        ]
    }


@app.get("/api/subscription/status")
async def api_subscription_status(telegram_id: int = Query(gt=0)):
    plan = await check_subscription(telegram_id)
    return {"plan": plan, "is_paid": plan != "free"}


@app.post("/api/payment/create")
async def api_create_payment(request: PaymentRequest):
    try:
        url = await create_payment(request.telegram_id, request.plan)
        return {"confirmation_url": url}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Ошибка создания платежа")
        raise HTTPException(
            status_code=502,
            detail="Не удалось создать платёж.",
        ) from exc


@app.post("/api/yookassa/webhook")
async def api_yookassa_webhook(data: dict[str, Any]):
    try:
        updated = await handle_webhook(data)
        return {"ok": True, "updated": updated}
    except Exception:
        logger.exception("Ошибка обработки webhook ЮKassa")
        raise HTTPException(status_code=400, detail="Некорректный webhook.")
