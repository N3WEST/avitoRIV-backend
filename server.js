import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, PLANS, PROMO, priceFor, publicPlans } from './src/config.js';
import { db, nowISO, upsertUser, getUser, effectivePlan } from './src/db.js';
import * as avito from './src/avito.js';
import * as yk from './src/yookassa.js';
import { describeImage } from './src/ai.js';
import { verifyInitData, startBot, sendMessage } from './src/telegram.js';
import { checkPayment } from './src/payments.js';
import { startWorker } from './src/worker.js';
import { CATEGORIES, buildCategoryQuery } from './src/catalog.js';
import { cleanText, cleanRegion, cleanPrice } from './src/util.js';
import { slots, leftText, searchDTO, itemDTO, addFavorite, saveOneOff, rankCheapest, fail, scanSearch, listNotifications } from './src/core.js';

const app = express();
const here = path.dirname(fileURLToPath(import.meta.url));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

if (cfg.trustProxy) app.set('trust proxy', 1);       // один прокси впереди (nginx)

/* ---------- заголовки безопасности ---------- */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'", 'https://telegram.org'],     // только наш app.js и SDK Telegram — никакого inline-JS
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.telegram.org'],  // Telegram Web открывает мини-приложение в iframe
      upgradeInsecureRequests: cfg.prod ? [] : null
    }
  },
  frameguard: false,                                     // вместо X-Frame-Options работает frame-ancestors
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use((req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); next(); });

/* ---------- разбор тела: маленький лимит по умолчанию, большой — только для фото ---------- */
app.use('/api/search/photo', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '100kb' }));

app.use(express.static(path.join(here, 'public'), {
  index: 'index.html',
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); }
}));

/* ---------- лимиты запросов ---------- */
const ipLimit = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false, message: { error: 'Слишком много запросов, подожди минуту' } });
const userLimit = (limit, windowMs = 60_000) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `u${req.tid}`, message: { error: 'Слишком часто. Попробуй чуть позже' }
});
app.use('/api', ipLimit);

/* ---------- авторизация: telegram_id берём ТОЛЬКО из подписанного initData ---------- */
function auth(req, res, next) {
  const init = req.get('x-telegram-init-data');
  let tid = null, user = null;
  if (init) {
    user = verifyInitData(init);
    if (!user) return res.status(401).json({ error: 'Подпись Telegram недействительна. Открой приложение заново.' });
    tid = String(user.id);
  }
  const claimed = String(req.query.telegram_id ?? req.body?.telegram_id ?? '');
  if (tid) {
    if (claimed && claimed !== tid) return res.status(403).json({ error: 'telegram_id не совпадает с подписью' });
  } else {
    if (cfg.requireAuth) return res.status(401).json({ error: 'Открой приложение через Telegram' });
    tid = claimed;                                      // только для локальной разработки (NODE_ENV != production)
  }
  if (!/^\d{1,15}$/.test(tid)) return res.status(400).json({ error: 'Нужна авторизация Telegram' });
  req.tid = tid;
  upsertUser(tid, user?.username ? cleanText(user.username, 64) : null);
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ---------- публичная конфигурация: тарифы, цены, формы витрины (единый источник истины) ---------- */
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ plans: publicPlans(), durations: [1, 7, 30, 60], categories: CATEGORIES });
});

/* ---------- профиль / подписка ---------- */
app.get('/api/subscription/status', auth, (req, res) => {
  const u = getUser(req.tid), plan = effectivePlan(u), l = PLANS[plan], s = slots(req.tid);
  res.json({
    plan, plan_name: l.name, is_paid: plan !== 'free', plan_expires_at: plan !== 'free' ? u.plan_expires_at : null,
    limits: { searches: Number.isFinite(l.searches) ? l.searches : null, hours: l.hours, photo: l.photo, favorites: l.favorites },
    slots: { used: s.used, limit: Number.isFinite(s.limit) ? s.limit : null, next_free_at: s.next_free_at }
  });
});

