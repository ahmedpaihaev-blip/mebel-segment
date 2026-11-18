# Мебель Сегмент

Магазин мебельной фурнитуры (mebel-segment.ru) и закрытый кабинет владельца: счета, заказы, склад, приходы, банки.

- Магазин: `https://mebel-segment.ru`
- Кабинет: `https://mebel-segment.ru/#admin`

## Установка и обновление на сервере (Ubuntu 22.04/24.04, от root)

```bash
curl -fsSL https://raw.githubusercontent.com/ahmedpaihaev-blip/mebel-segment/main/install.sh | bash
```

Повторный запуск той же команды обновляет приложение. Данные лежат в `/var/lib/mebel-segment/shop.db`, ежедневные копии — в `/var/backups/mebel-segment/`.

Смена пароля кабинета: отредактировать `ADMIN_PASSWORD` в `/etc/mebel-segment.env`, затем `systemctl restart mebel-segment`.

Логотип: положить файл `public/logo.png`, он появится в шапке.

## Локальный запуск

```bash
ADMIN_PASSWORD=test node server.js
```

Без зависимостей, нужен Node.js 22+.

## Резервные копии и восстановление

- Каждую ночь на сервере: `/var/backups/mebel-segment/shop-ДАТА.db` (согласованная копия базы) и `photos-ДАТА.tar.gz` (фото товаров), хранятся 30 дней.
- Каждую ночь на почту для уведомлений: `mebel-segment-ДАТА.db.gz` и, если помещается в письмо, `mebel-segment-photos-ДАТА.tar.gz`.

Восстановление на сервере (от root):

```bash
systemctl stop mebel-segment
gunzip -c mebel-segment-ДАТА.db.gz > /var/lib/mebel-segment/shop.db   # или cp shop-ДАТА.db /var/lib/mebel-segment/shop.db
rm -f /var/lib/mebel-segment/shop.db-wal /var/lib/mebel-segment/shop.db-shm
tar -xzf mebel-segment-photos-ДАТА.tar.gz -C /var/lib/mebel-segment     # фото → uploads/
chown -R mebel:mebel /var/lib/mebel-segment && systemctl start mebel-segment
```

## Страницы для покупателей и поисковиков

- `/tovar/<артикул>` — страница товара (`/tovar/ms-05`), `/sitemap.xml`, `/robots.txt`.
- `/rekvizity` — реквизиты и оферта, `/privacy` — политика обработки персональных данных, `/soglasie` — текст согласия.
- Яндекс Метрика и подтверждение Яндекс Вебмастера — «Кабинет → Настройки → Сайт в Яндексе».
- Шрифты установщик скачивает на сервер в `public/fonts/` (не с серверов Google).
