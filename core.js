import { ProxyAgent } from 'undici';
import { cfg } from './config.js';

export class AvitoBlocked extends Error {
  constructor(m) { super(m); this.status = 503; }
}

const dispatcher = cfg.proxyUrl ? new ProxyAgent(cfg.proxyUrl) : undefined;
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml',
  'accept-language': 'ru-RU,ru;q=0.9'
};
const BLOCK_RE = /Доступ ограничен|firewall|captcha|Проблема с IP/i;

/* ---------- разбор ссылки ---------- */
const HOST_RE = /^(www\.|m\.)?avito\.ru$/;

// Принимаем только https-ссылки на сам avito.ru: без логина/пароля, нестандартных портов и чужих доменов
export function parseAvitoUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return null;
  if (!HOST_RE.test(u.hostname)) return null;
  const path = u.pathname.replace(/[^\w\-./%]/g, '').slice(0, 300);
  const parts = path.split('/').filter(Boolean);
  const m = path.match(/_(\d{6,})\/?$/);
  const region = /^[a-z0-9_-]{1,40}$/.test(parts[0] || '') && parts[0] !== 'all' ? parts[0] : '';
  const pmax = Number(u.searchParams.get('pmax')) || null;
  const query = (u.searchParams.get('q') || '').replace(/[\u0000-\u001f<>]/g, ' ').slice(0, 120);
  // сохраняем «чистую» ссылку, а не то, что прислал клиент
  const canonical = m
    ? `https://www.avito.ru${path}`
    : `https://www.avito.ru/${region || 'all'}?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(pmax ? { pmax: String(pmax) } : {}) })}`;
  return { isAd: !!m, adId: m ? m[1] : null, region, query, pmax, canonical };
}

const isAvitoHttps = s => { try { const u = new URL(s); return u.protocol === 'https:' && HOST_RE.test(u.hostname); } catch { return false; } };
const safeImage = s => {
  try {
    const u = new URL(s);
    const ok = u.protocol === 'https:' && (/\.avito\.(st|ru)$/.test(u.hostname) || (cfg.avitoMode === 'mock' && u.hostname === 'picsum.photos'));
    return ok ? u.href : null;
  } catch { return null; }
};

