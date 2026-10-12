import json
import os
import re
from datetime import datetime
from typing import Any
from urllib.parse import quote, urljoin, urlparse

from playwright.async_api import async_playwright

AVITO_HOSTS = {"avito.ru", "www.avito.ru", "m.avito.ru"}
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
    hostname = (parsed.hostname or "").lower()
    if hostname not in AVITO_HOSTS and not hostname.endswith(".avito.ru"):
        raise ValueError("Разрешены только ссылки avito.ru.")
    if not parsed.path or parsed.path == "/":
        raise ValueError("Пришли ссылку именно на объявление Avito, а не на главную страницу или результаты поиска.")
    return url


async def _open_page():
    """Connect to Browserless when configured; otherwise try local Chromium.

    Production deployments should preferably set BROWSERLESS_TOKEN. Local
    mode is useful for development when Chromium was installed with Playwright.
    """
    playwright = await async_playwright().start()
    try:
        if BROWSERLESS_TOKEN:
            endpoint = (
                f"{BROWSERLESS_ENDPOINT.rstrip('/')}"
                f"?token={BROWSERLESS_TOKEN}"
            )
            browser = await playwright.chromium.connect_over_cdp(endpoint)
            context = (
                browser.contexts[0]
                if browser.contexts
                else await browser.new_context(locale="ru-RU")
            )
        else:
            browser = await playwright.chromium.launch(headless=True)
            context = await browser.new_context(locale="ru-RU", timezone_id="Europe/Moscow")
        page = await context.new_page()
        page.set_default_timeout(8000)
        return playwright, browser, page
    except Exception as exc:
        await playwright.stop()
        if not BROWSERLESS_TOKEN:
            raise RuntimeError(
                "Не настроен BROWSERLESS_TOKEN, а локальный Chromium недоступен. "
                "Укажи BROWSERLESS_TOKEN в переменных окружения или установи Chromium командой `playwright install chromium`."
            ) from exc
        raise RuntimeError(
            "Не удалось подключиться к Browserless. Проверь BROWSERLESS_TOKEN и BROWSERLESS_ENDPOINT."
        ) from exc


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


def _json_ld_product(data: Any) -> dict[str, Any] | None:
    """Find Product-like data in JSON-LD, including nested @graph arrays."""
    if isinstance(data, list):
        for value in data:
            found = _json_ld_product(value)
            if found:
                return found
    elif isinstance(data, dict):
        kind = data.get("@type", [])
        if isinstance(kind, str):
            kind = [kind]
        if any(str(x).lower() == "product" for x in kind):
            return data
        for key in ("@graph", "mainEntity", "item", "offers"):
            if key in data:
                found = _json_ld_product(data[key])
                if found:
                    return found
    return None


async def _meta_content(page, selectors: list[str]) -> str:
    for selector in selectors:
        try:
            value = await page.locator(selector).first.get_attribute("content", timeout=1200)
            if value and value.strip():
                return value.strip()
        except Exception:
            continue
    return ""


async def extract_product_info(url: str) -> dict[str, Any]:
    url = validate_avito_url(url)
    playwright, browser, page = await _open_page()

    try:
        response = await page.goto(
            url,
            wait_until="domcontentloaded",
            timeout=REQUEST_TIMEOUT,
        )
        try:
            await page.locator("body").wait_for(timeout=10000)
        except Exception:
            pass
        await page.wait_for_timeout(1200)

        title = await _locator_text(page, "h1")
        if not title:
            title = await _meta_content(page, [
                'meta[property="og:title"]',
                'meta[name="twitter:title"]',
                'meta[name="title"]',
            ])
        if not title:
            try:
                title = (await page.title()).split("|")[0].strip()
            except Exception:
                title = ""

        price_text = await _locator_text(
            page,
            '[data-marker="item-view/item-price"], '
            '[data-marker="item-view/item-price-value"], '
            '[itemprop="price"], [data-testid*="price"], '
            '[class*="price"]',
        )
        raw_price = await _meta_content(page, [
            'meta[property="product:price:amount"]',
            'meta[property="og:price:amount"]',
            'meta[itemprop="price"]',
        ])
        if not raw_price:
            try:
                raw_price = await page.locator('[itemprop="price"]').first.get_attribute("content", timeout=1200) or ""
            except Exception:
                raw_price = ""
        price = _price(raw_price) or _price(price_text)

        # Avito sometimes exposes the structured product data even when the
        # visible selectors change between page versions.
        if not title or price is None:
            try:
                scripts = await page.locator('script[type="application/ld+json"]').all_inner_texts()
                for script in scripts[:30]:
                    try:
                        product = _json_ld_product(json.loads(script))
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if not product:
                        continue
                    if not title:
                        name = product.get("name")
                        if isinstance(name, str):
                            title = name.strip()
                    if price is None:
                        offers = product.get("offers") or {}
                        if isinstance(offers, list):
                            offers = offers[0] if offers else {}
                        if isinstance(offers, dict):
                            price = _price(offers.get("price") or offers.get("lowPrice"))
                    if title and price is not None:
                        break
            except Exception:
                pass

        category = await _locator_text(page, '[data-marker="breadcrumbs"]')
        region = await _locator_text(page, '[data-marker="item-view/item-address"]')

        page_text = ""
        try:
            page_text = (await page.locator("body").inner_text(timeout=2000)).lower()[:6000]
        except Exception:
            pass
        if any(marker in page_text for marker in (
            "доступ ограничен", "подтвердите, что вы не робот", "captcha", "робот или человек"
        )) and (not title or price is None):
            raise RuntimeError(
                "Avito показал проверку/защиту вместо объявления. Проверь Browserless и попробуй позже."
            )

        if not title or price is None:
            status = getattr(response, "status", None)
            logger_msg = f"Не удалось извлечь название/цену Avito (HTTP {status}, title={bool(title)}, price={price is not None}). URL: {url}"
            import logging
            logging.getLogger(__name__).warning(logger_msg)
            raise ValueError(
                "Не удалось прочитать объявление Avito. Убедись, что ссылка открывается без авторизации и ведёт на конкретный товар. Если проблема повторяется, проверь BROWSERLESS_TOKEN в настройках сервера."
            )

        return {
            "title": title[:500],
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