/* ---------- промокод и оплата ---------- */
app.post('/api/promo/check', auth, userLimit(10), (req, res) => {
  const d = PROMO[cleanText(req.body.code, 32).toUpperCase()];
  if (!d) throw fail(404, 'Промокод не найден');
  res.json({ discount_percent: Math.round(d * 100) });
});

app.post('/api/payment/create', auth, userLimit(10, 600_000), wrap(async (req, res) => {
  const plan = String(req.body.plan), duration = Number(req.body.duration);
  const amount = priceFor(plan, duration, req.body.promo);     // цена считается только здесь
  if (!amount) throw fail(400, 'Неверный тариф или срок');

  const pending = db.prepare("SELECT COUNT(*) c FROM payments WHERE telegram_id=? AND status='pending' AND created_at>?")
    .get(req.tid, new Date(Date.now() - 3600000).toISOString()).c;
  if (pending >= 5) throw fail(429, 'Слишком много неоплаченных счетов. Оплати один из них или подожди час');

  const pay = await yk.createPayment({
    amount, description: `RIV · ${PLANS[plan].name} · ${duration} дн.`,
    metadata: { telegram_id: req.tid, plan, duration: String(duration) }
  });
  db.prepare('INSERT INTO payments(id,telegram_id,plan,duration,amount,created_at) VALUES(?,?,?,?,?,?)')
    .run(pay.id, req.tid, plan, duration, amount, nowISO());
  res.json({ payment_id: pay.id, amount, confirmation_url: pay.confirmation_url });
}));

/* Вебхук ЮKassa. Три слоя защиты: 1) только IP ЮKassa, 2) id должен быть в нашей БД,
   3) статус и сумму мы перепроверяем запросом к API ЮKassa — тело вебхука не доверенное. */
const YK_NETS = [['185.71.76.0', 27], ['185.71.77.0', 27], ['77.75.153.0', 25], ['77.75.154.128', 25], ['77.75.156.11', 32], ['77.75.156.35', 32]];
const ip4 = s => s.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
function isYooKassaIp(raw) {
  const ip = String(raw || '').replace(/^::ffff:/, '');
  if (ip.toLowerCase().startsWith('2a02:5180:')) return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  return YK_NETS.some(([net, bits]) => (ip4(ip) & (~0 << (32 - bits)) >>> 0) === (ip4(net) & (~0 << (32 - bits)) >>> 0));
}

app.post('/api/payment/webhook', wrap(async (req, res) => {
  if (cfg.prod && yk.enabled && cfg.ykIpCheck && !isYooKassaIp(req.ip)) {
    console.warn('[webhook] отклонён IP', req.ip);
    return res.sendStatus(403);
  }
  const id = String(req.body?.object?.id || '');
  res.sendStatus(200);
  if (!id || !db.prepare('SELECT 1 FROM payments WHERE id=?').get(id)) return;
  try { await checkPayment(id); } catch (e) { console.warn('webhook', e.message); }
}));

if (!yk.enabled && !cfg.prod) {                           // тестовая «оплата» без ключей — только вне production
  app.get('/dev/pay/:id', wrap(async (req, res) => {
    yk.mockPay(req.params.id);
    await checkPayment(req.params.id);
    res.type('html').send('<meta charset=utf-8><h2>✅ Тестовая оплата прошла</h2>Вернись в Telegram.');
  }));
}

