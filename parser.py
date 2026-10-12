import os
import re
from datetime import datetime
from typing import Any
from urllib.parse import quote, urljoin, urlparse

from playwright.async_api import async_playwright

AVITO_HOSTS = {"avito.ru", "www.avito.ru"}
BROWSERLESS_TOKEN = os.getenv("BROWSERLESS_TOKEN", "")
BROWSERLESS_ENDPOINT = os.getenv(
    "BROWSERLESS_ENDPOINT",
    "wss://production-sfo.browserless.io",
)
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "45000"))
MAX_SEARCH_PAGES = int(os.getenv("MAX_SEARCH_PAGES", "3"))


def validate_avito_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"}:
        raise ValueError("Нужна HTTP(S)-ссылка на объявление.")
    if (parsed.hostname or "").lower() not in AVITO_HOSTS:
        raise ValueError("Разрешены только ссылки avito.ru.")
    return url


async def _open_page():
    if not BROWSERLESS_TOKEN:
        raise RuntimeError("Не задан BROWSERLESS_TOKEN.")

    playwright = await async_playwright().start()
    endpoint = (
        f"{BROWSERLESS_ENDPOINT.rstrip('/')}"
        f"?token={BROWSERLESS_TOKEN}"
    )
    try:
        browser = await playwright.chromium.connect_over_cdp(endpoint)
        context = (
            browser.contexts[0]
            if browser.contexts
            else await browser.new_context(locale="ru-RU")
        )
        page = await context.new_page()
        return playwright, browser, page
    except Exception:
        await playwright.stop()
        raise


async def _close_page(playwright, browser, page) -> None:
    try:
        await page.close()
    finally:
        try:
            await browser.close()
        finally:
            await playwright.stop()


async def _locator_text(page, selector: str) -> str:
    try:
        return (
            await page.locator(selector).first.inner_text(timeout=2500)
        ).strip()
    except Exception:
        return ""


def _price(value: Any) -> int | None:
    if value is None:
        return None
    match = re.search(r"\d[\d\s\u00a0\u202f]*", str(value))
    if not match:
        return None
    digits = re.sub(r"\D", "", match.group(0))
    return int(digits) if digits else None


async def extract_product_info(url: str) -> dict[str, Any]:
    url = validate_avito_url(url)
    playwright, browser, page = await _open_page()

    try:
        await page.goto(
            url,
            wait_until="domcontentloaded",
            timeout=REQUEST_TIMEOUT,
        )
        await page.locator("body").wait_for(timeout=10000)
        await page.wait_for_timeout(1000)

        title = await _locator_text(page, "h1")
        if not title:
            title = (await page.title()).split("|")[0].strip()

        price_text = await _locator_text(
            page,
            '[data-marker="item-view/item-price"], '
            '[itemprop="price"], [data-testid*="price"]',
        )
        price = _price(price_text)

        if price is None:
            raw_price = await page.locator(
                '[itemprop="price"]'
            ).first.get_attribute("content")
            price = _price(raw_price)

        category = await _locator_text(
            page, '[data-marker="breadcrumbs"]'
        )
        region = await _locator_text(
            page, '[data-marker="item-view/item-address"]'
        )

        if not title or price is None:
            raise ValueError(
                "Не удалось получить название или цену объявления."
            )

        return {
            "title": title,
            "price": price,
            "category": category or None,
            "region": region or None,
            "url": url,
        }
    finally:
        await _close_page(playwright, browser, page)


def _region_path(region: str) -> str:
    region = (region or "rossiya").strip().lower()
    aliases = {
        "rossiya": "rossiya",
        "россия": "rossiya",
        "moskva": "moskva",
        "москва": "moskva",
        "spb": "sankt-peterburg",
        "санкт-петербург": "sankt-peterburg",
    }
    if region in aliases:
        return aliases[region]
    if re.fullmatch(r"[a-z0-9-]{1,80}", region):
        return region
    raise ValueError("Некорректный регион.")


def _search_url(
    title: str,
    max_price: int,
    region: str,
    page_number: int = 1,
) -> str:
    url = (
        f"https://www.avito.ru/{_region_path(region)}"
        f"?q={quote(title)}&pmax={max_price}&s=2"
    )
    if page_number > 1:
        url += f"&p={page_number}"
    return url


async def _parse_cards(page) -> list[dict[str, Any]]:
    cards = page.locator('[data-marker="item"]')
    count = min(await cards.count(), 100)
    result: list[dict[str, Any]] = []

    for index in range(count):
        card = cards.nth(index)
        try:
            link = card.locator('a[data-marker="item-title"]').first
            if await link.count() == 0:
                continue

            href = await link.get_attribute("href")
            title = (await link.inner_text()).strip()
            if not href or not title:
                continue

            url = urljoin("https://www.avito.ru", href)
            if (urlparse(url).hostname or "").lower() not in AVITO_HOSTS:
                continue

            price_text = await card.locator(
                '[data-marker="item-price"], [itemprop="price"]'
            ).first.inner_text(timeout=2000)
            price = _price(price_text)
            if price is None:
                raw = await card.locator(
                    '[itemprop="price"]'
                ).first.get_attribute("content")
                price = _price(raw)
            if price is None:
                continue

            image = await card.locator("img").first.get_attribute("src")
            if not image:
                image = await card.locator("img").first.get_attribute(
                    "data-src"
                )

            description = ""
            try:
                description = (
                    await card.locator(
                        '[data-marker="item-description"]'
                    ).inner_text(timeout=1000)
                ).strip()
            except Exception:
                pass

            result.append({
                "title": title,
                "price": price,
                "url": url,
                "image": image,
                "description": description,
            })
        except Exception:
            continue

    return result


async def search_similar(
    title: str,
    max_price: int,
    region: str = "rossiya",
    filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if not title.strip():
        raise ValueError("Название товара не должно быть пустым.")
    if max_price <= 0:
        raise ValueError("max_price должен быть больше нуля.")

    playwright, browser, page = await _open_page()
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    try:
        for page_number in range(1, max(1, MAX_SEARCH_PAGES) + 1):
            await page.goto(
                _search_url(title, max_price, region, page_number),
                wait_until="domcontentloaded",
                timeout=REQUEST_TIMEOUT,
            )
            await page.wait_for_timeout(800)

            batch = await _parse_cards(page)
            if not batch:
                break

            for item in batch:
                if item["url"] in seen:
                    continue
                seen.add(item["url"])
                items.append(item)

        return items
    finally:
        await _close_page(playwright, browser, page)


async def parse_new_items(
    url: str,
    last_checked: datetime | None,
    *,
    title: str | None = None,
    max_price: int | None = None,
    region: str = "rossiya",
    filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if title is None or max_price is None:
        source = await extract_product_info(url)
        title = title or source["title"]
        max_price = max_price or source["price"]

    return await search_similar(
        title=title,
        max_price=max_price,
        region=region,
        filters=filters,
    )
