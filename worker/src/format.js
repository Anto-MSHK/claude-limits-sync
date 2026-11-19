// Тексты бота. Ничего не знает о конкретных машинах: имена, порядок и цвета берёт из participants.

const DEVICE_SQUARES = ['🟦', '🟧', '🟩', '🟨', '🟫']; // индекс = participant.color (logic.PALETTE_SIZE)
const KIND_SQUARE = { web: '🟪', prior: '⬛' };
const FREE_SQUARE = '⬜';
const PENDING_SQUARE = '▫️';

export const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function fmtLeft(sec) {
  if (sec <= 0) return 'сейчас';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${String(m).padStart(2, '0')}м`;
  return `${Math.max(1, m)}м`;
}

export function fmtWhen(epoch, tz) {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz,
  }).format(new Date(epoch * 1000));
}

const fmtAgo = (sec) => (sec < 90 ? 'только что' : `${fmtLeft(sec)} назад`);

export const pct = (x) => `${(x >= 10 ? Math.round(x) : Math.round(x * 10) / 10).toString().replace('.', ',')}%`;

// Справочник участников: id → {square, name}. Неизвестный id (машина, которой больше нет) — серым по id.
function directory(participants) {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const rank = new Map(participants.map((p, i) => [p.id, i]));
  return {
    square: (id) => {
      const p = byId.get(id);
      if (!p) return '◻️';
      return p.kind === 'device' ? DEVICE_SQUARES[p.color % DEVICE_SQUARES.length] : KIND_SQUARE[p.kind];
    },
    name: (id) => esc(byId.get(id)?.name ?? id),
    sort: (entries) => entries.slice().sort((a, b) => (rank.get(a[0]) ?? 1e9) - (rank.get(b[0]) ?? 1e9)),
  };
}

// Полоска из 10 клеток: наибольший остаток + заметная доля (≥0,5%) видна хотя бы одной клеткой.
function bar(segments, cells = 10) {
  const raw = segments.map((s) => ({ ...s, exact: (s.value * cells) / 100 }));
  raw.forEach((s) => { s.n = Math.floor(s.exact); });
  let rest = cells - raw.reduce((a, s) => a + s.n, 0);
  [...raw].sort((a, b) => (b.exact - b.n) - (a.exact - a.n)).forEach((s) => {
    if (rest > 0 && s.exact - s.n > 0) { s.n++; rest--; }
  });
  for (const s of raw) {
    if (!s.free && s.value >= 0.5 && s.n === 0) {
      const donor = [...raw].sort((a, b) => (b.free === true) - (a.free === true) || b.n - a.n)[0];
      if (donor.n > 1) { donor.n--; s.n = 1; }
    }
  }
  return raw.map((s) => s.square.repeat(Math.max(0, s.n))).join('');
}

function windowBlock(title, w, dir, now, tz) {
  if (!w) return `<b>${title}</b>\nнет данных`;
  if (w.expired) return `<b>${title}</b> — 🔄 сброшен ${fmtWhen(w.resets_at, tz)}\nсвободно 100%`;

  const free = Math.max(0, 100 - w.total);
  const segs = [
    ...w.segments.map((x) => ({ value: x.pct, square: dir.square(x.id) })),
    ...(w.pending > 0 ? [{ value: w.pending, square: PENDING_SQUARE }] : []),
    { value: free, square: FREE_SQUARE, free: true },
  ];
  const lines = [
    `<b>${title}</b> — ${pct(w.total)} · сброс через <b>${fmtLeft(w.resets_at - now)}</b>`,
    `<i>${fmtWhen(w.resets_at, tz)}</i>`,
    bar(segs),
    '',
    ...w.segments.map((x) => `${dir.square(x.id)} ${dir.name(x.id)} — ${pct(x.pct)}`),
  ];
  if (w.pending > 0.05) lines.push(`${PENDING_SQUARE} ещё распределяется — ${pct(w.pending)}`);
  lines.push(`${FREE_SQUARE} свободно — <b>${pct(free)}</b>`);
  return lines.join('\n');
}

function poolBlock(pv, tz) {
  const now = pv.now;
  const dir = directory(pv.participants);
  const w7 = pv.windows.seven_day;
  const parts = [`━━ <b>${esc(pv.title)}</b> ━━`, windowBlock('Неделя', w7, dir, now, tz)];
  if (w7 && !w7.expired) {
    const left = w7.resets_at - now;
    const free = 100 - w7.total;
    if (free > 0 && left > 3600) {
      const perDay = left >= 86400 ? `~${pct(free / (left / 86400))} в день` : `~${pct(free / (left / 3600))} в час`;
      parts.push(`🎯 Чтобы выбрать всё до сброса: ${perDay}`);
    }
  }
  parts.push(windowBlock('5 часов', pv.windows.five_hour, dir, now, tz));
  return parts.join('\n\n');
}

/** v = view(): { now, devices, pools: [poolView] } */
export function renderLimits(v, tz) {
  if (!v.pools.length) return '📊 Данных пока нет — они появятся после первого отчёта статус-лайна.';
  const parts = ['📊 <b>Лимиты</b>', ...v.pools.map((pv) => poolBlock(pv, tz))];
  const dir = directory(v.devices);
  const devs = v.devices.map((d) => `${dir.square(d.id)} ${dir.name(d.id)}: ${fmtAgo(v.now - d.last_seen)}`);
  if (devs.length) parts.push(`<i>Последний отчёт</i>\n${devs.join('\n')}`);
  return parts.join('\n\n');
}

export function renderDevices(devices) {
  const dir = directory(devices);
  if (!devices.length) return 'Машин пока нет — они появятся после первого отчёта статус-лайна.';
  const rows = devices.map((p) => `${dir.square(p.id)} <b>${dir.name(p.id)}</b>${p.name !== p.id ? ` <i>(id: ${esc(p.id)})</i>` : ''}`);
  return `🖥 <b>Машины</b>\n\n${rows.join('\n')}\n\nПереименовать: /rename или <code>/rename id Новое имя</code>`;
}

/** pools = [{ title, history, participants }] */
export function renderHistory(pools, tz) {
  const blocks = pools.filter((p) => p.history.length).map((p) => {
    const dir = directory(p.participants);
    const rows = p.history.slice().reverse().map((h) => {
      const items = dir.sort(Object.entries(h.alloc))
        .filter(([, x]) => x >= 0.05)
        .map(([id, x]) => `${dir.square(id)} ${dir.name(id)} ${pct(x)}`)
        .join(', ');
      return `<b>до ${fmtWhen(h.resets_at, tz)}</b> — ${pct(h.total)}\n${items || '—'}`;
    });
    return `━━ <b>${esc(p.title)}</b> ━━\n\n${rows.join('\n\n')}`;
  });
  if (!blocks.length) return 'Истории пока нет — она появится после первого недельного сброса.';
  return `🗂 <b>Прошлые недели</b>\n\n${blocks.join('\n\n')}`;
}

export function renderNotification(n, participants, title, tz) {
  const dir = directory(participants);
  const t = `<b>${esc(title)}</b> · `;
  switch (n.key) {
    case 'week_24h':
    case 'week_6h':
    case 'week_1h': {
      const hours = Math.max(n.left / 3600, 0.25);
      return `⏳ ${t}<b>до сброса недельного лимита ${fmtLeft(n.left)}</b>\n`
        + `Свободно <b>${pct(n.free)}</b> — это ~${pct(n.free / hours)} в час.\n`
        + 'Не пропадать же добру — самое время загрузить работой.';
    }
    case 'week_high':
      return `⚠️ ${t}<b>недельный лимит почти исчерпан: ${pct(n.total)}</b>\nОсталось ${pct(n.free)}, сброс через ${fmtLeft(n.left)}.`;
    case 'week_reset': {
      const items = dir.sort(Object.entries(n.alloc))
        .filter(([, x]) => x >= 0.05)
        .map(([id, x]) => `${dir.square(id)} ${dir.name(id)} — ${pct(x)}`)
        .join('\n');
      return `🔄 ${t}<b>недельный лимит сброшен</b>\nИтог недели: ${pct(n.total)}\n${items}`;
    }
    case '5h_soon':
      return `⏱ ${t}<b>5-часовое окно сбросится через ${fmtLeft(n.left)}</b>\n`
        + `Использовано ${pct(n.total)}, свободно ${pct(n.free)} (за неделю свободно ${pct(n.weekFree)}).`;
    default:
      return n.key;
  }
}