// «iPhone 15, 256 ГБ, Black — купить в Москве на Avito» → «iPhone 15 256 ГБ Black»
export function queryFromTitle(title) {
  return String(title || '')
    .split(/\s[—–|]\s/)[0]
    .replace(/\s+(купить|в\s+[А-ЯЁ][а-яё-]+).*$/u, '')
    .replace(/[,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/* ---------- HTTP ---------- */
const MAX_HTML = 5_000_000;

async function getHtml(url, hops = 0) {
  if (!isAvitoHttps(url)) throw new Error('Недопустимый адрес');
  // редиректы обрабатываем вручную: нельзя уйти с avito.ru (защита от SSRF)
  const r = await fetch(url, { headers: HEADERS, dispatcher, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    const loc = r.headers.get('location');
    if (!loc || hops >= 3) throw new Error('Слишком много перенаправлений');
    return getHtml(new URL(loc, url).href, hops + 1);
  }
  if (r.status === 403 || r.status === 429) throw new AvitoBlocked(`Avito вернул ${r.status}`);
  if (!r.ok) throw new Error(`Avito HTTP ${r.status}`);

  const chunks = []; let size = 0;                 // читаем не больше 5 МБ
  for await (const c of r.body) {
    size += c.length;
    if (size > MAX_HTML) throw new Error('Ответ Avito слишком большой');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function initialData(html) {
  const m = html.match(/window\.__initialData__\s*=\s*"([^"]*)"/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

function findItems(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === 'object' && node[0].urlPath && node[0].title) return node;
    for (const x of node) { const r = findItems(x, depth + 1); if (r) return r; }
    return null;
  }
  for (const k of Object.keys(node)) { const r = findItems(node[k], depth + 1); if (r) return r; }
  return null;
}

function pickImage(it) {
  const f = (it.images || it.galleryItems || [])[0];
  if (!f) return null;
  if (typeof f === 'string') return f;
  const obj = f.value && typeof f.value === 'object' ? f.value : f;
  const keys = Object.keys(obj).filter(k => /^\d+x\d+$/.test(k));
  if (!keys.length) return typeof f.url === 'string' ? f.url : null;
  keys.sort((a, b) => parseInt(b) - parseInt(a));
  return obj[keys[0]];
}

function normalize(it) {
  const price = it.priceDetailed?.value ?? (parseInt(String(it.price || '').replace(/\D/g, ''), 10) || 0);
  const path = it.urlPath || '';
  const url = path.startsWith('http') ? path : 'https://www.avito.ru' + path;
  return {
    avito_id: String(it.id).replace(/\D/g, '').slice(0, 20),
    title: String(it.title || '').slice(0, 200),
    price: Number(price) || 0,
    url: isAvitoHttps(url) ? url : '',
    image: safeImage(pickImage(it)),
    city: String(it.location?.name || it.addressDetailed?.locationName || '').slice(0, 80)
  };
}

/* ---------- публичное API ---------- */
const cache = new Map(); // защита Avito от повторных одинаковых запросов
const TTL = 3 * 60 * 1000;

export async function searchAvito({ query, region = '', maxPrice = null, sort = 'date' }) {
  if (cfg.avitoMode === 'mock') return mockItems(query, region);

  const reg = !region || region === 'all' ? 'rossiya' : region;
  const params = new URLSearchParams({ q: query, s: sort === 'cheap' ? '1' : '104' });
  if (maxPrice) params.set('pmax', String(maxPrice));
  const url = `https://www.avito.ru/${reg}?${params}`;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < TTL) return hit.v;

  const html = await getHtml(url);
  const data = initialData(html);
  const raw = data ? findItems(data) : null;
  if (!raw) {
    if (BLOCK_RE.test(html.slice(0, 6000))) throw new AvitoBlocked('Avito показал капчу / ограничил IP');
    return [];
  }
  const v = raw.map(normalize).filter(i => i.price > 0 && i.url && i.avito_id);
  cache.set(url, { t: Date.now(), v });
  return v;
}

export async function fetchAd(url) {
  if (cfg.avitoMode === 'mock') return mockAd(url);

  const html = await getHtml(url);
  if (BLOCK_RE.test(html.slice(0, 6000)) && !/og:title/.test(html)) throw new AvitoBlocked('Avito показал капчу / ограничил IP');

  const meta = p => {
    const a = html.match(new RegExp(`<meta[^>]+(?:property|itemprop|name)="${p}"[^>]*content="([^"]*)"`, 'i'));
    const b = html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]*(?:property|itemprop|name)="${p}"`, 'i'));
    return (a || b || [])[1] || '';
  };
  const title = meta('og:title') || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
  const price = parseInt(meta('product:price:amount') || meta('price') || '0', 10) || 0;
  if (!title) throw new Error('Не удалось прочитать объявление');
  return { title: title.replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 200), price, image: safeImage(meta('og:image')) };
}

/* ---------- mock-режим (AVITO_MODE=mock) для проверки без Avito ---------- */
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function mockAd(url) {
  return { title: 'iPhone 15, 256 ГБ, Black — купить в Москве', price: 60000, image: null };
}

function mockItems(query, region) {
  const window5 = Math.floor(Date.now() / (5 * 60 * 1000));
  const cities = ['Москва', 'Санкт-Петербург', 'Казань', 'Екатеринбург', 'Новосибирск', 'Краснодар'];
  const out = [];
  for (let i = 0; i < 14; i++) {
    const r = rng(window5 * 7919 + i * 104729 + query.length * 31);
    r(); r(); r();
    const price = Math.round((38000 + r() * 30000) / 100) * 100;
    out.push({
      avito_id: `${window5}${i}`.padStart(10, '9'),
      title: `${query} (тест ${i + 1})`,
      price,
      url: `https://www.avito.ru/test/${window5}${i}`,
      image: `https://picsum.photos/seed/${window5}${i}/400/300`,
      city: cities[Math.floor(r() * cities.length)]
    });
  }
  return out;
}
