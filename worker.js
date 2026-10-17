import { PLANS } from './config.js';
import { db, nowISO, getUser } from './db.js';
import * as yk from './yookassa.js';
import { sendMessage } from './telegram.js';

// Идемпотентно: сколько бы раз ни пришёл вебхук — подписка выдаётся один раз
export async function applyPayment(id) {
  const claimed = db.prepare('UPDATE payments SET applied=1, status=? WHERE id=? AND applied=0').run('succeeded', id);
  if (!claimed.changes) return false;

  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(id);
  const u = getUser(p.telegram_id);
  let start = Date.now();
  // продлеваем тот же тариф «встык», иначе — начинаем с сегодняшнего дня
  if (u.plan === p.plan && u.plan_expires_at && Date.parse(u.plan_expires_at) > start) start = Date.parse(u.plan_expires_at);
  const exp = new Date(start + p.duration * 86400000).toISOString();

  db.prepare('UPDATE users SET plan=?, plan_expires_at=? WHERE telegram_id=?').run(p.plan, exp, p.telegram_id);
  await sendMessage(p.telegram_id,
    `✅ <b>Оплата прошла!</b>\nТариф «${PLANS[p.plan].name}» активен до ${new Date(exp).toLocaleDateString('ru-RU')}.`);
  return true;
}

export async function checkPayment(id) {
  const remote = await yk.getPayment(id);
  if (remote.status === 'succeeded' && remote.paid !== false) {
    const mine = db.prepare('SELECT amount FROM payments WHERE id=?').get(id);
    if (remote.amount && mine && Math.round(Number(remote.amount.value)) !== mine.amount) {
      console.error(`[payments] сумма не совпала для ${id}: ЮKassa ${remote.amount.value}, у нас ${mine.amount}`);
      return false;
    }
    return applyPayment(id);
  }
  if (remote.status === 'canceled') db.prepare("UPDATE payments SET status='canceled' WHERE id=? AND applied=0").run(id);
  return false;
}

// Страховка на случай, если вебхук не дошёл: опрашиваем незавершённые платежи за последние сутки
export async function reconcilePayments() {
  const since = new Date(Date.now() - 86400000).toISOString();
  const rows = db.prepare("SELECT id FROM payments WHERE applied=0 AND status='pending' AND created_at>?").all(since);
  for (const r of rows) { try { await checkPayment(r.id); } catch (e) { console.warn('reconcile', r.id, e.message); } }
}
