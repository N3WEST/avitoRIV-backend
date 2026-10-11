import re
from fastapi import FastAPI,
HTTPException
from fastapi.middleware.cors import
CORSMiddleware
from pydantic import BaseModel 
from playwright.async_api import 
async_playwright

app = FastAPI()

app.add_middleware( 
    CORSMiddleware, 
    allow_origins=[""], 
    allow_credentials=True,
    allow_methods=[""], 
    allow_headers=["*"], 
)

BROWSERLESS_TOKEN = 
"2VQHMbDl1pGaIPkcac6258d91722229bcda869c9a021a914e" 
BROWSERLESS_URL = f"wss://production-sfo.browserless.io?
token={BROWSERLESS_TOKEN}"


class SearchRequest(BaseModel): 
    url: str


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
        digits = re.sub(r"[^\d]", "", 
    price_str) 
        return int(digits) if digits else 0


@app.post("/api/search", 
response_model=SearchResponse) 
async def search_avito(request:
SearchRequest): 
    if not 
request.url.startswith("https://www.avito.ru") and not 
    request.url.startswith("https://avito.ru"): 
        raise 
HTTPException(status_code=400, 
detail="Разрешены только ссылки на Авито (https://www.avito.ru/...)")

parsed_items = []

try:
    async with async_playwright() as p:
        # Подключаемся к удалённому Chromium в Browserless
        browser = await p.chromium.connect_over_cdp(BROWSERLESS_URL)

        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                       "AppleWebKit/537.36 (KHTML, like Gecko) "
                       "Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()

        await page.goto(request.url, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(5000)

        items = await page.query_selector_all('[data-marker="item"]')

        for item in items[:20]:
            try:
                title_el = await item.query_selector('[data-marker="item-title"]')
                price_el = await item.query_selector('[data-marker="item-price"]')
                link_el = await item.query_selector('a[data-marker="item-title"]')

                title = await title_el.inner_text() if title_el else "Без названия"
                price = await price_el.inner_text() if price_el else "Цена не указана"
                href = await link_el.get_attribute("href") if link_el else ""

                if href and not href.startswith("http"):
                    href = "https://www.avito.ru" + href

                parsed_items.append(AvitoItem(title=title.strip(), price=price.strip(), url=href))
            except Exception:
                continue

        await browser.close()

except Exception as e:
    raise HTTPException(status_code=500, detail=f"Ошибка парсинга: {str(e)}")

# Сортируем по цене (от дешёвых к дорогим)
parsed_items.sort(key=lambda x: extract_numeric_price(x.price))

return SearchResponse(items=parsed_items[:5])
