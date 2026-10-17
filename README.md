# RIV — бэкенд (Node.js + SQLite)

Принцип: **всё, что можно подделать в браузере, решает сервер.** Любой может открыть DevTools и поправить JS, поэтому
во фронте остались только отрисовка и вызовы API. Тарифы, цены, лимиты, промокоды, фильтры витрины, сортировка,
«заблокированные» карточки, расчёт «−N%» — всё на сервере.

```
public/        index.html + app.css + app.js   ← отдаёт сам сервер (JS отдельным файлом — нужно для строгой CSP)
server.js      маршруты, безопасность
src/           config (тарифы), catalog (формы витрины), core (поиск/лимиты), avito, telegram, yookassa, payments, worker, ai
deploy/        nginx.conf, riv.service (systemd), backup.sh
```

## Что где живёт
| Решение | Где | Как |
|---|---|---|
| Тарифы, цены, лимиты, часы | сервер | `src/config.js`; фронт получает `GET /api/config` и рисует шторку тарифов |
| Можно ли запустить поиск | сервер | `slots()`; фронт только показывает результат |
| Цена платежа, промокод | сервер | `priceFor()`, `POST /api/promo/check`; клиент цену не присылает |
| Какие карточки «закрыты» | сервер | у закрытых в ответе нет ни названия, ни ссылки, ни цены |
| Фильтры/сортировка уведомлений | сервер | `GET /api/notifications?hours=&sort=&search_id=&local=` |
| Форма витрины и запрос к Avito | сервер | `src/catalog.js`: клиент шлёт `{category, filters}`, остальное собирает сервер |
| % «ниже», город | сервер | поля `discount_percent`, `city` в каждом товаре |

В браузере остаётся только то, что без него невозможно: рисование интерфейса, Telegram SDK, выбор фото.

## Безопасность (что сделано)
- **Личность пользователя** — только из подписанного `initData` Telegram (HMAC, проверка `auth_date`). `telegram_id` из запроса
  не принимается; в production запросы без подписи отклоняются.
- **Оплата**: сумма считается на сервере; вебхук принимается только с IP ЮKassa; статус и **сумму** сервер
  перепроверяет запросом к API ЮKassa (тело вебхука не доверенное); выдача подписки идемпотентна; не больше 5 неоплаченных счетов в час.
- **SSRF**: принимаются только `https://avito.ru`-ссылки без логина/порта; редиректы вручную и только на avito.ru;
  ответ ограничен 5 МБ; в БД сохраняется «очищенная» ссылка, а не присланная клиентом.
- **Входные данные**: все поля валидируются и чистятся (`util.js`, `catalog.js`); неизвестные поля игнорируются;
  SQL — только параметризованные запросы; ссылки на товары и картинки ограничены доменами Avito.
- **XSS/CSP**: строгая Content-Security-Policy — скрипты только с `self` и `telegram.org`, inline-JS запрещён
  (inline-обработчики вынесены), `connect-src 'self'`; всё, что вставляется в HTML, экранируется; внешние ссылки открываются только по https.
- **Лимиты запросов**: 240/мин на IP, плюс по пользователю на создание поисков, платежей, промокодов (защита от перебора), избранного.
  Размер тела 100 КБ (8 МБ только для фото; проверяются тип по сигнатуре файла и размер).
- **Сервер**: слушает только `127.0.0.1`; HSTS, `nosniff`, `no-referrer`; systemd-изоляция; файл БД с правами 600; пользователь без прав root.

## Что остаётся на вас (я это не закрою кодом)
- Секреты (`BOT_TOKEN`, ключи ЮKassa/Anthropic) — только в `/etc/riv.env` (chmod 600), не в git и не в чат.
- Промокоды `RIV10/RIV20` лежат в `config.js` и действуют на всех без ограничений. Если нужны одноразовые или с лимитом — храните в БД.
- Avito: у него нет открытого API, а парсинг может нарушать его правила; нужен российский прокси (`PROXY_URL`).
  Парсер не проверялся на живом avito.ru.

## Деплой на VPS (Ubuntu 22.04/24.04)
```bash
# 1. система и фаервол
apt update && apt install -y nginx certbot python3-certbot-nginx sqlite3 ufw fail2ban
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable          # наружу только 22, 80, 443
# SSH: вход по ключу, PasswordAuthentication no, PermitRootLogin no

# 2. Node 22 (nodejs.org / nodesource) и пользователь без прав
useradd --system --home /opt/riv --shell /usr/sbin/nologin riv
mkdir -p /opt/riv /var/lib/riv && chown riv:riv /var/lib/riv && chmod 700 /var/lib/riv

# 3. код
unzip riv-backend.zip -d /tmp && cp -r /tmp/riv-backend/. /opt/riv && cd /opt/riv
npm ci --omit=dev || npm install --omit=dev
chown -R root:root /opt/riv                                        # код только на чтение для сервиса

# 4. секреты
cp .env.example /etc/riv.env && chmod 600 /etc/riv.env && nano /etc/riv.env

# 5. сервис
cp deploy/riv.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now riv
journalctl -u riv -f                                               # логи

# 6. nginx + HTTPS
cp deploy/nginx.conf /etc/nginx/sites-available/riv   # поменяй example.com
ln -s /etc/nginx/sites-available/riv /etc/nginx/sites-enabled/ && certbot --nginx -d ВАШ.ДОМЕН && nginx -t && systemctl reload nginx

# 7. бэкап БД каждый день в 4:00
( crontab -l 2>/dev/null; echo "0 4 * * * /opt/riv/deploy/backup.sh" ) | crontab -
```
После запуска: в @BotFather задай адрес мини-приложения, в личном кабинете ЮKassa — URL вебхука
`https://ВАШ.ДОМЕН/api/payment/webhook` (событие `payment.succeeded`).

**Обновление:** загрузить новую версию в `/opt/riv` → `systemctl restart riv`. База лежит отдельно (`/var/lib/riv`) и не затрагивается.

## Локальная проверка
```bash
npm install && npm run dev        # Avito подменён тестовыми данными, оплата — заглушка /dev/pay/…
```
