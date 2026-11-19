#!/usr/bin/env bash
# Установка клиента синхронизации лимитов на машину (macOS / Linux / Windows Git Bash).
#   bash install.sh <URL воркера> <API_TOKEN> [id машины]
#   id — технический (латиница, цифры, _.-); не указан — берётся имя компьютера.
#   Как машина называется в боте и статус-лайнах, задаётся в боте: /rename.
set -euo pipefail

URL="${1:?URL воркера}"; TOKEN="${2:?API_TOKEN}"; DEVICE="${3:-}"
URL="${URL%/}"
DIR="$HOME/.claude/limits-sync"
SRC="$(cd "$(dirname "$0")" && pwd)"

command -v jq >/dev/null || { echo "Нужен jq (Windows: winget install jqlang.jq, macOS: brew install jq)"; exit 1; }
command -v curl >/dev/null || { echo "Нужен curl"; exit 1; }

mkdir -p "$DIR"
cp "$SRC/limits-sync.sh" "$DIR/limits-sync.sh"
chmod +x "$DIR/limits-sync.sh"
umask 077
cat > "$DIR/config" <<EOF
LIMITS_URL='$URL'
LIMITS_TOKEN='$TOKEN'
EOF
[ -n "$DEVICE" ] && printf "LIMITS_DEVICE='%s'\n" "$(printf '%s' "$DEVICE" | tr -cd 'A-Za-z0-9_.-' | cut -c1-24)" >> "$DIR/config"

printf 'Проверка связи… '
if curl -sf -m 10 "$URL/state" -H "Authorization: Bearer $TOKEN" >/dev/null; then echo OK; else echo "ОШИБКА (проверь URL и токен)"; exit 1; fi

cat <<'EOF'

Готово. Осталось подключить клиент к статус-лайну (~/.claude/statusline-command.sh).
В начало блока «7-day limit» вставь:

  sync_seg=$(printf '%s' "$input" | bash "$HOME/.claude/limits-sync/limits-sync.sh" 2>/dev/null)
  if [ -n "$sync_seg" ]; then
    parts+=("$sync_seg")
  elif [ -n "$week_pct" ]; then
    ...старая логика...
  fi

(или переименуй старое условие `if [ -n "$week_pct" ]` в `elif` после этой проверки).

Z.ai (~/.claude-zai/statusline-command.sh): перед блоком «недельный лимит» собери вход из квоты
и вызови клиент с LIMITS_POOL=zai LIMITS_LABEL=нед — готовый пример в README, раздел «Z.ai».
EOF
