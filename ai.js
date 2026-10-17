document.addEventListener("error", event => {
      if (event.target && event.target.tagName === "IMG") event.target.style.display = "none";
    }, true);

    "use strict";

    /* ======================================================
       RIV — КОНФИГ И TELEGRAM WEBAPP ИНИЦИАЛИЗАЦИЯ
       ====================================================== */

    // Фронт отдаётся тем же сервером (riv-backend/public), поэтому адрес API — тот же домен.
    // Если хостишь фронт отдельно — впиши сюда URL сервера, например "https://api.example.com".
    const API_BASE = "";
    const SUPPORT_URL = "https://t.me/riv_support";
    const REFERRAL_URL = "https://t.me/RIV_DROP_bot";

    const tg = window.Telegram && window.Telegram.WebApp
      ? window.Telegram.WebApp
      : null;

    if (tg) {
      tg.ready();
      tg.expand();

      try {
        tg.setHeaderColor("#0d1117");
        tg.setBackgroundColor("#0d1117");
      } catch (error) {
        console.debug("Настройка цветов Telegram недоступна:", error);
      }

      document.body.classList.add("telegram-theme");
    }

    let TELEGRAM_ID = null;

    function getTelegramId() {
      try {
        if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) {
          return tg.initDataUnsafe.user.id;
        }
      } catch (error) {
        console.debug(error);
      }
      return null;
    }

    function getUsername() {
      try {
        return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.username) || "";
      } catch (error) {
        return "";
      }
    }

    /* ======================================================
       СОСТОЯНИЕ ПРИЛОЖЕНИЯ
       ====================================================== */

    const state = {
      page: "search",
      topTab: "search",
      previousPage: "search",

      searchStatus: "idle", // idle | searching

      searches: [],          // активные поиски (GET /api/search/list)
      historySearches: [],   // те же данные для экрана истории

      currentResultsSearchId: null,
      currentResultsItems: [],

      favorites: [],              // GET /api/favorites/list
      favoriteIds: new Set(),     // Set<item_id>

      showcaseItems: [],
      showcaseFilter: "all",
      showcaseSort: "new",
      showcaseCityOnly: false,
      notificationTimeFilter: "all",
      category: "phones",
      categoryResults: [],

      subscription: {
        plan: "free",
        is_paid: false,
        plan_expires_at: null
      },

      selectedPlan: "premium_plus",
      selectedDuration: 30,
      promoDiscount: 0,

      photoBase64: null
    };

    // Тарифы, цены и лимиты приходят с сервера (GET /api/config) — на клиенте их нет.
    const PLANS = {};

    function limitsOf(plan) {
      const p = PLANS[plan] || PLANS.free || { searches: 1, hours: 6, photo: false };
      return { searches: p.searches === null ? Infinity : p.searches, hours: p.hours, photo: p.photo };
    }

    function currentLimits() {
      return limitsOf(state.subscription.plan);
    }

    function occupiedSearches() {
      const now = Date.now();
      return (state.searches || []).filter(s => !s.expires_at || new Date(s.expires_at).getTime() > now);
    }

    function slotInfo() {
      if (state.slots) {
        return { used: state.slots.used, limit: state.slots.limit === null ? Infinity : state.slots.limit };
      }
      return { used: occupiedSearches().length, limit: currentLimits().searches };
    }

    function nextFreeSlotText() {
      const now = Date.now();
      const times = state.slots && state.slots.next_free_at
        ? [new Date(state.slots.next_free_at).getTime()]
        : occupiedSearches()
            .map(s => s.expires_at ? new Date(s.expires_at).getTime() : null)
            .filter(t => t !== null);
      if (!times.length) return "";
      const total = Math.max(1, Math.ceil((Math.min(...times) - now) / 60000));
      const h = Math.floor(total / 60), m = total % 60;
      return h ? (m ? `${h} ч ${m} мин` : `${h} ч`) : `${m} мин`;
    }

    function limitsLabel(plan) {
      const l = limitsOf(plan);
      const n = l.searches === Infinity ? "Безлимит поисков" : `${l.searches} ${pluralize(l.searches, "поиск", "поиска", "поисков")}`;
      return `${n} · ${l.hours} ч`;
    }

    function updateLimitsStrip() {
      const el = document.getElementById("limits-strip");
      if (!el) return;
      const si = slotInfo();
      const l = { ...currentLimits(), searches: si.limit };
      const used = si.used;
      const full = l.searches !== Infinity && used >= l.searches;
      const planLabel = PLAN_NAMES[state.subscription.plan] || "Free";
      const slots = l.searches === Infinity ? `${used} / ∞` : `${used} / ${l.searches}`;
      const note = full
        ? `Лимит занят. Следующий поиск можно добавить через ${nextFreeSlotText() || "—"} или повысить тариф.`
        : "";
      el.innerHTML = `
        <span>Тариф <b>${planLabel}</b></span>
        <span class="ls-pill ${full ? "full" : ""}">🔍 ${slots}</span>
        <span class="ls-pill">⏱ ${l.hours} ч на поиск</span>
        ${state.subscription.plan === "premium_plus" ? "" : '<button type="button" data-open-plans>Улучшить</button>'}
        ${note ? `<span class="ls-note">${note}</span>` : ""}
      `;
    }

    setInterval(() => { if (typeof updateLimitsStrip === "function") updateLimitsStrip(); }, 60000);

    
    /* ======================================================
       УТИЛИТЫ
       ====================================================== */

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

    let toastTimer = null;
    let bubbleTimers = [];
    let touchStartY = 0;
    let currentSheet = null;

    function haptic(style = "light") {
      try {
        if (tg && tg.HapticFeedback) {
          tg.HapticFeedback.impactOccurred(style);
        }
      } catch (error) {
        // В обычном браузере виброотклик просто пропускается.
      }
    }

    function toast(message) {
      const el = $("#toast");
      el.textContent = message;
      el.classList.add("show");

      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.classList.remove("show");
      }, 2800);
    }

    function formatPrice(value) {
      const n = Number(value) || 0;
      return new Intl.NumberFormat("ru-RU").format(n) + " ₽";
    }

    function escapeHTML(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function truncate(str, len) {
      if (!str) return "";
      return str.length > len ? str.slice(0, len) + "…" : str;
    }

    function pluralize(n, one, few, many) {
      const mod10 = n % 10;
      const mod100 = n % 100;

      if (mod10 === 1 && mod100 !== 11) return one;
      if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return few;
      return many;
    }

    function getInitials(name) {
      if (!name) return "R";
      const parts = name.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return "R";
      if (parts.length === 1) return parts[0][0].toUpperCase();
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function timeAgo(iso) {
      if (!iso) return "";

      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";

      const diffMs = Date.now() - date.getTime();
      const minutes = Math.max(0, Math.floor(diffMs / 60000));

      if (minutes < 1) return "только что";
      if (minutes < 60) return `${minutes} мин`;

      const hours = Math.floor(minutes / 60);
      const remMinutes = minutes % 60;

      if (hours < 24) {
        return remMinutes > 0 ? `${hours} ч ${remMinutes} мин` : `${hours} ч`;
      }

      const days = Math.floor(hours / 24);
      return `${days} ${pluralize(days, "день", "дня", "дней")}`;
    }


    function discountPercentFor(item) {
      if (typeof item.discount_percent === "number") return item.discount_percent;   // считает сервер
      if (!item.avgPrice || item.avgPrice <= 0) return 0;
      return Math.max(0, Math.round((1 - item.price / item.avgPrice) * 100));
    }

    /* ======================================================
       API ОБЁРТКА
       ====================================================== */

    async function api(method, path, body) {
      const opts = { method, headers: {} };
      // подпись Telegram: сервер по ней проверяет, что запрос идёт именно от этого пользователя
      if (tg && tg.initData) opts.headers["X-Telegram-Init-Data"] = tg.initData;

      if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }

      const res = await fetch(API_BASE + path, opts);

      let data = null;
      try {
        data = await res.json();
      } catch (error) {
        data = null;
      }

      if (!res.ok) {
        const message = (data && (data.error || data.message || (typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map(x => x.msg || JSON.stringify(x)).join("; ") : ""))) || `Ошибка ${res.status}`;
        throw new Error(message);
      }

      return data;
    }

    async function safeApi(method, path, body, errMsg) {
      try {
        return await api(method, path, body);
      } catch (error) {
        if (errMsg) toast(error && error.message ? error.message : errMsg);
        console.debug("API error:", error);
        return null;
      }
    }

    /* ======================================================
       TELEGRAM OPENLINK
       ====================================================== */

    function openExternal(url) {
      haptic("light");

      try {
        const parsed = new URL(url);

        if (parsed.protocol !== "https:") {
          toast("Некорректная ссылка");
          return;
        }

        if (tg && typeof tg.openLink === "function") {
          tg.openLink(parsed.href);
        } else {
          window.open(parsed.href, "_blank", "noopener,noreferrer");
        }
      } catch (error) {
        toast("Не удалось открыть ссылку");
      }
    }

    function openSupport() {
      closeSheet();
      openExternal(SUPPORT_URL);
    }

    /* ======================================================
       ПЕРЕКЛЮЧЕНИЕ ЭКРАНОВ
       ====================================================== */

    const pageIds = {
      search: "page-search",
      social: "page-social",
      favorites: "page-favorites",
      showcase: "page-showcase",
      notifications: "page-notifications",
      history: "page-history",
      profile: "page-profile",
      faq: "page-faq"
    };

    function setTopTab(tab) {
      state.topTab = tab;

      $$("[data-top-tab]").forEach(button => {
        button.classList.toggle("active", button.dataset.topTab === tab);
      });
    }

    function renderNavigation() {
      $$("[data-page]").forEach(button => {
        button.classList.toggle("active", button.dataset.page === state.page);
      });

      const count = (state.showcaseItems || []).filter(item => item.is_new === true).length;
      const badge = $("#notifications-badge");
      if (badge) {
        badge.textContent = String(count > 99 ? "99+" : count);
        badge.classList.toggle("hidden", count === 0);
      }
    }

    function showPage(page, options = {}) {
      if (!pageIds[page]) return;

      haptic("light");

      if (page !== "faq") {
        state.previousPage = page;
      }

      state.page = page;

      Object.entries(pageIds).forEach(([key, id]) => {
        $("#" + id).classList.toggle("hidden", key !== page);
      });

      if (page === "search" || page === "social") {
        setTopTab(page);
      } else if (page !== "faq") {
        setTopTab("search");
      }

      renderNavigation();
      updateBotVisibility();

      if (page === "favorites") loadFavorites();
      if (page === "notifications") loadShowcase();
      if (page === "history") loadHistory();
      if (page === "profile") loadProfile();
      if (page === "search") loadActiveSearches();

      if (!options.keepScroll) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }

    $$("[data-top-tab]").forEach(button => {
      button.addEventListener("click", () => {
        showPage(button.dataset.topTab);
      });
    });

    $$("[data-page]").forEach(button => {
      button.addEventListener("click", () => {
        showPage(button.dataset.page);
      });
    });

    /* ======================================================
       ВАЛИДАЦИЯ ССЫЛКИ И ВСТАВКА ИЗ БУФЕРА
       ====================================================== */

    function isValidAvitoURL(value) {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          (url.hostname === "avito.ru" || url.hostname.endsWith(".avito.ru"))
        );
      } catch (error) {
        return false;
      }
    }

    $("#paste-btn").addEventListener("click", async () => {
      haptic("light");
      const input = $("#avito-url");

      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();

          if (text.trim()) {
            input.value = text.trim();
            $("#form-error").classList.add("hidden");
            toast("Ссылка вставлена");
            input.focus();
            return;
          }

          toast("Буфер обмена пуст");
        } else {
          input.focus();
          toast("Вставь ссылку через меню буфера обмена");
        }
      } catch (error) {
        input.focus();
        toast("Разреши буфер обмена или вставь ссылку вручную");
      }
    });

    $("#avito-url").addEventListener("input", () => {
      $("#form-error").classList.add("hidden");
    });

    $("#avito-url").addEventListener("keydown", event => {
      if (event.key === "Enter") startSearch();
    });

    /* ======================================================
       ГЛАВНАЯ: СОЗДАНИЕ ПОИСКА
       ====================================================== */

    function restoreSearchButton() {
      const button = $("#search-btn");
      button.disabled = false;
      button.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.2"
          stroke-linecap="round" aria-hidden="true">
          <circle cx="10.8" cy="10.8" r="6.8"/>
          <path d="m16 16 4.2 4.2"/>
        </svg>
        Найти дешевле
      `;
    }

    async function startSearch() {
      haptic("medium");

      if (!TELEGRAM_ID) {
        toast("Открой через бота");
        return;
      }

      const input = $("#avito-url");
      const url = input.value.trim();
      const error = $("#form-error");

      if (!url) {
        error.textContent = "Вставь ссылку на товар с Avito.";
        error.classList.remove("hidden");
        input.focus();
        haptic("light");
        return;
      }

      if (!isValidAvitoURL(url)) {
        error.textContent = "Проверь ссылку. Нужен адрес объявления на avito.ru.";
        error.classList.remove("hidden");
        input.focus();
        haptic("light");
        return;
      }

      const limits = { ...currentLimits(), searches: slotInfo().limit };
      if (limits.searches !== Infinity && slotInfo().used >= limits.searches) {
        const wait = nextFreeSlotText();
        error.textContent = `Лимит тарифа: ${limits.searches} ${pluralize(limits.searches, "поиск", "поиска", "поисков")} одновременно. ` +
          (wait ? `Новый можно запустить через ${wait} или повысить тариф.` : "Повысь тариф, чтобы искать больше.");
        error.classList.remove("hidden");
        haptic("light");
        return;
      }

      error.classList.add("hidden");

      const btn = $("#search-btn");
      btn.disabled = true;
      btn.innerHTML = `
        <svg class="spin" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.3" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke-opacity=".25"/>
          <path d="M21 12a9 9 0 0 0-9-9"/>
        </svg>
        Создаём поиск…
      `;

      state.searchStatus = "searching";
      updateBotVisibility();

      const res = await safeApi("POST", "/api/search/create", {
        telegram_id: TELEGRAM_ID,
        username: getUsername(),
        url,
        region: "",
        max_price: null,
        filters: {}
      }, "Не удалось создать поиск");

      state.searchStatus = "idle";
      updateBotVisibility();
      restoreSearchButton();

      if (res && res.search) {
        toast("✅ Поиск создан!");
        input.value = "";
        haptic("success");
        await loadActiveSearches();
      }
    }

    $("#search-btn").addEventListener("click", startSearch);

    /* ======================================================
       ГЛАВНАЯ: МОИ АКТИВНЫЕ ПОИСКИ
       ====================================================== */

    function searchStatusInfo(search) {
      const now = Date.now();
      const expiresAt = search.expires_at ? new Date(search.expires_at).getTime() : null;
      const isExpired = expiresAt !== null && now > expiresAt;

      if (isExpired) {
        return { label: "Истёк", cls: "status-expired", remainingHours: 0, expired: true };
      }

      if (!search.is_active) {
        return {
          label: "На паузе",
          cls: "status-paused",
          remainingHours: expiresAt ? Math.max(0, Math.round((expiresAt - now) / 3600000)) : null,
          expired: false
        };
      }

      return {
        label: "Активен",
        cls: "status-active",
        remainingHours: expiresAt ? Math.max(0, Math.round((expiresAt - now) / 3600000)) : null,
        expired: false
      };
    }

    function searchCardHTML(search) {
      const info = searchStatusInfo(search);
      const remainingText = info.remainingHours !== null
        ? `⏰ Осталось ${info.remainingHours} ч.`
        : "⏰ —";

      return `
        <div class="search-card" data-search-card="${search.id}">
          <span class="search-card-status ${info.cls}">${info.label}</span>
          <h3 class="search-card-title">${escapeHTML(search.title || "Без названия")}</h3>
          <div class="search-card-meta">
            <span>${remainingText}</span>
            <span>📦 Найдено: ${search.found_count ?? 0}</span>
          </div>
          <div class="search-card-actions">
            <button class="accent" data-action="items" data-search-id="${search.id}" type="button">
              📋 Товары
            </button>
            <button data-action="toggle" data-search-id="${search.id}" data-active="${search.is_active}" type="button">
              ${search.is_active ? "⏸ Пауза" : "▶️ Пуск"}
            </button>
            <button class="danger" data-action="delete" data-search-id="${search.id}" type="button">
              🗑 Удалить
            </button>
          </div>
        </div>
      `;
    }

    async function loadActiveSearches() {
      if (!TELEGRAM_ID) {
        $("#active-searches-skeleton").classList.add("hidden");
        $("#active-searches-empty").classList.remove("hidden");
        $("#active-searches-count").textContent = "Недоступно без Telegram";
        return;
      }

      $("#active-searches-skeleton").classList.remove("hidden");
      $("#active-searches-list").innerHTML = "";
      $("#active-searches-empty").classList.add("hidden");

      const data = await safeApi("GET", `/api/search/list?telegram_id=${TELEGRAM_ID}`, undefined, "Не удалось загрузить поиски");
      $("#active-searches-skeleton").classList.add("hidden");

      state.searches = (data && data.searches) || [];
      state.slots = (data && data.slots) || null;
      updateLimitsStrip();

      if (!state.searches.length) {
        $("#active-searches-empty").classList.remove("hidden");
        $("#active-searches-count").textContent = "0 активных поисков";
        $("#search-total").textContent = "0";
        return;
      }

      $("#active-searches-count").textContent =
        `${state.searches.length} ${pluralize(state.searches.length, "поиск", "поиска", "поисков")}`;
      $("#search-total").textContent = String(state.searches.length);

      $("#active-searches-list").innerHTML = state.searches.map(searchCardHTML).join("");
    }

    async function toggleSearchPause(id, isActive) {
      haptic("light");
      const endpoint = isActive ? "pause" : "resume";

      const res = await safeApi(
        "POST",
        `/api/search/${id}/${endpoint}?telegram_id=${TELEGRAM_ID}`,
        undefined,
        "Не удалось изменить статус поиска"
      );

      if (res !== null) {
        toast(isActive ? "⏸ Поиск на паузе" : "▶️ Поиск возобновлён");
        await loadActiveSearches();
        if (state.page === "history") await loadHistory();
      }
    }

    async function deleteSearch(id) {
      haptic("light");

      const doDelete = async () => {
        const res = await safeApi(
          "DELETE",
          `/api/search/${id}?telegram_id=${TELEGRAM_ID}`,
          undefined,
          "Не удалось удалить поиск"
        );

        if (res !== null) {
          toast("🗑 Поиск удалён");
          await loadActiveSearches();
          if (state.page === "history") await loadHistory();

          if (state.currentResultsSearchId === id) {
            $("#results-section").classList.add("hidden");
            state.currentResultsSearchId = null;
          }
        }
      };

      if (tg && typeof tg.showConfirm === "function") {
        tg.showConfirm("Удалить этот поиск?", ok => {
          if (ok) doDelete();
        });
      } else if (window.confirm("Удалить этот поиск?")) {
        doDelete();
      }
    }

    async function repeatSearch(id) {
      const search = state.historySearches.find(s => s.id === id)
        || state.searches.find(s => s.id === id);

      if (!search) {
        toast("Не удалось найти данные поиска");
        return;
      }

      haptic("medium");

      const res = await safeApi("POST", "/api/search/create", {
        telegram_id: TELEGRAM_ID,
        username: getUsername(),
        url: search.url,
        region: search.region || "",
        max_price: search.max_price ?? null,
        filters: {}
      }, "Не удалось создать поиск");

      if (res && res.search) {
        toast("✅ Поиск создан!");
        await loadActiveSearches();
        await loadHistory();
        showPage("search");
      }
    }

    /* ======================================================
       ГЛАВНАЯ: ПРОСМОТР ТОВАРОВ КОНКРЕТНОГО ПОИСКА
       ====================================================== */

    function resultItemCardHTML(item, index = 0) {
      const isFav = state.favoriteIds.has(item.id);
      const city = item.city || "—";

      return `
        <article class="product-card" style="animation-delay:${Math.min(index * 55, 300)}ms">
          <div class="product-photo">
            ${item.image
              ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.title)}" loading="lazy">`
              : `<div class="product-emoji">📦</div>`
            }
          </div>

          <div class="product-content">
            <h3 class="product-name">${escapeHTML(item.title)}</h3>

            <div class="product-location">
              📍 ${escapeHTML(city)} · ${timeAgo(item.found_at)}
            </div>

            <div class="price-row">
              <span class="price-new">${formatPrice(item.price)}</span>
            </div>

            <div class="product-bottom">
              <button class="open-avito" data-open-url="${escapeHTML(item.url)}" type="button">
                Открыть на Avito
                <svg viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <path d="M14 3h7v7"/>
                  <path d="M10 14 21 3"/>
                  <path d="M19 13v7H4V5h7"/>
                </svg>
              </button>

              <button
                class="favorite-btn ${isFav ? "is-favorite" : ""}"
                data-favorite-item="${item.id}"
                type="button"
                aria-pressed="${isFav}"
                aria-label="${isFav ? "Удалить из избранного" : "Добавить в избранное"}"
              >
                <svg viewBox="0 0 24 24"
                  fill="${isFav ? "currentColor" : "none"}"
                  stroke="currentColor" stroke-width="1.9"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>
                </svg>
              </button>
            </div>
          </div>
        </article>
      `;
    }

    function sortResultItems(items) {
      const sort = $("#sort-select").value;
      const sorted = [...items];

      if (sort === "new") {
        sorted.sort((a, b) => new Date(b.found_at) - new Date(a.found_at));
      } else {
        sorted.sort((a, b) => a.price - b.price);
      }

      return sorted;
    }

    function renderResultsProducts(items) {
      const container = $("#product-list");

      if (!items.length) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">🔎</div>
            <strong>Пока ничего не найдено</strong>
            Поиск ещё обрабатывается — загляни чуть позже.
          </div>
        `;
        return;
      }

      container.innerHTML = sortResultItems(items).map(resultItemCardHTML).join("");
    }

    $("#sort-select").addEventListener("change", () => {
      haptic("light");
      renderResultsProducts(state.currentResultsItems);
    });

    async function openSearchItems(searchId) {
      if (!TELEGRAM_ID) {
        toast("Открой через бота");
        return;
      }

      const search = state.searches.find(s => s.id === searchId)
        || state.historySearches.find(s => s.id === searchId);

      state.currentResultsSearchId = searchId;

      const section = $("#results-section");
      section.classList.remove("hidden");

      $("#results-heading").textContent = search ? `Товары: ${search.title}` : "Товары";
      $("#results-count").textContent = "Загрузка…";
      $("#skeleton-list").classList.remove("hidden");
      $("#product-list").innerHTML = "";

      section.scrollIntoView({ behavior: "smooth", block: "start" });

      const data = await safeApi(
        "GET",
        `/api/search/${searchId}/items?telegram_id=${TELEGRAM_ID}&limit=100`,
        undefined,
        "Не удалось загрузить товары"
      );

      $("#skeleton-list").classList.add("hidden");

      const items = (data && data.items) || [];
      state.currentResultsItems = items;

      $("#results-count").textContent = `Найдено предложений: ${items.length}`;
      renderResultsProducts(items);
    }

    /* ======================================================
       ИЗБРАННОЕ
       ====================================================== */

    function emptyFavoritesHTML() {
      return `
        <div class="empty-state">
          <div class="empty-icon">⭐</div>
          <strong>Здесь пока пусто</strong>
          Сохраняй товары звёздочкой в витрине или результатах поиска.
          <button class="primary-btn" id="favorites-search-btn" style="margin-top:18px">
            🔍 Перейти к поиску
          </button>
        </div>
      `;
    }

    function bindFavoritesEmptyButton() {
      const btn = $("#favorites-search-btn");
      if (btn) btn.addEventListener("click", () => showPage("search"));
    }

    async function loadFavorites() {
      if (!TELEGRAM_ID) {
        $("#favorites-skeleton").classList.add("hidden");
        $("#favorites-list").innerHTML = emptyFavoritesHTML();
        bindFavoritesEmptyButton();
        return;
      }

      $("#favorites-skeleton").classList.remove("hidden");
      $("#favorites-list").innerHTML = "";

      const data = await safeApi(
        "GET",
        `/api/favorites/list?telegram_id=${TELEGRAM_ID}`,
        undefined,
        "Не удалось загрузить избранное"
      );

      $("#favorites-skeleton").classList.add("hidden");

      const items = (data && data.items) || [];
      state.favorites = items;
      state.favoriteIds = new Set(items.map(i => i.item_id));

      renderNavigation();

      if (!items.length) {
        $("#favorites-list").innerHTML = emptyFavoritesHTML();
        bindFavoritesEmptyButton();
        return;
      }

      const cards = items.map((it, i) => showcaseCardHTML({
        id: it.item_id,
        title: it.title,
        price: it.price,
        url: it.url,
        image: it.image,
        found_at: it.added_at,
        is_new: false,
        avgPrice: null,
        searchId: null
      }, i, false)).join("");

      $("#favorites-list").innerHTML = `<div class="showcase-grid">${cards}</div>`;
    }

    async function toggleFavoriteItem(itemId) {
      haptic("light");

      if (!TELEGRAM_ID) {
        toast("Открой через бота");
        return;
      }

      const isFav = state.favoriteIds.has(itemId);

      if (isFav) {
        await safeApi("POST", "/api/favorites/remove", { telegram_id: TELEGRAM_ID, item_id: itemId }, "Не удалось удалить из избранного");
        state.favoriteIds.delete(itemId);
        state.favorites = state.favorites.filter(f => f.item_id !== itemId);
        toast("Удалено из избранного");
      } else {
        const res = await safeApi("POST", "/api/favorites/add", {
          telegram_id: TELEGRAM_ID,
          item_id: itemId
        }, "Не удалось добавить в избранное");

        if (!res) return;

        state.favoriteIds.add(itemId);
        toast("Добавлено в избранное ⭐");
      }

      renderNavigation();

      if (state.page === "favorites") loadFavorites();
      if (state.page === "notifications") renderShowcase();
      if (state.currentResultsItems && state.currentResultsItems.length) {
        renderResultsProducts(state.currentResultsItems);
      }
    }

    /* ======================================================
       ВИТРИНА
       ====================================================== */

    function showcaseCardHTML(item, index, locked) {
      const discount = discountPercentFor(item);
      const city = item.city || "";
      const isFav = state.favoriteIds.has(item.id);
      const timeStr = timeAgo(item.found_at);

      const lockOverlay = locked ? `
        <div class="lock-overlay">
          <div class="lock-overlay-icon">🔒</div>
          <button type="button" data-open-plans>Оформить подписку</button>
        </div>
      ` : "";

      return `
        <article class="showcase-card ${locked ? "locked" : ""}" style="animation-delay:${Math.min(index * 45, 300)}ms">
          ${lockOverlay}
          <div class="showcase-inner" ${locked ? "" : `data-card-url="${escapeHTML(item.url || "")}"`}>
            <div class="showcase-photo">
              ${item.image
                ? `<img src="${escapeHTML(item.image)}" alt="${escapeHTML(item.title)}" loading="lazy">`
                : `<div class="showcase-photo-empty">📦</div>`
              }

              ${discount > 0 ? `<span class="showcase-badge-discount">−${discount}%</span>` : ""}

              <span class="showcase-badge-time">
                ${item.is_new ? '<span class="new-dot"></span>NEW · ' : ""}${timeStr}
              </span>

              <button
                class="showcase-fav ${isFav ? "is-favorite" : ""}"
                data-favorite-item="${item.id}"
                type="button"
                aria-label="Избранное"
              >
                <svg viewBox="0 0 24 24"
                  fill="${isFav ? "currentColor" : "none"}"
                  stroke="currentColor" stroke-width="1.9"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>
                </svg>
              </button>
            </div>

            <div class="showcase-body">
              <h3 class="showcase-name">${escapeHTML(item.title)}</h3>
              <div class="showcase-price">${formatPrice(item.price)}</div>
              ${item.avgPrice ? `<div class="showcase-avg">средняя ${formatPrice(item.avgPrice)}</div>` : ""}
              ${city ? `<div class="showcase-city">📍 ${escapeHTML(city)}</div>` : ""}
            </div>
          </div>
        </article>
      `;
    }

    function renderShowcaseChips(searches) {
      const container = $("#notifications-search-chips");

      const chips = [
        `<button class="chip ${state.showcaseFilter === "all" ? "active" : ""}" data-notification-search-filter="all" type="button">Все</button>`
      ].concat(searches.map(s => `
        <button class="chip ${String(state.showcaseFilter) === String(s.id) ? "active" : ""}" data-notification-search-filter="${s.id}" type="button">
          ${escapeHTML(truncate(s.title || "Поиск", 16))}
        </button>
      `));

      container.innerHTML = chips.join("");
    }

    function renderShowcase() {
      const items = state.showcaseItems;
      const grid = $("#notifications-grid");

      if (!items.length) {
        grid.innerHTML = "";
        $("#notifications-empty").classList.remove("hidden");
        return;
      }

      $("#notifications-empty").classList.add("hidden");
      // item.locked выставляет сервер: у заблокированных карточек данных в ответе уже нет
      grid.innerHTML = items.map((item, index) => showcaseCardHTML(item, index, !!item.locked)).join("");
    }

    async function loadShowcase() {
      if (!TELEGRAM_ID) {
        $("#notifications-skeleton").classList.add("hidden");
        $("#notifications-grid").innerHTML = "";
        $("#notifications-empty").classList.remove("hidden");
        return;
      }

      $("#notifications-skeleton").classList.remove("hidden");
      $("#notifications-grid").innerHTML = "";
      $("#notifications-empty").classList.add("hidden");

      const params = new URLSearchParams({ sort: state.showcaseSort });
      if (state.notificationTimeFilter !== "all") params.set("hours", state.notificationTimeFilter);
      if (state.showcaseFilter !== "all") params.set("search_id", state.showcaseFilter);
      if (state.showcaseCityOnly) params.set("local", "1");

      const data = await safeApi("GET", `/api/notifications?${params}`, undefined, "Не удалось загрузить уведомления");

      $("#notifications-skeleton").classList.add("hidden");

      state.showcaseItems = (data && data.items) || [];
      renderShowcaseChips((data && data.searches) || []);
      renderShowcase();
      renderNavigation();
    }

    function openShowcaseForSearch(id) {
      state.showcaseFilter = String(id);
      showPage("notifications");   // showPage сам вызовет loadShowcase() с выбранным фильтром
    }

    $("#notifications-search-chips").addEventListener("click", event => {
      const chip = event.target.closest("[data-notification-search-filter]");
      if (!chip) return;

      haptic("light");
      state.showcaseFilter = chip.dataset.notificationSearchFilter;

      $$("#notifications-search-chips .chip").forEach(c => c.classList.toggle("active", c === chip));
      loadShowcase();
    });

    $("#notifications-sort").addEventListener("change", () => {
      haptic("light");
      state.showcaseSort = $("#notifications-sort").value;
      loadShowcase();
    });

    $("#notifications-city-toggle").addEventListener("click", () => {
      haptic("light");
      state.showcaseCityOnly = !state.showcaseCityOnly;

      const el = $("#notifications-city-toggle");
      el.classList.toggle("on", state.showcaseCityOnly);
      el.setAttribute("aria-checked", String(state.showcaseCityOnly));

      loadShowcase();
    });

    /* ======================================================
       ВИТРИНА: КАТЕГОРИЙНЫЕ ФИЛЬТРЫ И ПОИСК
       ====================================================== */
    let CATEGORY_FIELDS = {};   // описание форм приходит с сервера (GET /api/config)

    function renderCategoryFilters() {
      const fields = CATEGORY_FIELDS[state.category] || CATEGORY_FIELDS.phones;
      $("#category-filter-form").innerHTML = fields.map(field => {
        if (field.type === "toggle") return `<div class="toggle-row"><span>${escapeHTML(field.label)}</span><button type="button" class="toggle" data-category-toggle="${field.id}" role="switch" aria-checked="false" aria-label="${escapeHTML(field.label)}"></button></div>`;
        let control;
        if (field.type === "select") control = `<select id="category-${field.id}" class="sort-select" style="width:100%;max-width:none;min-height:46px;margin-top:7px">${field.options.map(o => `<option value="${escapeHTML(o[0])}">${escapeHTML(o[1])}</option>`).join("")}</select>`;
        else control = `<input id="category-${field.id}" type="${field.type}" min="0" placeholder="${escapeHTML(field.placeholder || "")}" style="width:100%;min-height:46px;border-radius:12px;border:1px solid var(--border);background:var(--surface);padding:0 13px;color:var(--text);font-size:12px;margin-top:7px">`;
        return `<label style="display:block;font-size:11px;font-weight:750;color:var(--text-secondary);margin:0 0 13px">${escapeHTML(field.label)}${control}</label>`;
      }).join("");
    }

    $("#category-chips").addEventListener("click", event => {
      const chip = event.target.closest("[data-category]");
      if (!chip) return;
      state.category = chip.dataset.category;
      $$("#category-chips .chip").forEach(item => item.classList.toggle("active", item === chip));
      renderCategoryFilters();
      haptic("light");
    });

    $("#category-filter-form").addEventListener("click", event => {
      const toggle = event.target.closest("[data-category-toggle]");
      if (!toggle) return;
      const on = toggle.getAttribute("aria-checked") !== "true";
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-checked", String(on));
      haptic("light");
    });

    function collectCategoryFilters() {
      const result = {};
      (CATEGORY_FIELDS[state.category] || []).forEach(field => {
        if (field.type === "toggle") result[field.id] = $( `[data-category-toggle="${field.id}"]`)?.getAttribute("aria-checked") === "true";
        else result[field.id] = $(`#category-${field.id}`)?.value?.trim() || "";
      });
      return result;
    }

    async function searchCategory() {
      haptic("medium");
      if (!TELEGRAM_ID) { toast("Открой через бота"); return; }

      const btn = $("#category-search-btn");
      btn.disabled = true;
      btn.textContent = "Ищем выгодные предложения…";

      // отправляем только категорию и значения формы — запрос к Avito собирает и проверяет сервер
      const result = await safeApi("POST", "/api/showcase/search",
        { category: state.category, filters: collectCategoryFilters() }, "Не удалось выполнить поиск");

      btn.disabled = false;
      btn.textContent = "🔍 Найти выгодные";
      if (!result) return;

      const items = Array.isArray(result.items) ? result.items : [];
      state.categoryResults = items;
      $("#category-results-grid").innerHTML = items.map((item, index) => showcaseCardHTML(item, index, false)).join("");
      $("#category-results-count").textContent = `${items.length} ${pluralize(items.length, "предложение", "предложения", "предложений")}`;
      $("#category-results-empty").classList.toggle("hidden", items.length > 0);
      toast(items.length ? `✅ Найдено: ${items.length}` : "Ничего не найдено");
    }
    $("#category-search-btn").addEventListener("click", searchCategory);

    // Уведомления обновляются каждые 60 секунд, только когда открыта соответствующая вкладка.
    setInterval(() => {
      if (state.page === "notifications" && document.visibilityState !== "hidden") loadShowcase();
    }, 60000);

    $("#notifications-time-chips").addEventListener("click", event => {
      const chip = event.target.closest("[data-time-filter]");
      if (!chip) return;
      state.notificationTimeFilter = chip.dataset.timeFilter;
      $$("#notifications-time-chips .chip").forEach(item => item.classList.toggle("active", item === chip));
      loadShowcase();
    });
    $("#notifications-favorites-btn").addEventListener("click", () => showPage("favorites"));

    /* ======================================================
       ИСТОРИЯ
       ====================================================== */

    function historyCardHTML(search) {
      const info = searchStatusInfo(search);
      const createdDate = search.created_at
        ? new Date(search.created_at).toLocaleDateString("ru-RU")
        : "—";

      return `
        <div class="search-card">
          <span class="search-card-status ${info.cls}">${info.label}</span>
          <h3 class="search-card-title">${escapeHTML(search.title || "Без названия")}</h3>
          <div class="search-card-meta">
            <span>🗓 ${createdDate}</span>
            <span>📦 Найдено: ${search.found_count ?? 0}</span>
          </div>
          ${search.best_item ? `<div class="search-card-meta"><span>🏆 Самое выгодное: <b>${formatPrice(search.best_item.price)}</b> (−${search.best_item.discount_percent}%)${search.best_item.city ? " · " + escapeHTML(search.best_item.city) : ""}</span></div>` : ""}
          <div class="search-card-actions">
            <button class="accent" data-action="open-showcase" data-search-id="${search.id}" type="button">
              📂 Открыть товары
            </button>
            <button data-action="repeat" data-search-id="${search.id}" type="button">
              🔁 Повторить поиск
            </button>
          </div>
        </div>
      `;
    }

    async function loadHistory() {
      if (!TELEGRAM_ID) {
        $("#history-skeleton").classList.add("hidden");
        $("#history-empty").classList.remove("hidden");
        return;
      }

      $("#history-skeleton").classList.remove("hidden");
      $("#history-list").innerHTML = "";
      $("#history-empty").classList.add("hidden");

      const data = await safeApi(
        "GET",
        `/api/search/list?telegram_id=${TELEGRAM_ID}&history=1`,
        undefined,
        "Не удалось загрузить историю"
      );

      $("#history-skeleton").classList.add("hidden");

      const searches = (data && data.searches) || [];
      state.historySearches = searches;

      if (!searches.length) {
        $("#history-empty").classList.remove("hidden");
        return;
      }

      $("#history-list").innerHTML = searches.map(historyCardHTML).join("");
    }

    /* ======================================================
       ДЕЛЕГИРОВАНИЕ КЛИКОВ: КАРТОЧКИ И ДЕЙСТВИЯ
       ====================================================== */

    document.addEventListener("click", event => {
      const openPlansBtn = event.target.closest("[data-open-plans]");
      if (openPlansBtn) {
        openSheet("plans-sheet");
        return;
      }

      const favItemBtn = event.target.closest("[data-favorite-item]");
      if (favItemBtn) {
        toggleFavoriteItem(Number(favItemBtn.dataset.favoriteItem));
        return;
      }

      const openUrlBtn = event.target.closest("[data-open-url]");
      if (openUrlBtn) {
        openExternal(openUrlBtn.dataset.openUrl);
        return;
      }

      const cardUrl = event.target.closest("[data-card-url]");
      if (cardUrl && cardUrl.dataset.cardUrl) {
        openExternal(cardUrl.dataset.cardUrl);
        return;
      }

      const actionBtn = event.target.closest("[data-action]");
      if (actionBtn) {
        const id = Number(actionBtn.dataset.searchId);
        const action = actionBtn.dataset.action;

        if (action === "items") { openSearchItems(id); return; }
        if (action === "toggle") { toggleSearchPause(id, actionBtn.dataset.active === "true"); return; }
        if (action === "delete") { deleteSearch(id); return; }
        if (action === "repeat") { repeatSearch(id); return; }
        if (action === "open-showcase") { openShowcaseForSearch(id); return; }
      }
    });

    /* ======================================================
       СОЦСЕТИ
       ====================================================== */

    $$("[data-social-url]").forEach(button => {
      button.addEventListener("click", () => {
        openExternal(button.dataset.socialUrl);
      });
    });

    $("#social-support-btn").addEventListener("click", openSupport);
    $("#profile-support-btn").addEventListener("click", openSupport);

    /* ======================================================
       BOT HELPER
       ====================================================== */

    function clearBubbleTimers() {
      bubbleTimers.forEach(timer => clearTimeout(timer));
      bubbleTimers = [];
    }

    function hideBubble() {
      $("#bot-bubble").classList.remove("visible");
    }

    function scheduleBubbleCycle() {
      clearBubbleTimers();
      hideBubble();

      const first = setTimeout(() => {
        if (state.searchStatus !== "searching" || state.page !== "search") return;

        $("#bot-bubble").classList.add("visible");

        const hide = setTimeout(() => hideBubble(), 5000);
        bubbleTimers.push(hide);

        const repeat = setTimeout(() => scheduleBubbleCycle(), 20000);
        bubbleTimers.push(repeat);
      }, 1500);

      bubbleTimers.push(first);
    }

    function updateBotVisibility() {
      const helper = $("#bot-helper");
      const shouldShow = state.page === "search" && state.searchStatus === "searching";

      helper.classList.toggle("hidden", !shouldShow);

      if (shouldShow) {
        scheduleBubbleCycle();
      } else {
        clearBubbleTimers();
        hideBubble();
      }
    }

    $("#bot-avatar").addEventListener("click", () => {
      haptic("light");
      openSheet("help-sheet");
    });

    $("#bot-bubble").addEventListener("click", () => {
      haptic("light");
      openSheet("help-sheet");
    });

    /* ======================================================
       BOTTOM SHEET: УНИВЕРСАЛЬНОЕ УПРАВЛЕНИЕ
       ====================================================== */

    const overlay = $("#overlay");

    function openSheet(id) {
      haptic("light");
      closeSheet(false);

      currentSheet = $("#" + id);
      overlay.classList.add("open");
      currentSheet.classList.add("open");
      document.body.style.overflow = "hidden";
      currentSheet.setAttribute("aria-hidden", "false");
    }

    function closeSheet(withHaptic = true) {
      if (withHaptic) haptic("light");

      overlay.classList.remove("open");

      $$(".bottom-sheet").forEach(sheet => {
        sheet.classList.remove("open");
        sheet.setAttribute("aria-hidden", "true");
      });

      document.body.style.overflow = "";
      currentSheet = null;
    }

    overlay.addEventListener("click", () => closeSheet());

    $$("[data-close-sheet]").forEach(button => {
      button.addEventListener("click", () => closeSheet());
    });

    $$(".bottom-sheet").forEach(sheet => {
      sheet.addEventListener("touchstart", event => {
        touchStartY = event.touches[0].clientY;
      }, { passive: true });

      sheet.addEventListener("touchend", event => {
        const touchEndY = event.changedTouches[0].clientY;
        const delta = touchEndY - touchStartY;

        if (delta > 100 && sheet.scrollTop <= 0) {
          closeSheet();
        }
      }, { passive: true });
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && currentSheet) {
        closeSheet();
      }
    });

    /* ======================================================
       ПОМОЩЬ / FAQ
       ====================================================== */

    $("#help-support-btn").addEventListener("click", openSupport);

    $("#help-faq-btn").addEventListener("click", () => {
      closeSheet();
      showPage("faq");
    });

    $("#faq-back-btn").addEventListener("click", () => {
      showPage(state.previousPage || "search");
    });

    $$(".faq-question").forEach(button => {
      button.addEventListener("click", () => {
        haptic("light");

        const answer = button.nextElementSibling;
        const isOpen = !answer.classList.contains("hidden");

        answer.classList.toggle("hidden", isOpen);
        button.setAttribute("aria-expanded", String(!isOpen));

        const indicator = button.querySelector("span:last-child");
        indicator.textContent = isOpen ? "+" : "−";
      });
    });

    /* ======================================================
       ПОДПИСКА И ТАРИФЫ
       ====================================================== */

    $("#open-plans-btn").addEventListener("click", () => {
      openSheet("plans-sheet");
    });

    function updateDurationPrices() {
      const plan = PLANS[state.selectedPlan];

      $$("[data-duration]").forEach(btn => {
        const d = Number(btn.dataset.duration);
        const priceEl = btn.querySelector(".duration-price");
        if (priceEl && plan.prices[d] !== undefined) {
          priceEl.textContent = formatPrice(plan.prices[d]);
        }
      });
    }

    function currentAmount() {
      const plan = PLANS[state.selectedPlan];
      let amount = plan.prices[state.selectedDuration] ?? 0;

      if (state.promoDiscount) {
        amount = Math.round(amount * (1 - state.promoDiscount));
      }

      return amount;
    }

    function updatePayButton() {
      $("#pay-btn").textContent = `⭐ Оплатить через ЮKassa — ${formatPrice(currentAmount())}`;
    }

    function selectPlan(plan) {
      if (!PLANS[plan] || !PLANS[plan].prices) return;

      haptic("light");
      state.selectedPlan = plan;

      $$("[data-plan]").forEach(button => {
        const selected = button.dataset.plan === plan;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });

      updateDurationPrices();
      updatePayButton();
    }

    function selectDuration(duration) {
      haptic("light");
      state.selectedDuration = duration;

      $$("[data-duration]").forEach(button => {
        button.classList.toggle("selected", Number(button.dataset.duration) === duration);
      });

      updatePayButton();
    }

    $("#plan-list").addEventListener("click", event => {
      const button = event.target.closest("[data-plan]");
      if (button) selectPlan(button.dataset.plan);
    });

    $$("[data-duration]").forEach(button => {
      button.addEventListener("click", () => selectDuration(Number(button.dataset.duration)));
    });

    $("#promo-apply-btn").addEventListener("click", async () => {
      haptic("light");
      const code = $("#promo-input").value.trim().toUpperCase();

      if (!code) {
        toast("Введи промокод");
        return;
      }

      const res = await safeApi("POST", "/api/promo/check", { code }, null);

      if (res && res.discount_percent) {
        state.promoDiscount = res.discount_percent / 100;
        state.promoCode = code;
        toast(`✅ Промокод применён: −${res.discount_percent}%`);
      } else {
        state.promoDiscount = 0;
        state.promoCode = "";
        toast("❌ Промокод не найден");
      }

      updatePayButton();
    });

    $("#pay-btn").addEventListener("click", async () => {
      haptic("medium");

      if (!TELEGRAM_ID) {
        toast("Открой через бота");
        return;
      }

      const btn = $("#pay-btn");
      btn.disabled = true;
      btn.textContent = "Создаём платёж…";

      const res = await safeApi("POST", "/api/payment/create", {
        telegram_id: TELEGRAM_ID,
        plan: state.selectedPlan,
        duration: state.selectedDuration,
        promo: state.promoDiscount ? state.promoCode : ""
      }, "Не удалось создать платёж");

      btn.disabled = false;
      updatePayButton();

      if (res && res.confirmation_url) {
        closeSheet();
        openExternal(res.confirmation_url);
        watchPayment();
      }
    });

    // После оплаты в ЮKassa опрашиваем сервер: как только подписка появилась — включаем её сразу
    let paymentTimer = null;

    function watchPayment() {
      clearInterval(paymentTimer);
      const before = `${state.subscription.plan}|${state.subscription.plan_expires_at}`;
      let tries = 0;

      paymentTimer = setInterval(async () => {
        tries += 1;
        await loadProfile();
        const now = `${state.subscription.plan}|${state.subscription.plan_expires_at}`;

        if (now !== before && state.subscription.is_paid) {
          clearInterval(paymentTimer);
          toast("✅ Оплата прошла — подписка активна");
          haptic("success");
          loadActiveSearches();
        } else if (tries >= 120) {
          clearInterval(paymentTimer);
        }
      }, 5000);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && TELEGRAM_ID) loadProfile();
    });

    /* ======================================================
       ПОИСК ПО ФОТО
       ====================================================== */

    $("#hero-photo-btn").addEventListener("click", () => {
      haptic("light");
      openSheet("photo-sheet");

      if (currentLimits().photo) {
        $("#photo-locked").classList.add("hidden");
        $("#photo-unlocked").classList.remove("hidden");
      } else {
        $("#photo-locked").classList.remove("hidden");
        $("#photo-unlocked").classList.add("hidden");
      }
    });

    $("#photo-upgrade-btn").addEventListener("click", () => {
      closeSheet();
      setTimeout(() => {
        openSheet("plans-sheet");
        selectPlan("standart");
      }, 300);
    });

    $("#photo-input").addEventListener("change", event => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;

      const reader = new FileReader();

      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 1280 / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * k);
          canvas.height = Math.round(img.height * k);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          state.photoBase64 = canvas.toDataURL("image/jpeg", 0.85);
          const preview = $("#photo-preview");
          preview.src = state.photoBase64;
          preview.style.display = "block";
        };
        img.src = reader.result;
      };

      reader.readAsDataURL(file);
    });

    $("#photo-search-btn").addEventListener("click", async () => {
      haptic("medium");

      if (!TELEGRAM_ID) {
        toast("Открой через бота");
        return;
      }

      if (!state.photoBase64) {
        toast("Сначала выбери фото");
        return;
      }

      $("#photo-skeleton").classList.remove("hidden");
      $("#photo-results").innerHTML = "";

      try {
        const res = await api("POST", "/api/search/photo", {
          telegram_id: TELEGRAM_ID,
          image_base64: state.photoBase64
        });

        $("#photo-skeleton").classList.add("hidden");

        const items = (res && res.items) || [];

        if (!items.length) {
          $("#photo-results").innerHTML = `
            <div class="empty-state">
              <div class="empty-icon">📷</div>
              <strong>Ничего не найдено</strong>
              Попробуй другое фото.
            </div>
          `;
          return;
        }

        const avgPrice = Math.round(
          items.reduce((sum, it) => sum + (Number(it.price) || 0), 0) / items.length
        );

        $("#photo-results").innerHTML = items
          .map((it, i) => showcaseCardHTML({ ...it, avgPrice }, i, false))
          .join("");
      } catch (error) {
        $("#photo-skeleton").classList.add("hidden");
        toast("Функция в разработке");
      }
    });

    /* ======================================================
       ПРОФИЛЬ
       ====================================================== */

    function initializeProfileBasic() {
      if (!tg || !tg.initDataUnsafe || !tg.initDataUnsafe.user) {
        $("#profile-name").textContent = "Пользователь RIV";
        $("#profile-avatar").textContent = "R";
        return;
      }

      const user = tg.initDataUnsafe.user;
      const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "Пользователь RIV";

      $("#profile-name").textContent = displayName;
      $("#profile-avatar").textContent = getInitials(displayName);
    }

    const PLAN_NAMES = new Proxy({}, { get: (_, id) => PLANS[id] && PLANS[id].name });

    async function loadProfile() {
      initializeProfileBasic();

      if (!TELEGRAM_ID) {
        $("#profile-status-text").textContent = "Открой через бота";
        return;
      }

      $("#profile-status-text").textContent = "Загрузка…";

      const data = await safeApi(
        "GET",
        `/api/subscription/status?telegram_id=${TELEGRAM_ID}`,
        undefined,
        "Не удалось загрузить подписку"
      );

      const sub = data || { plan: "free", is_paid: false, plan_expires_at: null };
      state.subscription = sub;

      const planLabel = PLAN_NAMES[sub.plan] || "Free";

      $("#profile-plan-name").textContent = `Тариф: ${planLabel}`;
      $("#profile-status-text").textContent = sub.is_paid ? `${planLabel} активен` : "Бесплатный доступ";

      if (sub.plan_expires_at) {
        const date = new Date(sub.plan_expires_at).toLocaleDateString("ru-RU");
        $("#profile-plan-expiry").textContent = `Действует до ${date}`;
      } else {
        $("#profile-plan-expiry").textContent = "Подписка не активна";
      }

      $("#search-total").textContent = String(state.searches.length);
      $("#profile-plan-limits").textContent = `Лимиты: ${limitsLabel(sub.plan)}`;
      updateLimitsStrip();

      if (state.page === "notifications") renderShowcase();
    }

    const profileFavoritesButton = $("#profile-favorites-btn");
    if (profileFavoritesButton) profileFavoritesButton.addEventListener("click", () => showPage("favorites"));

    $("#referral-link").textContent = REFERRAL_URL;

    $("#referral-copy-btn").addEventListener("click", async () => {
      haptic("light");

      try {
        await navigator.clipboard.writeText(REFERRAL_URL);
        toast("Ссылка скопирована");
      } catch (error) {
        toast("Не удалось скопировать ссылку");
      }
    });

    $("#referral-share-btn").addEventListener("click", () => {
      haptic("light");

      const shareUrl =
        `https://t.me/share/url?url=${encodeURIComponent(REFERRAL_URL)}` +
        `&text=${encodeURIComponent("Нашёл крутой сервис для поиска выгодных товаров на Avito!")}`;

      openExternal(shareUrl);
    });

    /* ======================================================
       ПЕРВИЧНЫЙ ЗАПУСК
       ====================================================== */

    function initializeApp() {
      TELEGRAM_ID = getTelegramId();

      if (!TELEGRAM_ID) {
        toast("Открой через бота");
      }

      initializeProfileBasic();
      renderNavigation();
      updateBotVisibility();

      selectPlan("premium_plus");
      selectDuration(30);

      $$(".bottom-sheet").forEach(sheet => {
        sheet.setAttribute("aria-hidden", "true");
      });

      showPage("search", { keepScroll: true });

      // Подписка нужна и в профиле, и для блокировок витрины/фото-поиска —
      // подгружаем её заранее.
      loadProfile();
      loadFavorites();
      loadShowcase();
    }

    function planDetail(p) {
      const n = p.searches === null
        ? "Безлимит поисков"
        : `${p.searches} ${pluralize(p.searches, "поиск", "поиска", "поисков")}${p.searches > 1 ? " сразу" : ""}`;
      const parts = [n, `${p.hours} ${pluralize(p.hours, "час", "часа", "часов")}`];
      if (p.favorites) parts.push("✅ Избранное");
      if (p.photo) parts.push("📷 Поиск по фото");
      return parts.join(" · ");
    }

    function renderPlanList() {
      const ids = Object.keys(PLANS).filter(id => PLANS[id].prices);
      $("#plan-list").innerHTML = ids.map(id => `
        <button class="plan-option" data-plan="${escapeHTML(id)}" aria-pressed="false" type="button">
          <span class="plan-radio"></span>
          <span class="plan-info">
            <span class="plan-name">${escapeHTML(PLANS[id].name)}</span>
            <span class="plan-detail">${escapeHTML(planDetail(PLANS[id]))}</span>
          </span>
          <span class="plan-price">${formatPrice(PLANS[id].prices[30])}</span>
        </button>`).join("");

      const f = PLANS.free;
      $("#plans-description").textContent = f
        ? `Free: ${planDetail({ ...f, favorites: false, photo: false })}. Выбери тариф и срок — оплата через ЮKassa, доступ откроется автоматически.`
        : "Выбери тариф и срок — оплата через ЮKassa, доступ откроется автоматически.";
    }

    async function loadConfig() {
      try {
        const cfgData = await api("GET", "/api/config");
        Object.assign(PLANS, cfgData.plans);
        CATEGORY_FIELDS = cfgData.categories;
        renderPlanList();
        renderCategoryFilters();
        return true;
      } catch (error) {
        toast("Сервер недоступен, попробуй позже");
        return false;
      }
    }

    loadConfig().then(initializeApp);
