```python
import os
import re
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl
from playwright.async_api import async_playwright


app = FastAPI(title="Avito Parser API")


# CORS — для подключения фронтенда.
# Для продакшена укажи адрес своего сайта.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Токен задаётся в Environment на Render.
BROWSERLESS_TOKEN = os.getenv("BROWSERLESS_TOKEN")

BROWSERLESS_URL = (
    f"wss://production-sfo.browserless.io"
    f"?token={BROWSERLESS_TOKEN}"
    if BROWSERLESS_TOKEN
    else None
)


class SearchRequest(BaseModel):
    url: HttpUrl


class AvitoItem(BaseModel):
    title: str
    price: str
    url: str


class SearchResponse(BaseModel):
    items: list[AvitoItem]


def extract_numeric_price(price_str: str) -> int:
    """Извлекает числа из строки цены для сортировки."""
    if not price_str:
        return 0

    digits = re.sub(r"[^\d]", "", price_str)
    return int(digits) if digits else 0


def validate_avito_url(url: str) -> bool:
    """Разрешает только домены Авито."""
    parsed = urlparse(url)

    return (
        parsed.scheme == "https"
        and parsed.hostname in {"avito.ru", "www.avito.ru"}
    )


@app.get("/")
async def root():
    return {"status": "ok", "message": "Avito Parser API is running"}


@app.get("/health")
async def health():
    return {"status": "healthy"}


@app.post("/api/search", response_model=SearchResponse)
async def search_avito(request: SearchRequest):
    url = str(request.url)

    if not validate_avito_url(url):
        raise HTTPException(
            status_code=400,
            detail="Разрешены только HTTPS-ссылки на avito.ru",
        )

    if not BROWSERLESS_TOKEN or not BROWSERLESS_URL:
        raise HTTPException(
            status_code=500,
            detail="На сервере не настроен BROWSERLESS_TOKEN",
        )

    parsed_items: list[AvitoItem] = []

    try:
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(
                BROWSERLESS_URL,
                timeout=60000,
            )

            try:
                context = await browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120.0.0.0 Safari/537.36"
                    )
                )

                page = await context.new_page()

                await page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=60000,
                )

                await page.wait_for_timeout(5000)

                items = await page.query_selector_all(
                    '[data-marker="item"]'
                )

                for item in items[:20]:
                    try:
                        title_el = await item.query_selector(
                            '[data-marker="item-title"]'
                        )

                        price_el = await item.query_selector(
                            '[data-marker="item-price"]'
                        )

                        link_el = await item.query_selector(
                            'a[data-marker="item-title"]'
                        )

                        title = (
                            await title_el.inner_text()
                            if title_el
                            else "Без названия"
                        )

                        price = (
                            await price_el.inner_text()
                            if price_el
                            else "Цена не указана"
                        )

                        href = (
                            await link_el.get_attribute("href")
                            if link_el
                            else None
                        )

                        if href and href.startswith("/"):
                            href = "https://www.avito.ru" + href

                        if not href:
                            continue

                        parsed_items.append(
                            AvitoItem(
                                title=title.strip(),
                                price=price.strip(),
                                url=href,
                            )
                        )

                    except Exception:
                        continue

                await context.close()

            finally:
                await browser.close()

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Ошибка парсинга: {str(e)}",
        ) from e

    # Сначала объявления с указанной ценой,
    # затем сортировка от дешёвых к дорогим.
    parsed_items.sort(
        key=lambda item: (
            extract_numeric_price(item.price) == 0,
            extract_numeric_price(item.price),
        )
    )

    return SearchResponse(items=parsed_items[:5])
```
