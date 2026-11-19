#!/usr/bin/env bash
# ~/.claude/limits-sync/limits-sync.sh
# Клиент синхронизации лимитов Claude между машинами.
#   stdin  — JSON, который Claude Code передаёт статус-лайну
#   stdout — готовый сегмент «7д …» с разбивкой по машинам (или пусто, если данных нет)
# Отчёт на сервер уходит в фоне, полоска рисуется из кеша последнего ответа — статус-лайн не ждёт сеть.
# Нужны: bash, curl, jq (на Windows — Git Bash + jq).
#
# Окружение:
#   LIMITS_POOL   пул лимитов: claude (по умолчанию), zai, … — у каждого свои окна и свой учёт
#   LIMITS_LABEL  подпись сегмента в статус-лайне (по умолчанию «7д»)
# Вход может содержать .limits_sync_baseline = {resets_at, pct} — старая оценка доли машины
# в текущей неделе (для миграции); для пула claude она берётся из ~/.claude/limit-split.json.

DIR="${LIMITS_SYNC_DIR:-$HOME/.claude/limits-sync}"
CONF="$DIR/config"
[ -f "$CONF" ] || exit 0
# shellcheck disable=SC1090
. "$CONF"   # LIMITS_URL, LIMITS_TOKEN, [LIMITS_DEVICE]
# LIMITS_DEVICE — технический id машины (латиница, цифры, _.-). Не задан — берём имя компьютера.
# Как машина называется в боте и статус-лайне, задаётся в боте: /rename.
LIMITS_DEVICE="${LIMITS_DEVICE:-$(hostname -s 2>/dev/null || hostname 2>/dev/null)}"
LIMITS_DEVICE=$(printf '%s' "$LIMITS_DEVICE" | tr -cd 'A-Za-z0-9_.-' | cut -c1-24)
[ -n "$LIMITS_URL" ] && [ -n "$LIMITS_TOKEN" ] && [ -n "$LIMITS_DEVICE" ] || exit 0
command -v jq >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || exit 0

POOL=$(printf '%s' "${LIMITS_POOL:-claude}" | tr -cd 'a-z0-9_-' | cut -c1-16)
LABEL="${LIMITS_LABEL:-7д}"
CACHE="$DIR/state-$POOL.json"
SENT="$DIR/sent-$POOL"
ERR="$DIR/error-$POOL"
THROTTLE="${LIMITS_THROTTLE:-5}"
OLD_SPLIT="$HOME/.claude/limit-split.json"   # старая локальная оценка (для миграции)
mkdir -p "$SENT"

input=$(cat)
now=$(date +%s)

