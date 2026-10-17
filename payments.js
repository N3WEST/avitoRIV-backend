const e = process.env;

export const cfg = {
  port: +e.PORT || 3000,
  host: e.HOST || '127.0.0.1',            // слушаем только localhost — наружу смотрит nginx
  trustProxy: e.TRUST_PROXY !== '0',
  ykIpCheck: e.YOOKASSA_IP_CHECK !== '0',
  botToken: e.BOT_TOKEN || '',
  botUsername: e.BOT_USERNAME || '',
  webappUrl: e.WEBAPP_URL || '',
  publicUrl: e.PUBLIC_URL || `http://localhost:${e.PORT || 3000}`,
  dbPath: e.DB_PATH || './data/riv.db',
  avitoMode: e.AVITO_MODE || 'live',
  proxyUrl: e.PROXY_URL || '',
  scanMinutes: +e.SCAN_INTERVAL_MIN || 5,
  deleteFreesSlot: e.DELETE_FREES_SLOT === '1',
  // отсеиваем «находки» дешевле 30% от эталона — это обычно чехлы/запчасти/мошенники
  minPriceRatio: e.MIN_PRICE_RATIO ? +e.MIN_PRICE_RATIO : 0.3,
  requireAuth: e.REQUIRE_INIT_DATA ? e.REQUIRE_INIT_DATA === '1' : e.NODE_ENV === 'production',
  prod: e.NODE_ENV === 'production',
  yk: {
    shop: e.YOOKASSA_SHOP_ID || '',
    key: e.YOOKASSA_SECRET_KEY || '',
    receiptEmail: e.YOOKASSA_RECEIPT_EMAIL || ''
  },
  anthropicKey: e.ANTHROPIC_API_KEY || '',
  anthropicModel: e.ANTHROPIC_MODEL || 'claude-haiku-5-5'
};

// searches — одновременных поисков, hours — сколько живёт один поиск
export const PLANS = {
  free:         { name: 'Free',         searches: 1,        hours: 6,  photo: false, favorites: false, showcaseVisible: 5 },
  standart:     { name: 'Стандарт',     searches: 1,        hours: 12, photo: true,  favorites: false, showcaseVisible: 10 },
  premium:      { name: 'Премиум',      searches: 2,        hours: 24, photo: true,  favorites: true,  showcaseVisible: 20 },
  premium_plus: { name: 'Премиум Плюс', searches: Infinity, hours: 48, photo: true,  favorites: true,  showcaseVisible: Infinity }
};

// цены в ₽ по числу дней — те же, что во фронте
export const PRICES = {
  standart:     { 1: 29,  7: 99,  30: 199, 60: 349 },
  premium:      { 1: 59,  7: 199, 30: 399, 60: 699 },
  premium_plus: { 1: 129, 7: 399, 30: 899, 60: 1599 }
};

export const PROMO = { RIV10: 0.10, RIV20: 0.20 };

export function priceFor(plan, days, promo) {
  const base = PRICES[plan]?.[days];
  if (!base) return null;
  const d = PROMO[String(promo || '').toUpperCase()] || 0;
  return Math.max(1, Math.round(base * (1 - d)));
}

const fin = n => (Number.isFinite(n) ? n : null);

// Всё, что фронт показывает про тарифы, берётся отсюда (GET /api/config)
export function publicPlans() {
  return Object.fromEntries(Object.entries(PLANS).map(([id, p]) => [id, {
    name: p.name, searches: fin(p.searches), hours: p.hours, photo: p.photo, favorites: p.favorites,
    showcase_visible: fin(p.showcaseVisible), prices: PRICES[id] || null
  }]));
}
