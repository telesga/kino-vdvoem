#!/usr/bin/env bash
# Установка «Смотрим вместе» на Ubuntu/Debian одной командой:
#   curl -fsSL https://raw.githubusercontent.com/telesga/kino-vdvoem/main/server/install.sh | sudo bash
# Повторный запуск обновляет до последней версии (фильмы и пароль сохраняются).
# Свой пароль:  ... | sudo KINO_PASSWORD='мой пароль' bash
# Свой домен:   ... | sudo DOMAIN=kino.example.ru bash
set -Eeuo pipefail

# Всё внутри функции: bash читает скрипт целиком до запуска,
# и программы, читающие ввод (needrestart и т.п.), не «съедят» остаток при curl | bash.
main() {

REPO="https://github.com/telesga/kino-vdvoem.git"
APP=/opt/kino
DATA=/var/lib/kino
ENVF=/etc/kino.env

say() { printf '\n\033[1;37m▸ %s\033[0m\n' "$*"; }
trap 'printf "\n\033[1;31m✘ Ошибка (строка %s): %s\033[0m\nПришли этот текст — разберёмся.\n" "$LINENO" "$BASH_COMMAND"' ERR
[ "$(id -u)" = 0 ] || { echo "Запусти через sudo"; exit 1; }
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1

say "Ставлю системные пакеты (ffmpeg, git, curl)…"
apt-get update -qq
apt-get install -y -qq ffmpeg git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  say "Ставлю Node.js 22…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  say "Ставлю Caddy (веб-сервер с автоматическим HTTPS)…"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "Скачиваю приложение…"
rm -rf "$APP"
git clone --depth 1 "$REPO" "$APP"
[ -f "$APP/server/server.js" ] || { echo "Не удалось скачать приложение с GitHub"; exit 1; }
say "Ставлю зависимости приложения…"
cd "$APP/server"
command -v npm >/dev/null || apt-get install -y -qq npm >/dev/null
npm install --omit=dev --no-audit --no-fund --loglevel=error

id kino >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin kino
mkdir -p "$DATA" && chown -R kino:kino "$DATA"

# пароль: из переменной, из прошлой установки или новый случайный
if [ -n "${KINO_PASSWORD:-}" ]; then PASS="$KINO_PASSWORD"
elif [ -f "$ENVF" ] && grep -q '^KINO_PASSWORD=' "$ENVF"; then PASS="$(grep '^KINO_PASSWORD=' "$ENVF" | cut -d= -f2-)"
else PASS="$(openssl rand -hex 5 2>/dev/null || od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"; fi
cat > "$ENVF" <<EOF
KINO_PASSWORD=$PASS
KINO_DATA=$DATA
PORT=3000
HOST=127.0.0.1
EOF
chmod 600 "$ENVF"

cat > /etc/systemd/system/kino.service <<EOF
[Unit]
Description=Смотрим вместе
After=network-online.target

[Service]
EnvironmentFile=$ENVF
WorkingDirectory=$APP/server
ExecStart=$(command -v node) server.js
User=kino
Restart=always
RestartSec=2
Nice=5

[Install]
WantedBy=multi-user.target
EOF

# адрес: свой домен или бесплатный <ip>.sslip.io (на него Caddy сам выпустит HTTPS-сертификат)
IP="$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me)"
DOMAIN="${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
EOF

# локальный файрвол (если включён)
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi

systemctl daemon-reload
systemctl enable -q --now kino
systemctl restart kino
systemctl enable -q caddy
systemctl restart caddy

sleep 2
FREE="$(df -h "$DATA" | awk 'NR==2{print $4}')"
printf '\n\033[1;32m✔ Готово!\033[0m\n\n'
printf '  Адрес:   \033[1mhttps://%s\033[0m\n' "$DOMAIN"
printf '  Пароль:  \033[1m%s\033[0m\n' "$PASS"
printf '  Место под фильмы: %s\n\n' "$FREE"
printf '  Если сайт не открывается — открой порты 80 и 443 в настройках сервера\n'
printf '  (в AWS: EC2 → Security Groups → Inbound rules → HTTP и HTTPS, источник 0.0.0.0/0).\n'
printf '  Логи: journalctl -u kino -f\n\n'
}

main "$@" < /dev/null
