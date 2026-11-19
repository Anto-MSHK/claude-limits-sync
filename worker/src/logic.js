// Чистая логика учёта: без Cloudflare-зависимостей, чтобы её можно было тестировать в node.
//
// Пулы. Каждый пул — отдельный набор лимитов со своими окнами: 'claude' (подписка Claude),
// 'zai' (Z.ai GLM Coding Plan) и т. п. Пулы считаются независимо. Машины и их имена — общие
// для всех пулов, поэтому одна машина везде называется и окрашивается одинаково.
//
// Идея атрибуции (внутри пула):
//   Лимит общий на аккаунт, и каждая машина видит один и тот же общий %.
//   Зато каждая машина точно знает, сколько она потратила сама: «вес трат» сессии (для Claude —
//   cost.total_cost_usd, для Z.ai — стоимость или токены). Сервер копит траты по машинам (pend)
//   между изменениями общего %. Когда общий % вырос на Δ, Δ делится между машинами пропорционально
//   их тратам за этот промежуток, и копилка обнуляется.
//   Если прирост есть, а трат никто не прислал (например, отчёт другой машины ещё не дошёл), прирост
//   ждёт в hold до HOLD_TTL секунд. Пришли траты — hold делится по ним. Не пришли — уходит в "web"
//   (всё, что не шлёт отчёты: claude.ai, телефон, другие клиенты того же ключа).

export const KINDS = ['seven_day', 'five_hour'];
export const WEB = 'web';     // расход, который не объясняется ни одной машиной
export const PRIOR = 'prior'; // то, что было потрачено до запуска синхронизации
export const DEFAULT_POOL = 'claude';
export const POOL_RE = /^[a-z0-9_-]{1,16}$/;
export const MAX_POOLS = 6;

// Подписи пулов. Неизвестный пул тоже работает — просто называется своим id.
export const POOL_META = {
  claude: { title: 'Claude', web: 'web / телефон', webShort: 'web' },
  zai: { title: 'Z.ai', web: 'другие клиенты', webShort: 'др' },
};
export const poolMeta = (id) => POOL_META[id] ?? { title: id, web: 'другое', webShort: 'др' };

const SAME_WINDOW = 1800;          // resets_at может «плавать»; ближе 30 минут считаем тем же окном
const HOLD_TTL = 600;              // сколько ждать трат, прежде чем отдать необъяснённый прирост в web
const SESSION_TTL = 8 * 86400;     // сколько помнить последнюю стоимость сессии
const NEW_SESSION_MAX_COST = 0.5;  // впервые увиденную сессию «дороже» этого считаем начатой до синхронизации
const HISTORY_KEEP = 12;
const EPS = 1e-9;

export const emptyPool = () => ({ windows: {}, sessions: {}, history: [], devices: {} });
export const emptyState = () => ({ v: 2, pools: {}, devices: {} });

/** Старый формат (один пул без обёртки) → пулы. Вызывается при загрузке состояния. */
export function migrate(s) {
  if (!s) return emptyState();
  if (s.v === 2) return s;
  const devices = {};
  const poolDevices = {};
  for (const [id, d] of Object.entries(s.devices || {})) {
    devices[id] = { ...d };
    poolDevices[id] = { first_seen: d.first_seen, last_seen: d.last_seen };
  }
  return {
    v: 2,
    devices,
    pools: { [DEFAULT_POOL]: { windows: s.windows || {}, sessions: s.sessions || {}, history: s.history || [], devices: poolDevices } },
  };
}

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };

function newWindow(resetsAt) {
  return { resets_at: resetsAt, total: 0, alloc: {}, pend: {}, hold: 0, hold_t: 0, baselines: {}, notified: {} };
}

// Раздать прирост delta (плюс всё, что ждёт в hold) по накопленным тратам.
function distribute(w, delta, now) {
  const P = sum(w.pend);
  const amount = delta + w.hold;
  if (amount <= EPS) return;
  if (P > EPS) {
    for (const [d, c] of Object.entries(w.pend)) add(w.alloc, d, (amount * c) / P);
    w.pend = {};
    w.hold = 0;
  } else {
    if (w.hold <= EPS) w.hold_t = now;
    w.hold = amount;
  }
}

export function expireHolds(s, now) {
  for (const p of Object.values(s.pools)) {
    for (const w of Object.values(p.windows)) {
      if (w.hold > EPS && now - w.hold_t > HOLD_TTL) {
        add(w.alloc, WEB, w.hold);
        w.hold = 0;
      }
    }
  }
}

function archive(p, kind, w) {
  if (kind !== 'seven_day') return;
  p.history.push({ resets_at: w.resets_at, total: w.total, alloc: { ...w.alloc, ...(w.hold > EPS ? { [WEB]: (w.alloc[WEB] || 0) + w.hold } : {}) } });
  p.history = p.history.slice(-HISTORY_KEEP);
}

