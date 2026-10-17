import { cfg, PLANS } from './config.js';
import { db, nowISO, getUser, effectivePlan } from './db.js';
import * as avito from './avito.js';
import { sendMessage, sendItem, esc } from './telegram.js';

export const rub = n => new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
export const median = a => {
  const s = a.filter(x => x > 0).sort((x, y) => x - y);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
export { fail } from './util.js';
import { REGIONS } from './catalog.js';

/* ---------- лимиты ---------- */
export function leftText(iso) {
  const total = Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60000));
  const h = Math.floor(total / 60), m = total % 60;
  return h ? (m ? `${h} ч ${m} мин` : `${h} ч`) : `${m} мин`;
}

// Слот занят, пока не истёк срок поиска. Пауза слот не освобождает; удаление — по флагу DELETE_FREES_SLOT.
export function slots(tid) {
  const plan = effectivePlan(getUser(tid));
  const limit = PLANS[plan].searches;
  const rows = db.prepare(`SELECT expires_at FROM searches WHERE telegram_id=? AND expires_at>? ${cfg.deleteFreesSlot ? 'AND deleted=0' : ''} ORDER BY expires_at`)
    .all(String(tid), nowISO());
  return { plan, limit, used: rows.length, next_free_at: rows[0]?.expires_at || null };
}

/* ---------- DTO ---------- */
export const itemDTO = (i, extra = {}) => ({
  id: i.id, avito_id: i.avito_id, title: i.title, price: i.price, url: i.url, image: i.image,
  city: i.city, found_at: i.found_at, discount_percent: i.discount_percent,
  is_new: Date.parse(i.found_at) > Date.now() - 3600000, ...extra
});

export function searchDTO(s) {
  const found = db.prepare('SELECT COUNT(*) c FROM items WHERE search_id=?').get(s.id).c;
  const best = db.prepare('SELECT * FROM items WHERE search_id=? ORDER BY discount_percent DESC, price ASC LIMIT 1').get(s.id);
  return {
    id: s.id, title: s.title, url: s.url, region: s.region, max_price: s.max_price, ref_price: s.ref_price,
    is_active: !!s.is_active && !s.deleted, created_at: s.created_at, expires_at: s.expires_at,
    found_count: found, best_item: best ? itemDTO(best) : null
  };
}

