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
