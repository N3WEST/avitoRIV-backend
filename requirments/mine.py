import re
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from playwright.async_api import async_playwright

app = FastAPI()

# Настройка CORS для доступа с GitHub Pages и других источников
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    digits = re.sub(r'[^\d]', '', price_str)
    return int(digits) if digits else 0

@app.post("/api/search", response_model=SearchResponse)
async def search_avito(request: SearchRequest):
    # Проверка на валидность ссылки
    if not request.url.startswith("https://www.avito.ru") and not request.url.startswith("https://avito.ru"):
        raise HTTPException(status_code=400, detail="Разрешены только ссылки на Авито (https://www.avito.ru/...)")

    parsed_items = []

    try:
        async with async_playwright() as p:
            # Запускаем браузер в headless режиме
            browser = await p.chromium.launch(headless=True)
            
            # Подменяем User-Agent на реальный
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            page = await context.new_page()

            # Переходим по ссылке
            await page.goto(request.url, timeout=30000)

            try:
                # Ждем появления контейнеров с объявлениями
                await page.wait_for_selector('[data-marker="item"]', timeout=10000)
            except Exception:
                # Если за 10 секунд ничего не найдено, закрываем браузер и возвращаем пустой список
                await browser.close()
                return SearchResponse(items=[])

            # Собираем элементы объявлений
            items = await page.locator('[data-marker="item"]').all()

            # Парсим первые 20 объявлений
            for item in items[:20]:
                title_loc = item.locator('[data-marker="item-title"]')
                price_loc = item.locator('[data-marker="item-price"]')

                if await title_loc.count() == 0:
                    continue

                title = await title_loc.first.text_content()
                item_url = await title_loc.first.get_attribute("href")
                
                # Добавляем домен, если ссылка относительная
                if item_url and item_url.startswith("/"):
                    item_url = "https://www.avito.ru" + item_url

                price_str = "0"
                if await price_loc.count() > 0:
                    price_str = await price_loc.first.text_content()

                price_str = price_str.replace("₽", "").strip() if price_str else "0"

                parsed_items.append({
                    "title": title.strip() if title else "",
                    "price": price_str,
                    "url": item_url or "",
                    "numeric_price": extract_numeric_price(price_str)
                })

            await browser.close()

    except Exception as e:
        # Обработка падения Playwright
        raise HTTPException(status_code=500, detail=f"Ошибка парсинга Playwright: {str(e)}")

    # Сортируем по возрастанию цены
    sorted_items = sorted(parsed_items, key=lambda x: x["numeric_price"])

    # Берем топ-5 самых дешевых
    top_5 = sorted_items[:5]

    # Формируем итоговый ответ
    result = [
        AvitoItem(title=i["title"], price=i["price"], url=i["url"])
        for i in top_5
    ]

    return SearchResponse(items=result)