/* ---------- избранное ---------- */
export function addFavorite(tid, itemId) {
  const plan = effectivePlan(getUser(tid));
  if (!PLANS[plan].favorites) return { error: 'Избранное доступно с тарифа Премиум' };
  const it = db.prepare('SELECT * FROM items WHERE id=? AND telegram_id=?').get(itemId, String(tid));
  if (!it) return { error: 'Товар не найден' };
  db.prepare(`INSERT OR IGNORE INTO favorites(telegram_id,item_id,title,price,url,image,city,added_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(String(tid), it.id, it.title, it.price, it.url, it.image, it.city, nowISO());
  return { ok: true };
}

/* ---------- разовая выдача (витрина / фото) ---------- */
export function saveOneOff(tid, list) {
  const ins = db.prepare(`INSERT INTO items(search_id,telegram_id,avito_id,title,price,url,image,city,discount_percent,found_at) VALUES(NULL,?,?,?,?,?,?,?,?,?)`);
  const sel = db.prepare('SELECT id FROM items WHERE search_id IS NULL AND telegram_id=? AND avito_id=?');
  const upd = db.prepare('UPDATE items SET price=?, discount_percent=?, found_at=? WHERE id=?');
  return list.map(i => {
    const ex = sel.get(String(tid), i.avito_id);
    if (ex) { upd.run(i.price, i.discount_percent, nowISO(), ex.id); return { ...i, id: ex.id }; }
    const r = ins.run(String(tid), i.avito_id, i.title, i.price, i.url, i.image, i.city, i.discount_percent, nowISO());
    return { ...i, id: Number(r.lastInsertRowid) };
  });
}

// самое выгодное сверху: цена ниже медианы, мусор (чехлы и т.п.) отсеян
export function rankCheapest(list, limit = 30) {
  const med = median(list.map(i => i.price));
  const ok = list.filter(i => i.price > 0 && i.price >= med * cfg.minPriceRatio);
  return {
    median: med,
    items: ok.sort((a, b) => a.price - b.price).slice(0, limit)
      .map(i => ({ ...i, discount_percent: med ? Math.max(0, Math.round((1 - i.price / med) * 100)) : 0 }))
  };
}

/* ---------- мониторинг ---------- */
function notifyText(s, it, ref) {
  return [
    `🔥 <b>Новая находка</b> · «${esc(s.title)}»`,
    esc(it.title.slice(0, 200)),
    `💰 <b>${rub(it.price)}</b> · на <b>${it.discount_percent}%</b> ниже ${rub(ref)}`,
    it.city ? `📍 ${esc(it.city)}` : ''
  ].filter(Boolean).join('\n');
}

export async function scanSearch(s, cache = new Map()) {
  const key = `${s.query}|${s.region}|${s.max_price || ''}`;
  let list = cache.get(key);
  if (!list) { list = await avito.searchAvito({ query: s.query, region: s.region, maxPrice: s.max_price, sort: 'date' }); cache.set(key, list); }

  const ref = s.ref_price || median(list.map(i => i.price));
  const ins = db.prepare(`INSERT OR IGNORE INTO items(search_id,telegram_id,avito_id,title,price,url,image,city,discount_percent,found_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const fresh = [];

  for (const it of list) {
    if (s.source_avito_id && it.avito_id === s.source_avito_id) continue;   // сам исходный товар
    if (s.max_price && it.price > s.max_price) continue;
    if (!ref || it.price >= ref) continue;                                  // нужны только дешевле эталона
    if (it.price < ref * cfg.minPriceRatio) continue;                       // подозрительно дёшево
    const disc = Math.round((1 - it.price / ref) * 100);
    const r = ins.run(s.id, s.telegram_id, it.avito_id, it.title, it.price, it.url, it.image, it.city, disc, nowISO());
    if (r.changes) fresh.push({ ...it, id: Number(r.lastInsertRowid), discount_percent: disc });
  }
  db.prepare('UPDATE searches SET last_scan_at=? WHERE id=?').run(nowISO(), s.id);

  fresh.sort((a, b) => b.discount_percent - a.discount_percent);
  for (const it of fresh.slice(0, 5)) {
    await sendItem(s.telegram_id, notifyText(s, it, ref), it.image, [
      [{ text: '🔗 Перейти на Avito', url: it.url }],
      [{ text: '⭐ В избранное', callback_data: `fav:${it.id}` }]
    ]);
  }
  if (fresh.length > 5) await sendMessage(s.telegram_id, `…и ещё ${fresh.length - 5} находок — смотри во вкладке «Уведомления».`);
  return fresh.length;
}

export async function notifyExpired() {
  const rows = db.prepare('SELECT * FROM searches WHERE expires_at<=? AND expired_notified=0').all(nowISO());
  for (const s of rows) {
    db.prepare('UPDATE searches SET expired_notified=1, is_active=0 WHERE id=?').run(s.id);
    if (s.deleted) continue;
    const d = searchDTO(s);
    const best = d.best_item ? `\n🏆 Лучшее: ${rub(d.best_item.price)} (−${d.best_item.discount_percent}%)` : '';
    await sendMessage(s.telegram_id, `⏰ Поиск «${esc(s.title)}» завершён.\n📦 Найдено: ${d.found_count}${best}\n\nМожно запускать следующий.`);
  }
}

/* ---------- вкладка «Уведомления»: фильтры, сортировка и блокировка по тарифу — на сервере ---------- */
export function listNotifications(tid, { hours, searchId, sort, local }) {
  const plan = effectivePlan(getUser(tid));
  const visible = PLANS[plan].showcaseVisible;
  const searches = db.prepare('SELECT id,title,region FROM searches WHERE telegram_id=? AND deleted=0 ORDER BY id DESC LIMIT 50').all(String(tid));

  let sql = `SELECT i.*, s.title AS search_title, s.region AS search_region FROM items i
             JOIN searches s ON s.id=i.search_id WHERE i.telegram_id=? AND s.deleted=0`;
  const args = [String(tid)];
  if (hours) { sql += ' AND i.found_at>=?'; args.push(new Date(Date.now() - hours * 3600000).toISOString()); }
  if (searchId) { sql += ' AND i.search_id=?'; args.push(searchId); }
  if (local) {
    const cities = [...new Set(searches.map(s => REGIONS[s.region]).filter(Boolean))];
    if (cities.length) { sql += ` AND i.city IN (${cities.map(() => '?').join(',')})`; args.push(...cities); }
  }
  sql += sort === 'discount' ? ' ORDER BY i.discount_percent DESC, i.price ASC'
       : sort === 'cheap'    ? ' ORDER BY i.price ASC'
       :                       ' ORDER BY i.found_at DESC, i.id DESC';
  sql += ' LIMIT 300';

  const rows = db.prepare(sql).all(...args);
  const sums = {};
  for (const r of rows) { (sums[r.search_id] ||= []).push(r.price); }
  const avg = id => Math.round(sums[id].reduce((a, b) => a + b, 0) / sums[id].length);

  const items = rows.map((r, idx) => {
    // карточки сверх лимита тарифа отдаём «пустыми» — разблокировать их на клиенте нельзя
    if (idx >= visible) {
      return { id: r.id, locked: true, title: '••••••••', price: 0, url: null, image: null, city: null,
               found_at: r.found_at, discount_percent: 0, searchId: r.search_id };
    }
    return itemDTO(r, { locked: false, searchId: r.search_id, searchTitle: r.search_title, avgPrice: avg(r.search_id) });
  });
  return {
    items,
    searches: searches.map(s => ({ id: s.id, title: s.title })),
    visible_limit: Number.isFinite(visible) ? visible : null,
    locked_count: items.filter(i => i.locked).length
  };
}