/**
 * Применить отчёт машины.
 * r = { device, pool?, session_id?, cost?, limits: { seven_day?: {pct, resets_at}, five_hour?: {...} },
 *       baseline?: { resets_at, pct } }   // старая оценка доли машины в текущей неделе (миграция)
 * Возвращает false, если пул новый, а лимит пулов исчерпан.
 */
export function applyReport(s, r, now) {
  const dev = r.device;
  const poolId = r.pool || DEFAULT_POOL;
  if (!s.pools[poolId]) {
    if (Object.keys(s.pools).length >= MAX_POOLS) return false;
    s.pools[poolId] = emptyPool();
  }
  const p = s.pools[poolId];

  s.devices[dev] = { ...(s.devices[dev] || {}), last_seen: now };
  if (!s.devices[dev].first_seen) s.devices[dev].first_seen = now;
  p.devices[dev] = { ...(p.devices[dev] || {}), last_seen: now };
  if (!p.devices[dev].first_seen) p.devices[dev].first_seen = now;

  // 1. Сколько эта машина потратила с прошлого отчёта этой сессии.
  let dc = 0;
  const cost = num(r.cost);
  if (r.session_id && cost !== null && cost >= 0) {
    const prev = p.sessions[r.session_id];
    if (!prev) dc = cost <= NEW_SESSION_MAX_COST ? cost : 0;
    else if (cost >= prev.c) dc = cost - prev.c;
    else dc = cost; // процесс перезапущен (resume) — счётчик стоимости начался заново
    p.sessions[r.session_id] = { d: dev, c: cost, t: now };
  }
  for (const [sid, v] of Object.entries(p.sessions)) if (now - v.t > SESSION_TTL) delete p.sessions[sid];

  // 2. Окна лимитов.
  for (const kind of KINDS) {
    const l = r.limits?.[kind];
    const pct = num(l?.pct);
    const resetsAt = num(l?.resets_at);
    let w = p.windows[kind];
    let fresh = pct !== null && resetsAt !== null;

    if (fresh && w && resetsAt < w.resets_at - SAME_WINDOW) fresh = false; // машина ещё видит прошлое окно
    if (fresh && (!w || resetsAt > w.resets_at + SAME_WINDOW)) {
      const first = !w;
      if (w) archive(p, kind, w);
      w = p.windows[kind] = newWindow(resetsAt);
      // Самое первое окно после запуска: всё, что уже потрачено, — «до синхронизации».
      if (first && pct > 0) { w.alloc[PRIOR] = pct; w.total = pct; }
    }
    if (!w) continue;
    if (now >= w.resets_at + 60 && !fresh) continue; // окно истекло, а новое ещё не пришло

    if (dc > EPS) add(w.pend, dev, dc);
    if (fresh && pct > w.total + EPS) {
      const delta = pct - w.total;
      w.total = pct;
      distribute(w, delta, now);
    } else if (w.hold > EPS) {
      distribute(w, 0, now); // прирост ждал трат — возможно, они пришли в этом отчёте
    }
  }

  // 3. Миграция: машина присылает свою старую оценку доли — забираем её из «до синхронизации».
  const b = r.baseline;
  const w7 = p.windows.seven_day;
  if (b && w7 && !w7.baselines[dev] && Math.abs((num(b.resets_at) ?? -1e12) - w7.resets_at) <= SAME_WINDOW) {
    const want = Math.max(0, num(b.pct) ?? 0);
    const take = Math.min(want, w7.alloc[PRIOR] || 0);
    if (take > EPS) {
      w7.alloc[PRIOR] -= take;
      add(w7.alloc, dev, take);
      if (w7.alloc[PRIOR] <= EPS) delete w7.alloc[PRIOR];
    }
    w7.baselines[dev] = true;
  }

  expireHolds(s, now);
  return true;
}

const r1 = (x) => Math.round(x * 10) / 10;

// --- Участники лимита -------------------------------------------------------------
// Единый источник правды для бота и статус-лайнов: порядок, имена, цвета.
// Цвет машины — по её месту среди ВСЕХ машин (по первому отчёту), поэтому он одинаков во всех пулах.
export const PALETTE_SIZE = 5;
export const NAME_MAX = 20;

function deviceList(s) {
  return Object.entries(s.devices)
    .sort((a, b) => (a[1].first_seen || 0) - (b[1].first_seen || 0))
    .map(([id, v], i) => ({ id, name: v.name || id, kind: 'device', color: i % PALETTE_SIZE, last_seen: v.last_seen }));
}

/** Все машины (без web/prior) — для /devices и /rename. */
export const allDevices = (s) => deviceList(s);

