import os
import re
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl
from playwright.async_api import async_playwright


app = FastAPI(title="Avito Cheap Search API")


# CORS: разрешает обращения с HTML-файла.
# Для продакшена лучше указать конкретный домен сайта.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Render -> Environment -> BROWSERLESS_TOKEN
BROWSERLESS_TOKEN = os.getenv("BROWSERLESS_TOKEN")

BROWSERLESS_URL = (
    f"wss://production-sfo.browserless.io?token={BROWSERLESS_TOKEN}"
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


def validate_avito_url(url: str) -> bool:
    parsed = urlparse(url)

    return (
        parsed.scheme == "https"
        and parsed.hostname in {"avito.ru", "www.avito.ru"}
    )


def extract_numeric_price(price_str: str) -> int:
    """Извлекает числовую цену из текста."""
    if not price_str:
        return 0

    digits = re.sub(r"[^\d]", "", price_str)
    return int(digits) if digits else 0


@app.get("/")
async def root():
    return {
        "status": "ok",
        "message": "Avito Cheap Search API is running",
    }


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

    if not BROWSERLESS_URL:
        raise HTTPException(
            status_code=500,
            detail="Не настроен BROWSERLESS_TOKEN в Render Environment",
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
                        "Chrome/131.0.0.0 Safari/537.36"
                    ),
                    locale="ru-RU",
                )

                page = await context.new_page()

                print(f"Открываем страницу: {url}")

                response = await page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=60000,
                )

                print(
                    "HTTP статус страницы:",
                    response.status if response else "нет ответа",
                )
                print("Фактический URL:", page.url)

                # Даём JavaScript страницы время на выполнение.
                try:
                    await page.wait_for_load_state(
                        "networkidle",
                        timeout=10000,
                    )
                except Exception:
                    pass

                await page.wait_for_timeout(4000)

                # Основные и резервные селекторы карточек.
                selectors = [
                    '[data-marker="item"]',
                    '[data-testid="item"]',
                    '[itemtype*="schema.org/Product"]',
                ]

                items = []

                for selector in selectors:
                    found = await page.query_selector_all(selector)

                    if found:
                        items = found
                        print(
                            f"Используем селектор {selector}; "
                            f"карточек: {len(items)}"
                        )
                        break

                # Диагностика, если карточки не обнаружены.
                if not items:
                    body_text = ""

                    try:
                        body_text = (
                            await page.locator("body").inner_text()
                        )[:2500]
                    except Exception:
                        pass

                    print("Карточки не найдены.")
                    print("Текст страницы:", body_text)

                    try:
                        print(
                            "Заголовок страницы:",
                            await page.title(),
                        )
                    except Exception:
                        pass

                    raise HTTPException(
                        status_code=502,
                        detail=(
                            "Авито не вернуло доступные карточки. "
                            "Проверь Logs в Render: страница могла "
                            "измениться, не загрузиться или показать "
                            "проверку безопасности."
                        ),
                    )

                # Извлекаем названия, цены и ссылки.
                for item in items[:50]:
                    try:
                        title = ""
                        href = ""
                        price = ""

                        title_selectors = [
                            'a[data-marker="item-title"]',
                            'h3[data-marker="item-title"]',
                            'h3[itemprop="name"]',
                            'a[itemprop="url"]',
                        ]

                        title_el = None

                        for selector in title_selectors:
                            title_el = await item.query_selector(
                                selector
                            )

                            if title_el:
                                break

                        if title_el:
                            title = (
                                await title_el.inner_text()
                            ).strip()

                            href = (
                                await title_el.get_attribute("href")
                                or ""
                            )

                        # Запасной поиск ссылки внутри карточки.
                        if not href:
                            link_el = await item.query_selector("a[href]")

                            if link_el:
                                href = (
                                    await link_el.get_attribute("href")
                                    or ""
                                )

                        # Извлекаем цену.
                        price_selectors = [
                            '[data-marker="item-price"]',
                            '[itemprop="price"]',
                            '[data-testid*="price"]',
                        ]

                        for selector in price_selectors:
                            price_el = await item.query_selector(
                                selector
                            )

                            if price_el:
                                if selector == '[itemprop="price"]':
                                    price = (
                                        await price_el.get_attribute(
                                            "content"
                                        )
                                        or ""
                                    )

                                    if not price:
                                        price = (
                                            await price_el.inner_text()
                                        ).strip()
                                else:
                                    price = (
                                        await price_el.inner_text()
                                    ).strip()

                                if price:
                                    break

                        if not title or not href:
                            continue

                        if href.startswith("/"):
                            href = "https://www.avito.ru" + href

                        # Не принимаем внешние ссылки.
                        parsed_href = urlparse(href)

                        if (
                            parsed_href.scheme != "https"
                            or parsed_href.hostname
                            not in {"avito.ru", "www.avito.ru"}
                        ):
                            continue

                        parsed_items.append(
                            AvitoItem(
                                title=title,
                                price=price or "Цена не указана",
                                url=href,
                            )
                        )

                    except Exception as e:
                        print(f"Ошибка обработки карточки: {e}")
                        continue

                await context.close()

            finally:
                await browser.close()

    except HTTPException:
        raise

    except Exception as e:
        print(f"Ошибка парсинга: {type(e).__name__}: {e}")

        raise HTTPException(
            status_code=502,
            detail=(
                "Не удалось получить объявления. "
                "Проверь подключение Browserless и Logs в Render. "
                f"Причина: {type(e).__name__}"
            ),
        ) from e

    print(f"Всего извлечено объявлений: {len(parsed_items)}")

    # Объявления с известной ценой идут первыми.
    # Затем сортировка от дешёвых к дорогим.
    parsed_items.sort(
        key=lambda item: (
            extract_numeric_price(item.price) == 0,
            extract_numeric_price(item.price),
        )
    )

    return SearchResponse(items=parsed_items[:5])
