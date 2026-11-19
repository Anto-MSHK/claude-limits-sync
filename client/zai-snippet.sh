# Вставить в ~/.claude-zai/statusline-command.sh ПЕРЕД блоком «недельный лимит»
# (после того как посчитаны F_cur/F_usage/F_reset и W_cur/W_usage/W_reset),
# а строку  if [ -n "$W_usage" ]; then  этого блока заменить на  elif [ -n "$W_usage" ]; then

# --- синхронизация между машинами (~/Projects/claude-limits-sync, пул zai) ---
# Собираем вход в формате статус-лайна Claude: проценты окон из квоты Z.ai (кредиты/лимит, дробные),
# «вес трат» сессии — cost.total_cost_usd, а если Claude Code не считает стоимость для GLM — токены сессии.
# Старую оценку (.device-week-counter.json) как baseline НЕ шлём: она записывает на эту машину весь
# прирост недели, включая чужой. Потраченное до синхронизации честно остаётся «ранее».
# Без конфига клиент молчит, и работает локальная оценка ниже.
sync_seg=""
if [ -f "$HOME/.claude/limits-sync/config" ] && [ -n "$W_usage" ] && [ "$W_usage" -gt 0 ] && [ "$F_usage" -gt 0 ]; then
  sync_seg=$(printf '%s' "$input" | jq -c \
      --argjson fc "$F_cur" --argjson fu "$F_usage" --argjson fr "${F_reset:-0}" \
      --argjson wc "$W_cur" --argjson wu "$W_usage" --argjson wr "${W_reset:-0}" '
    ((.cost.total_cost_usd // 0)) as $cost
    | (((.context_window.total_input_tokens // 0) + (.context_window.total_output_tokens // 0)) / 1000000) as $tok
    | {session_id: .session_id,
       cost: {total_cost_usd: (if $cost > 0 then $cost else $tok end)},
       rate_limits: {
         five_hour: {used_percentage: ($fc * 100 / $fu), resets_at: $fr},
         seven_day: {used_percentage: ($wc * 100 / $wu), resets_at: $wr}}}' 2>/dev/null \
    | LIMITS_POOL=zai LIMITS_LABEL=нед bash "$HOME/.claude/limits-sync/limits-sync.sh" 2>/dev/null)
fi

# --- недельный лимит: шкала [свой зелёным + чужой голубым + остаток серым] ---
if [ -n "$sync_seg" ]; then
  parts+=("$sync_seg")