/** Участники пула: его машины, затем web и «до синхронизации». */
export function participants(s, poolId = DEFAULT_POOL) {
  const p = s.pools[poolId];
  const meta = poolMeta(poolId);
  const devs = deviceList(s)
    .filter((d) => p?.devices[d.id])
    .map((d) => ({ ...d, last_seen: p.devices[d.id].last_seen }));
  return [
    ...devs,
    { id: WEB, name: meta.web, short: meta.webShort, kind: 'web' },
    { id: PRIOR, name: 'до синхронизации', short: 'ранее', kind: 'prior' },
  ];
}

/** Привести пользовательское имя к безопасному виду: без управляющих символов и HTML, ≤ NAME_MAX. */
export function cleanName(raw) {
  const n = String(raw ?? '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f<>&"`\\]/g, '').trim();
  if (!n || [...n].length > NAME_MAX) return null;
  return n;
}

/** Найти машину по id или текущему имени (без учёта регистра). */
export function findDevice(s, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return null;
  for (const id of Object.keys(s.devices)) if (id.toLowerCase() === q) return id;
  for (const [id, v] of Object.entries(s.devices)) if ((v.name || '').toLowerCase() === q) return id;
  return null;
}

export function renameDevice(s, id, raw) {
  const name = cleanName(raw);
  if (!name || !s.devices[id]) return null;
  const taken = Object.entries(s.devices).some(([other, v]) => other !== id && (v.name || other).toLowerCase() === name.toLowerCase());
  if (taken) return null;
  s.devices[id].name = name;
  return name;
}

/** Представление одного пула: участники + окна с долями в порядке участников. */
export function poolView(s, poolId, now) {
  const p = s.pools[poolId] ?? emptyPool();
  const parts = participants(s, poolId);
  const rank = new Map(parts.map((x, i) => [x.id, i]));
  const windows = {};
  for (const [kind, w] of Object.entries(p.windows)) {
    const segments = Object.entries(w.alloc)
      .filter(([, v]) => v > 0.005)
      .sort((a, b) => (rank.get(a[0]) ?? 1e9) - (rank.get(b[0]) ?? 1e9))
      .map(([id, v]) => ({ id, pct: r1(v) }));
    windows[kind] = {
      resets_at: w.resets_at,
      expired: now >= w.resets_at,
      total: r1(w.total),
      segments,
      pending: r1(Math.max(0, w.total - sum(w.alloc))),
    };
  }
  return { now, pool: poolId, title: poolMeta(poolId).title, participants: parts, windows };
}

/** Все пулы (для бота). Claude первым, остальные по алфавиту. */
export function view(s, now) {
  const ids = Object.keys(s.pools).sort((a, b) => (a === DEFAULT_POOL ? -1 : b === DEFAULT_POOL ? 1 : a.localeCompare(b)));
  return { now, devices: allDevices(s), pools: ids.map((id) => poolView(s, id, now)) };
}

/**
 * Какие уведомления пора отправить. Помечает их в состоянии как отправленные.
 * Возвращает [{key, pool, kind, ...data}] — текст делает format.js.
 */
export function dueNotifications(s, cfg, now) {
  const out = [];
  for (const [poolId, p] of Object.entries(s.pools)) {
    const w7 = p.windows.seven_day;
    const w5 = p.windows.five_hour;

    if (w7 && cfg.notify_week) {
      const left = w7.resets_at - now;
      const free = 100 - w7.total;
      if (left <= 0) {
        if (!w7.notified.reset) {
          w7.notified.reset = true;
          out.push({ key: 'week_reset', pool: poolId, kind: 'seven_day', total: w7.total, alloc: { ...w7.alloc } });
        }
      } else {
        // Если сервер впервые видит окно уже близко к сбросу — шлём только самое «срочное».
        const steps = [
          { h: 24, minFree: 20 },
          { h: 6, minFree: 10 },
          { h: 1, minFree: 3 },
        ];
        let pick = null;
        for (const st of steps) {
          const key = `week_${st.h}h`;
          if (left <= st.h * 3600 && !w7.notified[key]) {
            w7.notified[key] = true;
            if (free >= st.minFree) pick = { key, pool: poolId, kind: 'seven_day', left, free, total: w7.total };
          }
        }
        if (pick) out.push(pick);
        if (w7.total >= 90 && !w7.notified.high) {
          w7.notified.high = true;
          out.push({ key: 'week_high', pool: poolId, kind: 'seven_day', left, free, total: w7.total });
        }
      }
    }

    if (w5 && cfg.notify_5h) {
      const left = w5.resets_at - now;
      const free = 100 - w5.total;
      const weekFree = w7 && now < w7.resets_at ? 100 - w7.total : 100;
      if (left > 0 && left <= 30 * 60 && !w5.notified.soon) {
        w5.notified.soon = true;
        if (free >= 40 && weekFree >= 10) out.push({ key: '5h_soon', pool: poolId, kind: 'five_hour', left, free, total: w5.total, weekFree });
      }
    }
  }
  return out;
}
