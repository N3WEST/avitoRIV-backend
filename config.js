import { cfg } from './config.js';

// Фото → короткий поисковый запрос для Avito (Claude Vision)
export async function describeImage(dataUrl) {
  if (!cfg.anthropicKey) throw Object.assign(new Error('Поиск по фото не настроен на сервере'), { status: 501 });
  const m = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!m) throw Object.assign(new Error('Неверный формат фото'), { status: 400 });
  const bytes = Buffer.from(m[2].slice(0, 32), 'base64');
  const magic = bytes.subarray(0, 4).toString('hex');
  const okMagic = magic.startsWith('ffd8ff') || magic === '89504e47' || magic === '52494646' || magic === '47494638';
  if (!okMagic || m[2].length * 0.75 > 5 * 1024 * 1024) {
    throw Object.assign(new Error('Фото должно быть JPEG, PNG или WebP до 5 МБ'), { status: 400 });
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.anthropicModel,
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
          { type: 'text', text: 'Это фото товара для покупки на Авито. Напиши поисковый запрос на русском: бренд, модель, тип, цвет — 2–6 слов, без пояснений и кавычек. Если на фото нет товара — ответь одним словом: НЕТ.' }
        ]
      }]
    }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error('Не удалось распознать фото'), { status: 502 });
  const text = (j.content?.[0]?.text || '').trim().replace(/["«»]/g, '');
  if (!text || /^нет\.?$/i.test(text)) throw Object.assign(new Error('Не удалось распознать товар на фото'), { status: 422 });
  return text.slice(0, 80);
}
