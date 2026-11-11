#!/usr/bin/env bash
# Установка и обновление «Мебель Сегмент» на чистый сервер Ubuntu 22.04/24.04.
# Повторный запуск обновляет приложение и не трогает данные и пароль.
set -euo pipefail
REPO="${REPO:-https://github.com/ahmedpaihaev-blip/mebel-segment.git}"
DOMAIN="${DOMAIN:-mebel-segment.ru}"
APP=/opt/mebel-segment
DATA=/var/lib/mebel-segment
ENVF=/etc/mebel-segment.env

[ "$(id -u)" = 0 ] || { echo "Запустите от root."; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/5 Системные пакеты"
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "== 2/5 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== 3/5 Caddy (веб-сервер с автоматическим HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "== 4/5 Приложение"
id mebel >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin mebel
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone --depth 1 "$REPO" "$APP"; fi
mkdir -p "$DATA" && chown mebel:mebel "$DATA" && chmod 700 "$DATA"
if [ ! -f "$ENVF" ]; then
  echo
  while true; do
    read -rsp "Придумайте пароль для входа в кабинет (не меньше 8 символов): " P1 </dev/tty; echo
    read -rsp "Повторите пароль: " P2 </dev/tty; echo
    if [ "${#P1}" -ge 8 ] && [ "$P1" = "$P2" ]; then break; fi
    echo "Пароли не совпадают или короче 8 символов. Ещё раз."
  done
  umask 077
  printf 'ADMIN_PASSWORD=%s\nDATA_DIR=%s\nPORT=3000\n' "$P1" "$DATA" > "$ENVF"
  unset P1 P2
fi
cat > /etc/systemd/system/mebel-segment.service <<UNIT
[Unit]
Description=Mebel Segment shop
After=network.target
[Service]
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node --no-warnings $APP/server.js
WorkingDirectory=$APP
User=mebel
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATA
ProtectHome=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable mebel-segment >/dev/null
systemctl restart mebel-segment

echo "== 5/5 Домен и HTTPS"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN, www.$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
CADDY
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi
systemctl enable caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

# ежедневная копия базы, хранится 30 дней
cat > /etc/cron.daily/mebel-segment-backup <<'BK'
#!/bin/sh
mkdir -p /var/backups/mebel-segment
cp /var/lib/mebel-segment/shop.db "/var/backups/mebel-segment/shop-$(date +%F).db" 2>/dev/null
find /var/backups/mebel-segment -name 'shop-*.db' -mtime +30 -delete
BK
chmod +x /etc/cron.daily/mebel-segment-backup

sleep 2
if systemctl is-active --quiet mebel-segment; then
  echo
  echo "Готово. Магазин: https://$DOMAIN"
  echo "Кабинет:  https://$DOMAIN/#admin"
  echo "Если сайт не открывается сразу, подождите 10–30 минут, пока обновится DNS."
else
  echo "Приложение не запустилось. Журнал:"; journalctl -u mebel-segment -n 30 --no-pager; exit 1
fi
