<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#0d1117">
  <meta name="description" content="RIV — находи такие же товары дешевле на Avito.">
  <title>RIV — Найти дешевле</title>

  <!-- Telegram WebApp SDK -->
  <script src="https://telegram.org/js/telegram-web-app.js"></script>

  <link rel="stylesheet" href="/app.css">
</head><body>
  <div class="app" id="app">

    <!-- ==================================================
         ВЕРХНЯЯ ПАНЕЛЬ И ПЕРВИЧНЫЕ ТАБЫ
         ================================================== -->

    <header class="topbar">
      <div class="brand-line">
        <div class="brand-mini">
          <div class="brand-emblem">R</div>
          <div class="brand gradient-text">RIV</div>
        </div>

        <div class="online-pill">
          <span class="online-dot"></span>
          Умный поиск
        </div>
      </div>

      <div class="top-tabs">
        <button class="top-tab active" id="top-search" data-top-tab="search">
          🔍 Поиск
        </button>
        <button class="top-tab" id="top-social" data-top-tab="social">
          📱 Соцсети
        </button>
      </div>
    </header>

    <main id="main-content">

      <!-- ==================================================
           ЭКРАН: ГЛАВНАЯ / ПОИСК
           ================================================== -->

      <section class="page" id="page-search">

        <div class="hero">
          <div class="hero-top">
            <span>👑</span>
            <span>RIV SMART SHOPPING</span>
          </div>

          <h1 class="hero-title">
            Находит такие же товары, <span class="gradient-text">но дешевле</span>
          </h1>

          <p class="hero-description">
            Сравнивай цены, находи выгодные предложения и экономь на покупках.
          </p>

          <div class="hero-art">
            <div class="hero-ring"></div>

            <div id="sneaker-fallback" style="display:block; position:relative; z-index:1; font-size:76px; transform:rotate(-18deg); filter:drop-shadow(0 12px 12px rgba(0,0,0,.4));">
              👟
            </div>

            <div class="discount-badge">−73%</div>
            <span class="hero-spark spark-one">✦</span>
            <span class="hero-spark spark-two">✧</span>
          </div>

          <button class="hero-photo-btn" id="hero-photo-btn" type="button" aria-label="Поиск по фото">
            📷
          </button>
        </div>

        <div class="search-section">
          <div class="limits-strip" id="limits-strip"></div>
          <label class="search-label" for="avito-url">
            Ссылка на товар
          </label>

          <div class="input-wrap">
            <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.71-1.71"/>
            </svg>

            <input
              class="url-input"
              type="url"
              id="avito-url"
              placeholder="Вставьте ссылку с Avito"
              autocomplete="url"
              autocapitalize="off"
              spellcheck="false"
              aria-label="Ссылка на товар Avito"
            >

            <button class="paste-btn" id="paste-btn" type="button">
              Вставить
            </button>
          </div>

          <p class="form-error hidden" id="form-error" role="alert"></p>

          <button class="primary-btn" id="search-btn" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
              <circle cx="10.8" cy="10.8" r="6.8"/>
              <path d="m16 16 4.2 4.2"/>
            </svg>
            Найти дешевле
          </button>

          <p class="helper-caption">
            Мы найдём похожие предложения и покажем, где выгоднее
          </p>
        </div>

        <!-- Блок "Мои активные поиски" -->
        <div class="search-section" id="active-searches-section">
          <div class="results-top" style="margin-bottom:12px">
            <div>
              <h2 class="section-heading">Мои активные поиски</h2>
              <div class="results-count" id="active-searches-count">Загрузка…</div>
            </div>
          </div>

          <div id="active-searches-skeleton">
            <div class="skeleton search-card" style="min-height:120px"></div>
            <div class="skeleton search-card" style="min-height:120px"></div>
          </div>

          <div id="active-searches-list"></div>

          <div class="empty-state hidden" id="active-searches-empty">
            <div class="empty-icon">🔍</div>
            <strong>Активных поисков пока нет</strong>
            Вставь ссылку на товар выше и нажми «Найти дешевле».
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value gradient-text">10–30 сек</div>
            <div class="stat-label">На поиск</div>
          </div>
          <div class="stat-card">
            <div class="stat-value gradient-text">&gt;10M</div>
            <div class="stat-label">Потенциальных товаров</div>
          </div>
          <div class="stat-card">
            <div class="stat-value gradient-text">до 70%</div>
            <div class="stat-label">Возможная экономия</div>
          </div>
          <div class="stat-card">
            <div class="stat-value gradient-text">100%</div>
            <div class="stat-label">Удобство</div>
          </div>
        </div>

        <!-- Результаты конкретного поиска (открывается кнопкой "Товары") -->
        <section class="results-section hidden" id="results-section">
          <div class="results-top">
            <div>
              <h2 class="section-heading" id="results-heading">Выгодные находки</h2>
              <div class="results-count" id="results-count">Найденные предложения</div>
            </div>

            <select class="sort-select" id="sort-select" aria-label="Сортировка товаров">
              <option value="cheap">Сначала дешевле</option>
              <option value="new">Сначала новые</option>
            </select>
          </div>

          <div id="skeleton-list" class="hidden" aria-label="Загрузка товаров">
            <div class="skeleton-card">
              <div class="skeleton skeleton-photo"></div>
              <div class="skeleton-lines">
                <div class="skeleton skeleton-line w-90"></div>
                <div class="skeleton skeleton-line w-70"></div>
                <div class="skeleton skeleton-line w-45" style="height:16px; margin-top:8px"></div>
                <div class="skeleton skeleton-line w-90" style="height:32px; margin-top:auto"></div>
              </div>
            </div>
            <div class="skeleton-card">
              <div class="skeleton skeleton-photo"></div>
              <div class="skeleton-lines">
                <div class="skeleton skeleton-line w-70"></div>
                <div class="skeleton skeleton-line w-90"></div>
                <div class="skeleton skeleton-line w-55" style="height:16px; margin-top:8px"></div>
                <div class="skeleton skeleton-line w-90" style="height:32px; margin-top:auto"></div>
              </div>
            </div>
          </div>

          <div class="product-list" id="product-list"></div>

          <div class="footer-note">
            Цены и наличие уточняйте у продавца. RIV не является продавцом товаров.
          </div>
        </section>
      </section>

      <!-- ==================================================
           ЭКРАН: СОЦСЕТИ
           ================================================== -->

      <section class="page hidden" id="page-social">
        <div class="social-intro">
          <div class="eyebrow" style="margin-bottom:12px">RIV COMMUNITY</div>
          <h1>RIV — наши <span class="gradient-text">соцсети</span></h1>
          <p>Следи за новинками, находками и обновлениями сервиса. Присоединяйся к нашему сообществу.</p>
        </div>

        <div class="social-section-label">Мы в соцсетях</div>

        <div class="social-grid-large">
          <!-- Telegram -->
          <button class="social-card" data-social-url="https://t.me/riv_news" aria-label="Открыть Telegram">
            <div class="social-circle telegram-bg">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path class="fill-white" d="M21.7 4.1 18.5 20c-.24 1.12-.91 1.4-1.84.87l-5.08-3.74-2.45 2.36c-.27.27-.5.5-1.03.5l.36-5.17 9.4-8.49c.41-.36-.09-.56-.64-.2L5.6 13.46.57 11.89c-1.1-.34-1.12-1.1.23-1.61L20.5 2.7c.91-.33 1.71.22 1.2 1.4Z"/>
              </svg>
            </div>
            <div class="social-name">Telegram</div>
          </button>

          <!-- Avito -->
          <button class="social-card" data-social-url="https://www.avito.ru" aria-label="Открыть Avito">
            <div class="social-circle" style="background:#fff;color:#00aaff;font-size:27px;font-weight:950;">a</div>
            <div class="social-name">Avito</div>
          </button>

          <!-- TikTok -->
          <button class="social-card" data-social-url="https://tiktok.com/@riv.app" aria-label="Открыть TikTok">
            <div class="social-circle tiktok-bg">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 3v12.1a4.1 4.1 0 1 1-4-4.1" stroke="#25f4ee" stroke-width="3" fill="none"/>
                <path d="M14 3v12.1a4.1 4.1 0 1 1-4-4.1" stroke="#fe2c55" stroke-width="3" fill="none" transform="translate(1.2 -.3)"/>
                <path d="M14 3v12.1a4.1 4.1 0 1 1-4-4.1" stroke="#fff" stroke-width="2" fill="none"/>
                <path d="M14 3c.2 2.7 1.7 4.4 4.5 4.6" stroke="#fff" stroke-width="2.5" fill="none"/>
              </svg>
            </div>
            <div class="social-name">TikTok</div>
          </button>
        </div>

        <button class="primary-btn social-support" id="social-support-btn">
          <span>💬</span> Поддержка
        </button>

        <p class="helper-caption">
          Есть вопрос или предложение? Напиши нам — мы на связи.
        </p>
      </section>

      <!-- ==================================================
           ЭКРАН: ИЗБРАННОЕ
           ================================================== -->

      <section class="page hidden" id="page-favorites">
        <div class="page-header">
          <div class="eyebrow" style="margin-bottom:10px">YOUR COLLECTION</div>
          <h1 class="page-title">Избранное <span class="gradient-text">☆</span></h1>
          <p class="section-subtitle">Сохраняй интересные находки, чтобы вернуться к ним позже.</p>
        </div>

        <div id="favorites-skeleton" class="showcase-grid hidden">
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-90"></div>
              <div class="skeleton skeleton-line w-55"></div>
            </div>
          </div>
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-70"></div>
              <div class="skeleton skeleton-line w-45"></div>
            </div>
          </div>
        </div>

        <div id="favorites-list"></div>
      </section>

      <!-- ==================================================
           ЭКРАН: ВИТРИНА — ПОИСК ПО КАТЕГОРИЯМ
           ================================================== -->
      <section class="page hidden" id="page-showcase">
        <div class="page-header">
          <div class="eyebrow" style="margin-bottom:10px">КАТАЛОГ ВЫГОДНЫХ НАХОДОК</div>
          <h1 class="page-title">🔥 Витрина</h1>
          <p class="section-subtitle">Выбери категорию и задай фильтры — RIV найдёт предложения на Avito.</p>
        </div>
        <div class="chips-row" id="category-chips">
          <button class="chip active" data-category="phones" type="button">📱 Телефоны</button>
          <button class="chip" data-category="clothes" type="button">👕 Одежда</button>
          <button class="chip" data-category="laptops" type="button">💻 Ноутбуки</button>
          <button class="chip" data-category="games" type="button">🎮 Игры</button>
          <button class="chip" data-category="shoes" type="button">👟 Обувь</button>
        </div>
        <div id="category-filter-form"></div>
        <button class="primary-btn" id="category-search-btn" type="button">🔍 Найти выгодные</button>
        <p class="helper-caption">Поиск создаётся в твоих активных поисках. Новые находки появятся во вкладке «Уведомления».</p>
        <div class="results-top" style="margin-top:22px">
          <div><h2 class="section-heading">Результаты поиска</h2><div class="results-count" id="category-results-count">Выбери фильтры и нажми «Найти»</div></div>
        </div>
        <div class="showcase-grid" id="category-results-grid"></div>
        <div class="empty-state" id="category-results-empty" style="margin-top:12px">
          <div class="empty-icon">🔎</div><strong>Пока нет результатов</strong>
          Настрой фильтры и нажми «Найти выгодные».
        </div>
      </section>

      <!-- ==================================================
           ЭКРАН: УВЕДОМЛЕНИЯ
           ================================================== -->

      <section class="page hidden" id="page-notifications">
        <div class="page-header">
          <div class="eyebrow" style="margin-bottom:10px">НОВЫЕ НАХОДКИ</div>
          <h1 class="page-title">🔔 Уведомления</h1>
          <p class="section-subtitle">Находки по активным поискам обновляются автоматически.</p>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
          <div class="chips-row" id="notifications-time-chips" style="margin-bottom:0;flex:1">
            <button class="chip active" data-time-filter="all" type="button">Все</button>
            <button class="chip" data-time-filter="6" type="button">6 часов</button>
            <button class="chip" data-time-filter="12" type="button">12 часов</button>
            <button class="chip" data-time-filter="24" type="button">24 часа</button>
            <button class="chip" data-time-filter="48" type="button">48 часов</button>
          </div>
          <button class="chip" id="notifications-favorites-btn" type="button" aria-label="Открыть избранное">⭐</button>
        </div>
        <div class="chips-row" id="notifications-search-chips">
          <button class="chip active" data-notification-search-filter="all" type="button">Все</button>
        </div>

        <div class="filters-bar">
          <select class="sort-select" id="notifications-sort" aria-label="Сортировка уведомлений" style="max-width:100%; flex:1">
            <option value="new">Свежее</option>
            <option value="discount">Выгодное</option>
            <option value="cheap">Дешевле</option>
          </select>
        </div>

        <div class="toggle-row">
          <span>📍 Только мои города</span>
          <div class="toggle" id="notifications-city-toggle" role="switch" aria-checked="false"></div>
        </div>

        <div class="showcase-grid hidden" id="notifications-skeleton">
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-90"></div>
              <div class="skeleton skeleton-line w-55"></div>
            </div>
          </div>
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-70"></div>
              <div class="skeleton skeleton-line w-45"></div>
            </div>
          </div>
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-90"></div>
              <div class="skeleton skeleton-line w-55"></div>
            </div>
          </div>
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-70"></div>
              <div class="skeleton skeleton-line w-45"></div>
            </div>
          </div>
        </div>

        <div class="showcase-grid" id="notifications-grid"></div>

        <div class="empty-state hidden" id="notifications-empty">
          <div class="empty-icon">🔥</div>
          <strong>Уведомлений пока нет</strong>
          Когда активные поиски найдут товары, они появятся здесь.
        </div>
      </section>

      <!-- ==================================================
           ЭКРАН: ИСТОРИЯ (НОВЫЙ)
           ================================================== -->

      <section class="page hidden" id="page-history">
        <div class="page-header">
          <div class="eyebrow" style="margin-bottom:10px">ВСЕ ЗАПУСКИ</div>
          <h1 class="page-title">📜 История</h1>
          <p class="section-subtitle">Все твои поиски, включая завершённые.</p>
        </div>

        <div id="history-skeleton">
          <div class="skeleton search-card" style="min-height:140px"></div>
          <div class="skeleton search-card" style="min-height:140px"></div>
          <div class="skeleton search-card" style="min-height:140px"></div>
        </div>

        <div id="history-list"></div>

        <div class="empty-state hidden" id="history-empty">
          <div class="empty-icon">📜</div>
          <strong>История пуста</strong>
          Здесь появятся все твои поиски после первого запуска.
        </div>
      </section>

      <!-- ==================================================
           ЭКРАН: ПРОФИЛЬ
           ================================================== -->

      <section class="page hidden" id="page-profile">
        <div class="page-header">
          <div class="eyebrow" style="margin-bottom:10px">YOUR ACCOUNT</div>
          <h1 class="page-title">Мой <span class="gradient-text">профиль</span></h1>
        </div>

        <div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="chip" id="profile-favorites-btn" type="button" aria-label="Открыть избранное">⭐ Избранное</button></div>
        <div class="profile-hero">
          <div class="profile-avatar" id="profile-avatar">R</div>
          <h2 class="profile-name" id="profile-name">Пользователь RIV</h2>
          <div class="profile-status">
            <span>●</span>
            <span id="profile-status-text">Загрузка…</span>
          </div>
          <p class="section-subtitle" style="color:#a5b7c6; margin-top:13px">
            Твой личный кабинет для выгодных покупок.
          </p>
        </div>

        <div class="panel-card">
          <div class="panel-row">
            <div class="panel-icon">🔎</div>
            <div>
              <h3>Поиски</h3>
              <p>Активных поисков: <strong id="search-total">0</strong></p>
            </div>
          </div>
        </div>

        <div class="panel-card">
          <div class="panel-row">
            <div class="panel-icon">⭐</div>
            <div>
              <h3 id="profile-plan-name">Тариф: Free</h3>
              <p id="profile-plan-expiry">Подписка не активна</p>
              <p id="profile-plan-limits" class="muted" style="margin-top:4px;font-size:12px"></p>
            </div>
          </div>
          <button class="primary-btn" id="open-plans-btn" style="margin-top:18px">
            ⭐ Оформить подписку
          </button>
        </div>

        <div class="panel-card">
          <div class="panel-row">
            <div class="panel-icon">🎁</div>
            <div>
              <h3>Приведи друга</h3>
              <p>Поделись ссылкой с другом и получи бонус.</p>
            </div>
          </div>

          <div class="referral-box">
            <span id="referral-link">https://t.me/RIV_DROP_bot</span>
            <button id="referral-copy-btn" type="button">Копировать</button>
          </div>

          <button class="secondary-btn" id="referral-share-btn" style="margin-top:10px">
            📤 Отправить другу в Telegram
          </button>
        </div>

        <button class="secondary-btn" id="profile-support-btn">
          💬 Связаться с поддержкой
        </button>

        <p class="footer-note">
          RIV — независимый сервис сравнения цен. Не связан с Avito.
        </p>
      </section>

      <!-- ==================================================
           ЭКРАН: FAQ
           ================================================== -->

      <section class="page hidden" id="page-faq">
        <div class="page-header">
          <div class="eyebrow" style="margin-bottom:10px">HELP CENTER</div>
          <h1 class="page-title">Частые <span class="gradient-text">вопросы</span></h1>
          <p class="section-subtitle">Короткие ответы на самые популярные вопросы.</p>
        </div>

        <div class="panel-card" id="faq-list">

          <div class="faq-item">
            <button class="faq-question" aria-expanded="false">
              <span>Как работает поиск RIV?</span>
              <span>+</span>
            </button>
            <div class="faq-answer hidden">
              Вставь ссылку на объявление Avito. Сервер найдёт похожие предложения по заданным критериям и будет отслеживать новые находки в течение срока действия поиска.
            </div>
          </div>

          <div class="faq-item">
            <button class="faq-question" aria-expanded="false">
              <span>Почему цены могут отличаться?</span>
              <span>+</span>
            </button>
            <div class="faq-answer hidden">
              Цена зависит от состояния, комплектации, региона и условий продавца. Всегда проверяй актуальную стоимость и характеристики непосредственно в объявлении.
            </div>
          </div>

          <div class="faq-item">
            <button class="faq-question" aria-expanded="false">
              <span>Как открыть объявление?</span>
              <span>+</span>
            </button>
            <div class="faq-answer hidden">
              Нажми на карточку товара — ссылка откроется через Telegram.
            </div>
          </div>

          <div class="faq-item">
            <button class="faq-question" aria-expanded="false">
              <span>Как связаться с поддержкой?</span>
              <span>+</span>
            </button>
            <div class="faq-answer hidden">
              Нажми на плавающего бота или кнопку поддержки в профиле/соцсетях.
            </div>
          </div>

          <div class="faq-item">
            <button class="faq-question" aria-expanded="false">
              <span>Сколько длится поиск и сколько их можно запустить?</span>
              <span>+</span>
            </button>
            <div class="faq-answer hidden">
              Free — 1 поиск, 6 часов. Стандарт — 1 поиск, 12 часов. Премиум — 2 поиска одновременно, 24 часа. Премиум Плюс — любое количество поисков, 48 часов. Когда время поиска истекает, освобождается место для нового.
            </div>
          </div>

          <div class="faq-item">
            <button class="faq-question" aria-expanded="false">
              <span>Как работает подписка?</span>
              <span>+</span>
            </button>
            <div class="faq-answer hidden">
              Подписка увеличивает число одновременных поисков и срок отслеживания, открывает избранное и поиск по фото. Оплата проходит через ЮKassa — как только платёж прошёл, подписка включается автоматически.
            </div>
          </div>
        </div>

        <button class="secondary-btn" id="faq-back-btn" style="margin-top:15px">
          ← Вернуться назад
        </button>
      </section>

    </main>

    <!-- ==================================================
         НИЖНЯЯ НАВИГАЦИЯ (5 ВКЛАДОК)
         ================================================== -->

    <nav class="bottom-nav" aria-label="Основная навигация">
      <div class="bottom-nav-inner">

        <button class="nav-item active" data-page="search" aria-label="Главная">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m3 10 9-7 9 7"/>
            <path d="M5 9v11h14V9"/>
            <path d="M9 20v-7h6v7"/>
          </svg>
          <span>Главная</span>
        </button>

        <button class="nav-item" data-page="showcase" aria-label="Витрина">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2c1 3-3 4-3 7a3 3 0 0 0 6 0c0-1-1-2-1-2 2 1 3 3 3 5a5 5 0 0 1-10 0c0-4 3-5 5-10Z"/>
          </svg>
          <span>Витрина</span>
        </button>

        <button class="nav-item" data-page="notifications" aria-label="Уведомления">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/>
            <path d="M10 21h4"/>
          </svg>
          <span>Уведомления</span>
          <span class="nav-badge hidden" id="notifications-badge">0</span>
        </button>

        <button class="nav-item" data-page="history" aria-label="История">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="13" r="8"/>
            <path d="M12 9v4l3 2"/>
            <path d="M9 2h6"/>
          </svg>
          <span>История</span>
        </button>

        <button class="nav-item" data-page="profile" aria-label="Профиль">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="8" r="4"/>
            <path d="M4 21a8 8 0 0 1 16 0"/>
          </svg>
          <span>Профиль</span>
        </button>

      </div>
    </nav>

    <!-- ==================================================
         ПЛАВАЮЩИЙ БОТ
         ================================================== -->

    <div class="bot-helper hidden" id="bot-helper">
      <button class="bot-bubble" id="bot-bubble" aria-label="Открыть помощь">
        Если нужна помощь — нажми на меня
      </button>

      <button class="bot-avatar-btn" id="bot-avatar" aria-label="Открыть помощь">
        <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
          <path d="M24 6v5" stroke="#e8faff" stroke-width="3" stroke-linecap="round"/>
          <circle cx="24" cy="5" r="3" fill="#a8f2ff" stroke="#ffffff" stroke-width="1"/>
          <rect x="7" y="12" width="34" height="27" rx="10" fill="#f1fbff" stroke="#b4eaff" stroke-width="2"/>
          <path d="M7 22H3v9h5M41 22h4v9h-5" fill="#d4f3ff" stroke="#b4eaff" stroke-width="1.5" stroke-linejoin="round"/>
          <rect x="13" y="20" width="8" height="8" rx="4" fill="#1685ef"/>
          <rect x="27" y="20" width="8" height="8" rx="4" fill="#1685ef"/>
          <path d="M17 33c2 2 4 3 7 3s5-1 7-3" stroke="#1685ef" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M13 15h22" stroke="#c0efff" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <!-- ==================================================
         ОБЩИЙ OVERLAY
         ================================================== -->

    <div class="overlay" id="overlay"></div>

    <!-- ==================================================
         BOTTOM SHEET: ПОМОЩЬ
         ================================================== -->

    <section class="bottom-sheet" id="help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="sheet-handle" data-sheet-handle></div>

      <div class="sheet-header">
        <h2 class="sheet-title" id="help-title">Помощь</h2>
        <button class="sheet-close" data-close-sheet aria-label="Закрыть">×</button>
      </div>

      <p class="sheet-description">
        Я помогу разобраться с поиском, результатами и работой RIV.
      </p>

      <button class="sheet-action" id="help-support-btn">
        <span class="sheet-action-icon">💬</span>
        <span>Написать в поддержку</span>
        <span class="sheet-action-arrow">›</span>
      </button>

      <button class="sheet-action" id="help-faq-btn">
        <span class="sheet-action-icon">❓</span>
        <span>Частые вопросы (FAQ)</span>
        <span class="sheet-action-arrow">›</span>
      </button>

      <button class="sheet-action sheet-close-text" data-close-sheet>
        ✖ Закрыть
      </button>
    </section>

    <!-- ==================================================
         BOTTOM SHEET: ПОДПИСКА
         ================================================== -->

    <section class="bottom-sheet" id="plans-sheet" role="dialog" aria-modal="true" aria-labelledby="plans-title">
      <div class="sheet-handle" data-sheet-handle></div>

      <div class="sheet-header">
        <h2 class="sheet-title" id="plans-title">RIV <span class="gradient-text">Premium</span></h2>
        <button class="sheet-close" data-close-sheet aria-label="Закрыть">×</button>
      </div>

      <p class="sheet-description" id="plans-description"></p>

      <div class="plan-list" id="plan-list"></div>

      <div class="eyebrow" style="margin:4px 0 10px">Срок подписки</div>

      <div class="duration-row" id="duration-row">
        <button class="duration-chip" data-duration="1" type="button">
          1 день
          <span class="duration-price">—</span>
        </button>
        <button class="duration-chip" data-duration="7" type="button">
          1 неделя
          <span class="duration-price">—</span>
        </button>
        <button class="duration-chip selected" data-duration="30" type="button">
          1 месяц
          <span class="duration-price">—</span>
        </button>
        <button class="duration-chip" data-duration="60" type="button">
          2 месяца
          <span class="duration-price">—</span>
        </button>
      </div>

      <div class="promo-row">
        <input type="text" id="promo-input" placeholder="Промокод" autocapitalize="off" spellcheck="false">
        <button id="promo-apply-btn" type="button">Применить</button>
      </div>

      <button class="primary-btn" id="pay-btn">
        ⭐ Оплатить через ЮKassa — 899 ₽
      </button>

      <p class="payment-note">
        Нажимая «Оплатить», ты будешь перенаправлен на страницу безопасной оплаты ЮKassa.
      </p>
    </section>

    <!-- ==================================================
         BOTTOM SHEET: ПОИСК ПО ФОТО
         ================================================== -->

    <section class="bottom-sheet" id="photo-sheet" role="dialog" aria-modal="true" aria-labelledby="photo-title">
      <div class="sheet-handle" data-sheet-handle></div>

      <div class="sheet-header">
        <h2 class="sheet-title" id="photo-title">📷 Поиск по фото</h2>
        <button class="sheet-close" data-close-sheet aria-label="Закрыть">×</button>
      </div>

      <p class="sheet-description">
        Загрузи фото товара — мы найдём похожие предложения на Avito.
      </p>

      <div id="photo-locked" class="hidden">
        <div class="empty-state">
          <div class="empty-icon">🔒</div>
          <strong>Доступно с платной подпиской</strong>
          Оформи любой платный тариф, чтобы искать товары по фотографии.
        </div>
        <button class="primary-btn" id="photo-upgrade-btn" style="margin-top:15px">
          ⭐ Оформить подписку
        </button>
      </div>

      <div id="photo-unlocked" class="hidden">
        <div class="photo-drop" id="photo-drop">
          <input type="file" accept="image/*" id="photo-input">
          <div>📷 Нажми, чтобы выбрать фото из галереи</div>
        </div>

        <img id="photo-preview" class="photo-preview" alt="Предпросмотр фото">

        <button class="primary-btn" id="photo-search-btn">
          🔍 Найти похожие
        </button>

        <div id="photo-skeleton" class="showcase-grid hidden" style="margin-top:18px">
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-90"></div>
              <div class="skeleton skeleton-line w-55"></div>
            </div>
          </div>
          <div class="showcase-skeleton-card">
            <div class="skeleton showcase-skeleton-photo"></div>
            <div class="showcase-skeleton-lines">
              <div class="skeleton skeleton-line w-70"></div>
              <div class="skeleton skeleton-line w-45"></div>
            </div>
          </div>
        </div>

        <div class="showcase-grid" id="photo-results" style="margin-top:18px"></div>
      </div>
    </section>

    <!-- Уведомления пользователю -->
    <div class="toast" id="toast" role="status" aria-live="polite"></div>

  </div>  <script src="/app.js" defer></script>
</body>
</html>
