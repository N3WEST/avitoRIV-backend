import crypto from 'node:crypto';
import { cfg } from './config.js';
import { db } from './db.js';

const api = (method, params = {}) =>
  fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(35000)
  }).then(r => r.json());

export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendMessage(chatId, text, extra = {}) {
  if (!cfg.botToken) return console.log(`[bot→${chatId}] ${text}`);
  const r = await api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  if (!r.ok) console.warn('sendMessage:', r.description);
  return r;
}

export async function sendItem(chatId, caption, photo, buttons) {
  if (!cfg.botToken) return console.log(`[bot→${chatId}] ${caption.replace(/\n/g, ' | ')}`);
  const markup = { reply_markup: { inline_keyboard: buttons } };
  if (photo) {
    const r = await api('sendPhoto', { chat_id: chatId, photo, caption, parse_mode: 'HTML', ...markup });
    if (r.ok) return r;
  }
  return sendMessage(chatId, caption, markup); // фото не загрузилось — шлём без него
}

/* Проверка подписи initData мини-приложения (https://core.telegram.org/bots/webapps#validating-data) */
export function verifyInitData(initData) {
  if (!cfg.botToken || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(cfg.botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

/* Long polling: /start и кнопка «⭐ В избранное» под уведомлением */
export async function startBot({ onStart, onFavorite }) {
  if (!cfg.botToken) return console.log('BOT_TOKEN не задан — бот выключен, уведомления пишутся в консоль');
  try { await api('deleteWebhook'); } catch (e) { console.warn('deleteWebhook:', e.message); }
  const kv = db.prepare("SELECT value FROM kv WHERE key='tg_offset'");
  let offset = Number(kv.get()?.value || 0);

  (async function loop() {
    for (;;) {
      try {
        const r = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          db.prepare("INSERT INTO kv(key,value) VALUES('tg_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(offset));
          try {
            if (u.message?.text?.startsWith('/start')) await onStart(u.message);
            if (u.callback_query?.data?.startsWith('fav:')) {
              const q = u.callback_query;
              const res = await onFavorite(String(q.from.id), Number(q.data.slice(4)));
              await api('answerCallbackQuery', { callback_query_id: q.id, text: res.error || '⭐ Добавлено в избранное', show_alert: !!res.error });
            }
          } catch (e) { console.warn('update error:', e.message); }
        }
      } catch (e) {
        console.warn('getUpdates:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  })();
}
