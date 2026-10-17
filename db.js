import { cleanText, cleanPrice, fail } from './util.js';

export const REGIONS = {
  'moskva': 'Москва', 'sankt-peterburg': 'Санкт-Петербург', 'kazan': 'Казань', 'ekaterinburg': 'Екатеринбург',
  'novosibirsk': 'Новосибирск', 'krasnodar': 'Краснодар', 'nizhniy_novgorod': 'Нижний Новгород',
  'samara': 'Самара', 'rostov-na-donu': 'Ростов-на-Дону', 'ufa': 'Уфа', 'chelyabinsk': 'Челябинск', 'perm': 'Пермь'
};

const region = { id: 'region', label: 'Регион', type: 'select', options: [['all', 'Вся Россия'], ...Object.entries(REGIONS)] };
const condition = { id: 'condition', label: 'Состояние', type: 'select', options: [['', 'Любое'], ['new', 'Новое'], ['used', 'Б/у']] };
const price = ph => ({ id: 'max_price', label: 'Цена до (₽)', placeholder: ph, type: 'number' });
const text = (id, label, placeholder) => ({ id, label, placeholder, type: 'text' });

// Описание форм витрины. Фронт рисует форму по этому списку, а сервер по нему же валидирует ввод.
export const CATEGORIES = {
  phones: [
    text('model', 'Модель', 'iPhone 16 Pro, iPhone 15, Samsung S24…'),
    { id: 'memory', label: 'Память', type: 'select', options: [['', 'Любая'], ['128GB', '128 ГБ'], ['256GB', '256 ГБ'], ['512GB', '512 ГБ'], ['1TB', '1 ТБ']] },
    text('color', 'Цвет', 'Например, золотой'),
    { id: 'battery', label: 'АКБ от (%)', placeholder: '90', type: 'number' },
    { id: 'no_repair', label: 'Без ремонта', type: 'toggle' },
    { id: 'original', label: 'Только оригинал', type: 'toggle' },
    price('Например, 80000'), region
  ],
  clothes: [text('type', 'Тип', 'Куртка, футболка, штаны…'), text('brand', 'Бренд', 'Nike, Adidas…'), text('size', 'Размер', 'S / M / L / XL…'), condition, price('Например, 5000'), region],
  laptops: [text('model', 'Модель', 'MacBook Air M2, Lenovo…'), text('brand', 'Бренд', 'Apple, ASUS, Lenovo…'), condition, price('Например, 70000'), region],
  games:   [text('model', 'Игра / консоль', 'PS5, Nintendo Switch, Elden Ring…'), text('brand', 'Бренд / платформа', 'Sony, Xbox, Nintendo…'), condition, price('Например, 30000'), region],
  shoes:   [text('model', 'Модель', 'Air Force 1, Samba…'), text('brand', 'Бренд', 'Nike, Adidas, New Balance…'), text('size', 'Размер', 'Например, 42'), condition, price('Например, 10000'), region]
};

const NAMES = { phones: 'телефоны', clothes: 'одежда', laptops: 'ноутбуки', games: 'игры', shoes: 'обувь' };

// Клиент присылает только {category, filters}; запрос для Avito собираем и проверяем здесь
export function buildCategoryQuery(category, raw = {}) {
  const fields = CATEGORIES[category];
  if (!fields) throw fail(400, 'Неизвестная категория');
  const f = {};
  for (const fd of fields) {
    const v = raw?.[fd.id];
    if (fd.type === 'toggle') f[fd.id] = v === true;
    else if (fd.type === 'select') f[fd.id] = fd.options.some(o => o[0] === String(v ?? '')) ? String(v ?? '') : fd.options[0][0];
    else if (fd.type === 'number') f[fd.id] = cleanPrice(v);
    else f[fd.id] = cleanText(v, 60);
  }
  const parts = [f.model, f.type, f.brand, f.size, f.memory, f.color];
  if (f.battery && f.battery <= 100) parts.push(`акб ${f.battery}`);
  if (f.no_repair) parts.push('без ремонта');
  if (f.original) parts.push('оригинал');
  if (f.condition === 'new') parts.push('новое');
  if (f.condition === 'used') parts.push('б/у');
  if (!parts.some(Boolean)) parts.push(NAMES[category]);

  return {
    query: parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120),
    maxPrice: f.max_price,
    region: f.region && f.region !== 'all' ? f.region : '',
    filters: f
  };
}