# --- 1. отчёт (в фоне) ---------------------------------------------------------
read -r sid sig < <(printf '%s' "$input" | jq -r '
  [(.session_id // "nosession"),
   ([.rate_limits.five_hour.used_percentage, .rate_limits.five_hour.resets_at,
     .rate_limits.seven_day.used_percentage, .rate_limits.seven_day.resets_at] | map(tostring) | join("|"))]
  | @tsv' 2>/dev/null)
sid="${sid:-nosession}"
sid_file="$SENT/${sid//[^A-Za-z0-9_-]/_}"

send=1
if [ -f "$sid_file" ]; then
  read -r last_t last_sig < "$sid_file"
  # одинаковые проценты и прошло меньше THROTTLE секунд — пропускаем; изменились проценты — шлём сразу
  [ "$last_sig" = "$sig" ] && [ $(( now - ${last_t:-0} )) -lt "$THROTTLE" ] && send=0
fi

if [ "$send" = 1 ]; then
  printf '%s %s\n' "$now" "$sig" > "$sid_file"

  # Миграция: один раз за окно отправляем старую локальную оценку доли этой машины.
  week_reset=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.resets_at // empty | tostring')
  baseline='null'
  base_flag="$DIR/baseline-$POOL-$week_reset"
  if [ -n "$week_reset" ] && [ ! -f "$base_flag" ]; then
    baseline=$(printf '%s' "$input" | jq -c '.limits_sync_baseline // null' 2>/dev/null || echo null)
  fi
  if [ "$baseline" = "null" ] && [ "$POOL" = "claude" ] && [ -n "$week_reset" ] && [ -f "$OLD_SPLIT" ] && [ ! -f "$base_flag" ]; then
    baseline=$(jq -c --arg r "$week_reset" '
      if (.resets_at | tostring) == $r then
        {resets_at: $r, pct: (if .k then ([(.base // 0) + .k * (.mac_cost // 0), 0] | max) else (.mine // 0) end)}
      else null end' "$OLD_SPLIT" 2>/dev/null || echo null)
  fi

  payload=$(printf '%s' "$input" | jq -c --arg d "$LIMITS_DEVICE" --arg p "$POOL" --argjson b "${baseline:-null}" '
    def lim: if . == null or .used_percentage == null then null
             else {pct: .used_percentage, resets_at: (.resets_at | tonumber? // null)} end;
    {device: $d, pool: $p, session_id: .session_id, cost: (.cost.total_cost_usd // null),
     limits: {seven_day: (.rate_limits.seven_day | lim), five_hour: (.rate_limits.five_hour | lim)}}
    + (if $b then {baseline: $b} else {} end)' 2>/dev/null)

  if [ -n "$payload" ]; then
    (
      tmp="$CACHE.tmp.$$"
      if curl -sf -m 10 -X POST "$LIMITS_URL/report" \
           -H "Authorization: Bearer $LIMITS_TOKEN" -H 'Content-Type: application/json' \
           --data-binary "$payload" -o "$tmp" && jq -e '.windows' "$tmp" >/dev/null 2>&1; then
        mv -f "$tmp" "$CACHE"
        rm -f "$ERR"
        [ "$baseline" != "null" ] && touch "$base_flag"
      else
        rm -f "$tmp"
        date +%s > "$ERR"
      fi
    ) </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null
  fi

  # изредка чистим отметки о старых сессиях
  [ $(( now % 50 )) -eq 0 ] && find "$SENT" -type f -mtime +2 -delete 2>/dev/null
fi

# --- 2. рендер сегмента ---------------------------------------------------------
# Ничего не захардкожено: состав участников, имена, порядок и цвета приходят с сервера (.participants),
# доли — из .windows.seven_day.segments. Общий % берём из свежего входа (он новее кеша),
# разница с распределённым = «ещё распределяется» (▒).
week_pct=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
week_reset=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.resets_at // empty | tostring')
[ -z "$week_pct" ] && exit 0
[ -f "$CACHE" ] || exit 0

W=20  # шкала 20 клеток (1 клетка = 5%)
rendered=$(jq -r --arg me "$LIMITS_DEVICE" --arg r "$week_reset" --argjson total "$week_pct" --argjson W "$W" '
  def E(c): "\u001b[" + c + "m";
  def R: "\u001b[0m";
  # цвета совпадают с квадратиками бота: 🟦 🟧 🟩 🟨 🟫, web 🟪, «до синхронизации» ⬛
  def code: if .kind == "device" then (["38;5;39","38;5;208","38;5;41","38;5;220","38;5;137"][.color % 5])
            elif .kind == "web" then "38;5;141" elif .kind == "prior" then "38;5;244" else "38;5;250" end;
  def lbl: if .kind == "device" or .kind == "unknown" then (.name | if length > 14 then .[0:13] + "…" else . end)
           else (.short // .name) end;
  def rep(n; ch): if n > 0 then [range(n)] | map(ch) | join("") else "" end;
  def cells: (.pct * $W / 100 | round) as $c | if .pct >= 0.5 and $c < 1 then 1 else $c end;

  .windows.seven_day as $w
  | if $w == null or $w.segments == null or (($w.resets_at - ($r | tonumber? // 0)) | fabs) > 1800 then empty else
    ((.participants // []) | map({key: .id, value: .}) | from_entries) as $by
    | [$w.segments[] | ($by[.id] // {id: .id, name: .id, kind: "unknown"}) + {pct: .pct}] as $seg
    # своя машина видна всегда, даже с 0%
    | (if any($seg[]; .id == $me) then $seg
       else [($by[$me] // {id: $me, name: $me, kind: "device", color: 0}) + {pct: 0}] + $seg end) as $seg
    | ([$total - ($seg | map(.pct) | add // 0), 0] | max) as $pend
    | ($seg + [{id: "", kind: "pending", pct: $pend}] | map(. + {c: cells})) as $items0
    | ($total * $W / 100 | round) as $used
    # подгоняем сумму клеток к общему %: сначала «распределяется», потом самый крупный сегмент
    | ($items0 | until((map(.c) | add) <= $used or (any(.[]; (.kind == "pending" and .c > 0) or .c > 1) | not);
        if any(.[]; .kind == "pending" and .c > 0) then map(if .kind == "pending" then .c -= 1 else . end)
        else (to_entries | map(select(.value.c > 1)) | max_by(.value.c).key) as $i | .[$i].c -= 1 end)) as $items
    | ([$W - ($items | map(.c) | add), 0] | max) as $free
    | ($items | map(if .kind == "pending" then E("2") + rep(.c; "▒") + R else E(code) + rep(.c; "█") + R end) | join("")
       + E("2") + rep($free; "░") + R) as $bar
    | ($items | map(select(.kind != "pending" and (.id == $me or .pct >= 0.5)))
       | map((if .id == $me then E("1;" + code) else E(code) end) + lbl + " " + (.pct | round | tostring) + "%" + R)
       | join(" ")) as $labels
    | [($total | round), $bar + " " + $labels] | @tsv
    end' "$CACHE" 2>/dev/null)
[ -z "$rendered" ] && exit 0
IFS=$'\t' read -r total_i body <<< "$rendered"
free_i=$(( 100 - total_i ))

RESET="\033[0m"; DIM="\033[2m"
reset_str=""
if [ -n "$week_reset" ]; then
  diff=$(( ${week_reset%.*} - now ))
  if   [ "$diff" -le 0 ];    then reset_str=" ~скоро"
  elif [ "$diff" -lt 3600 ]; then reset_str=" ~$(( diff / 60 ))м"
  elif [ "$diff" -lt 86400 ]; then reset_str=$(printf " ~%dч%02dм" $(( diff / 3600 )) $(( (diff % 3600) / 60 )))
  else reset_str=$(printf " ~%dд%dч" $(( diff / 86400 )) $(( (diff % 86400) / 3600 ))); fi
fi

warn=""
if   [ "$total_i" -ge 80 ]; then warn="\033[1;31m [!!]\033[0m"
elif [ "$total_i" -ge 50 ]; then warn="\033[1;33m [~50%]\033[0m"; fi
sync_str=""; [ -f "$ERR" ] && sync_str=" \033[33m⚠sync${RESET}"

printf '%s' "$(printf '%b' "${DIM}")$LABEL$(printf '%b' "${RESET}") "
printf '%s' "$body"
printf '%b' " ${DIM}своб ${free_i}%${reset_str}${RESET}${warn}${sync_str}"