/* ---------- поиски ---------- */
app.post('/api/search/create', auth, userLimit(10), wrap(async (req, res) => {
  const info = avito.parseAvitoUrl(req.body.url);
  if (!info) throw fail(400, 'Нужна ссылка на объявление или поиск на avito.ru');

  const sl = slots(req.tid);
  if (Number.isFinite(sl.limit) && sl.used >= sl.limit) {
    throw fail(403, `Лимит тарифа «${PLANS[sl.plan].name}»: ${sl.limit} ${sl.limit === 1 ? 'поиск' : 'поиска'} одновременно. ` +
      `Новый можно запустить через ${leftText(sl.next_free_at)} или повысить тариф.`);
  }

  const maxP = cleanPrice(req.body.max_price) || info.pmax;
  let title, query, ref = maxP || null, sourceId = null;

  if (info.isAd) {
    const ad = await avito.fetchAd(info.canonical);
    query = avito.queryFromTitle(ad.title);
    title = query || cleanText(ad.title, 120);
    ref = maxP || ad.price || null;                      // «дешевле» считаем от цены товара (или от лимита цены)
    sourceId = info.adId;
  } else {
    query = cleanText(info.query, 120);
    title = query;
  }
  if (!query) throw fail(422, 'Не удалось понять, что искать');

  const expires = new Date(Date.now() + PLANS[sl.plan].hours * 3600000).toISOString();
  const r = db.prepare(`INSERT INTO searches(telegram_id,title,url,query,region,max_price,ref_price,source_avito_id,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(req.tid, title, info.canonical, query, cleanRegion(req.body.region) || info.region, maxP, ref, sourceId, nowISO(), expires);
  const s = db.prepare('SELECT * FROM searches WHERE id=?').get(Number(r.lastInsertRowid));

  scanSearch(s).catch(e => console.warn('first scan', e.message));   // первая проверка сразу, не ждём цикла
  res.json({ search: searchDTO(s) });
}));

app.get('/api/search/list', auth, (req, res) => {
  const rows = req.query.history === '1'
    ? db.prepare('SELECT * FROM searches WHERE telegram_id=? ORDER BY id DESC LIMIT 5').all(req.tid)
    : db.prepare('SELECT * FROM searches WHERE telegram_id=? AND deleted=0 ORDER BY id DESC LIMIT 50').all(req.tid);
  const s = slots(req.tid);
  res.json({
    searches: rows.map(searchDTO),
    slots: { used: s.used, limit: Number.isFinite(s.limit) ? s.limit : null, next_free_at: s.next_free_at, plan: s.plan, hours: PLANS[s.plan].hours }
  });
});

const own = req => db.prepare('SELECT * FROM searches WHERE id=? AND telegram_id=?').get(Number(req.params.id) || 0, req.tid);

app.post('/api/search/:id/pause', auth, wrap(async (req, res) => {
  const s = own(req); if (!s) throw fail(404, 'Поиск не найден');
  db.prepare('UPDATE searches SET is_active=0 WHERE id=?').run(s.id);
  res.json({ ok: true });
}));

app.post('/api/search/:id/resume', auth, wrap(async (req, res) => {
  const s = own(req);
  if (!s || s.deleted) throw fail(404, 'Поиск не найден');
  if (s.expires_at <= nowISO()) throw fail(409, 'Время этого поиска истекло — запусти новый');
  db.prepare('UPDATE searches SET is_active=1 WHERE id=?').run(s.id);
  res.json({ ok: true });
}));

app.delete('/api/search/:id', auth, wrap(async (req, res) => {
  const s = own(req); if (!s) throw fail(404, 'Поиск не найден');
  db.prepare('UPDATE searches SET deleted=1, is_active=0 WHERE id=?').run(s.id);
  res.json({ ok: true });
}));

app.get('/api/search/:id/items', auth, wrap(async (req, res) => {
  const s = own(req); if (!s) throw fail(404, 'Поиск не найден');
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const rows = db.prepare('SELECT * FROM items WHERE search_id=? ORDER BY found_at DESC, id DESC LIMIT ?').all(s.id, limit);
  res.json({ items: rows.map(i => itemDTO(i)) });
}));

/* ---------- вкладка «Уведомления» ---------- */
app.get('/api/notifications', auth, (req, res) => {
  const hours = [6, 12, 24, 48].includes(Number(req.query.hours)) ? Number(req.query.hours) : 0;
  const sort = ['new', 'discount', 'cheap'].includes(req.query.sort) ? req.query.sort : 'new';
  const searchId = Number(req.query.search_id) > 0 ? Number(req.query.search_id) : 0;
  res.json(listNotifications(req.tid, { hours, searchId, sort, local: req.query.local === '1' }));
});

/* ---------- избранное ---------- */
app.get('/api/favorites/list', auth, (req, res) => {
  res.json({ items: db.prepare('SELECT * FROM favorites WHERE telegram_id=? ORDER BY added_at DESC LIMIT 500').all(req.tid) });
});

app.post('/api/favorites/add', auth, userLimit(60), wrap(async (req, res) => {
  const r = addFavorite(req.tid, Number(req.body.item_id));
  if (r.error) throw fail(r.error.includes('Премиум') ? 403 : 404, r.error);
  res.json({ ok: true });
}));

app.post('/api/favorites/remove', auth, userLimit(60), (req, res) => {
  db.prepare('DELETE FROM favorites WHERE telegram_id=? AND item_id=?').run(req.tid, Number(req.body.item_id) || 0);
  res.json({ ok: true });
});

/* ---------- витрина и поиск по фото (разовая выдача, слот не занимают) ---------- */
const lastCall = new Map();
setInterval(() => { const t = Date.now() - 60_000; for (const [k, v] of lastCall) if (v < t) lastCall.delete(k); }, 60_000).unref();
function throttle(tid, ms = 8000) {
  if (Date.now() - (lastCall.get(tid) || 0) < ms) throw fail(429, 'Подожди несколько секунд перед следующим поиском');
  lastCall.set(tid, Date.now());
}

async function oneOffSearch(tid, query, region, maxPrice) {
  const list = await avito.searchAvito({ query, region, maxPrice, sort: 'cheap' });
  const { items, median: med } = rankCheapest(list);
  return { items: saveOneOff(tid, items).map(i => itemDTO(i, { avgPrice: med })), avgPrice: med };
}

// клиент присылает только {category, filters}; запрос собирает и проверяет сервер (catalog.js)
app.post('/api/showcase/search', auth, wrap(async (req, res) => {
  throttle(req.tid);
  const q = buildCategoryQuery(String(req.body.category), req.body.filters);
  res.json({ query: q.query, ...(await oneOffSearch(req.tid, q.query, q.region, q.maxPrice)) });
}));

app.post('/api/search/photo', auth, wrap(async (req, res) => {
  if (!PLANS[effectivePlan(getUser(req.tid))].photo) throw fail(403, 'Поиск по фото доступен на платных тарифах');
  throttle(req.tid, 10000);
  if (typeof req.body.image_base64 !== 'string') throw fail(400, 'Нет фото');
  const query = cleanText(await describeImage(req.body.image_base64), 80);
  res.json({ query, ...(await oneOffSearch(req.tid, query, '', null)) });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Неверный формат запроса' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Внутренняя ошибка сервера' });
});

/* ---------- запуск ---------- */
if (cfg.prod && cfg.botToken === '') console.warn('⚠️  BOT_TOKEN не задан — авторизация Telegram не будет работать');
app.listen(cfg.port, cfg.host, () => console.log(`RIV backend: http://${cfg.host}:${cfg.port}  (avito=${cfg.avitoMode}, pay=${yk.enabled ? 'yookassa' : 'mock'}, auth=${cfg.requireAuth})`));

startBot({
  onStart: async m => {
    upsertUser(String(m.from.id), m.from.username);
    const kb = cfg.webappUrl ? { reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть RIV', web_app: { url: cfg.webappUrl } }]] } } : {};
    await sendMessage(m.chat.id, '👋 <b>RIV</b> — находит такие же товары на Avito, но дешевле.\nОткрой приложение, вставь ссылку на товар — новые находки придут сюда.', kb);
  },
  onFavorite: async (tid, itemId) => addFavorite(tid, itemId)
});
startWorker();
