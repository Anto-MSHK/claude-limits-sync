import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, applyReport, view, dueNotifications, expireHolds, participants, renameDevice, findDevice, cleanName, migrate, adjustShare } from '../src/logic.js';

const R7 = 2_000_000_000; // resets_at недельного окна
const R5 = 1_999_990_000;
const rep = (device, sid, cost, p7, p5 = null, extra = {}) => ({
  device, session_id: sid, cost,
  limits: { seven_day: { pct: p7, resets_at: R7 }, ...(p5 != null ? { five_hour: { pct: p5, resets_at: R5 } } : {}) },
  ...extra,
});
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('первое окно: уже потраченное уходит в prior', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0.1, 50), 1000);
  const w = s.pools.claude.windows.seven_day;
  assert.equal(w.total, 50);
  assert.equal(w.alloc.prior, 50);
  assert.equal(w.pend.Mac, 0.1);
});

test('прирост делится пропорционально тратам обеих машин', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Win', 'b', 0, 10), 1001);
  applyReport(s, rep('Mac', 'a', 3, 10), 1010); // Mac потратил $3
  applyReport(s, rep('Win', 'b', 1, 14), 1020); // Win потратил $1, общий +4%
  const a = s.pools.claude.windows.seven_day.alloc;
  close(a.Mac, 3);
  close(a.Win, 1);
  assert.deepEqual(s.pools.claude.windows.seven_day.pend, {});
});

test('прирост без трат ждёт в hold и уходит машине, чьи траты пришли позже', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Win', 'b', 0, 10), 1000);
  applyReport(s, rep('Win', 'b', 0, 12), 1100); // Win увидел +2%, но сам не тратил
  assert.equal(s.pools.claude.windows.seven_day.hold, 2);
  applyReport(s, rep('Mac', 'a', 0.7, 12), 1200); // а это траты Mac
  close(s.pools.claude.windows.seven_day.alloc.Mac, 2);
  assert.equal(s.pools.claude.windows.seven_day.hold, 0);
});

test('необъяснённый прирост через 10 минут уходит в web', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Mac', 'a', 0, 15), 1100);
  expireHolds(s, 1100 + 601);
  close(s.pools.claude.windows.seven_day.alloc.web, 5);
});

test('устаревший отчёт с меньшим % не уменьшает итог', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 20), 1000);
  applyReport(s, rep('Win', 'b', 0, 18), 1010);
  assert.equal(s.pools.claude.windows.seven_day.total, 20);
});

test('новая сессия с большой стоимостью не считается свежими тратами', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'old', 25, 10), 1000);
  assert.equal(s.pools.claude.windows.seven_day.pend.Mac, undefined);
  applyReport(s, rep('Mac', 'old', 26, 10), 1010);
  close(s.pools.claude.windows.seven_day.pend.Mac, 1);
});

test('перезапуск сессии (стоимость упала) — считаем с нуля', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Mac', 'a', 5, 10), 1010);
  applyReport(s, rep('Mac', 'a', 0.4, 10), 1020);
  close(s.pools.claude.windows.seven_day.pend.Mac, 5.4);
});

test('смена окна: старое уходит в историю, новое считается с нуля', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 40), 1000);
  applyReport(s, rep('Mac', 'a', 1, 42), 1010);
  const next = { device: 'Win', session_id: 'b', cost: 0.2, limits: { seven_day: { pct: 1, resets_at: R7 + 7 * 86400 } } };
  applyReport(s, next, R7 + 10);
  assert.equal(s.pools.claude.history.length, 1);
  assert.equal(s.pools.claude.history[0].total, 42);
  const w = s.pools.claude.windows.seven_day;
  assert.equal(w.resets_at, R7 + 7 * 86400);
  close(w.alloc.Win, 1);
  assert.equal(w.alloc.prior, undefined);
});

test('baseline переносит старую оценку из prior в машину', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 50, null, { baseline: { resets_at: String(R7), pct: 25.1 } }), 1000);
  close(s.pools.claude.windows.seven_day.alloc.Mac, 25.1);
  close(s.pools.claude.windows.seven_day.alloc.prior, 24.9);
  applyReport(s, rep('Win', 'b', 0, 50, null, { baseline: { resets_at: R7, pct: 30 } }), 1001);
  close(s.pools.claude.windows.seven_day.alloc.Win, 24.9);
  assert.equal(s.pools.claude.windows.seven_day.alloc.prior, undefined);
  // повторный baseline игнорируется
  applyReport(s, rep('Win', 'b', 0, 50, null, { baseline: { resets_at: R7, pct: 30 } }), 1002);
  close(s.pools.claude.windows.seven_day.alloc.Win, 24.9);
});

test('5-часовое окно считается отдельно', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10, 0), 1000);
  applyReport(s, rep('Mac', 'a', 2, 12, 8), 1010);
  close(s.pools.claude.windows.five_hour.alloc.Mac, 8);
  close(s.pools.claude.windows.seven_day.alloc.Mac, 2);
});

test('view: pending = итог минус распределённое', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Mac', 'a', 0, 13), 1010);
  const v = view(s, 1010);
  assert.equal(v.pools[0].windows.seven_day.pending, 3);
});

test('уведомления: самое срочное, каждое по одному разу', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 40), 1000);
  const cfg = { notify_week: true, notify_5h: true };
  let n = dueNotifications(s, cfg, R7 - 5 * 3600); // 5ч до сброса: 24h и 6h подходят — шлём только 6h
  assert.deepEqual(n.map((x) => x.key), ['week_6h']);
  assert.equal(dueNotifications(s, cfg, R7 - 5 * 3600).length, 0);
  n = dueNotifications(s, cfg, R7 - 1800);
  assert.deepEqual(n.map((x) => x.key), ['week_1h']);
  n = dueNotifications(s, cfg, R7 + 60);
  assert.deepEqual(n.map((x) => x.key), ['week_reset']);
});

test('почти выбранный лимит: вместо «используй» — предупреждение', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 95), 1000);
  const n = dueNotifications(s, { notify_week: true }, R7 - 3 * 3600);
  assert.deepEqual(n.map((x) => x.key), ['week_high']);
});

test('участники: машины по порядку появления, затем web и prior; любое число машин', () => {
  const s = emptyState();
  for (const [i, d] of ['Mac', 'Win', 'Laptop', 'Server', 'Pi', 'Six'].entries()) applyReport(s, rep(d, `s${i}`, 0, 10), 1000 + i);
  const p = participants(s);
  assert.deepEqual(p.map((x) => x.id), ['Mac', 'Win', 'Laptop', 'Server', 'Pi', 'Six', 'web', 'prior']);
  assert.deepEqual(p.slice(0, 6).map((x) => x.color), [0, 1, 2, 3, 4, 0]); // палитра по кругу
});

test('view: доли в порядке участников, имена из переименования', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Win', 'b', 0, 10), 1001);
  applyReport(s, rep('Win', 'b', 2, 12), 1010);
  applyReport(s, rep('Mac', 'a', 1, 13), 1020);
  renameDevice(s, 'Win', 'Домашний ПК');
  const v = view(s, 1030);
  assert.deepEqual(v.pools[0].windows.seven_day.segments.map((x) => x.id), ['Mac', 'Win', 'prior']);
  assert.equal(v.pools[0].participants.find((x) => x.id === 'Win').name, 'Домашний ПК');
  assert.equal(v.pools[0].participants.find((x) => x.id === 'Mac').name, 'Mac');
});

test('переименование: чистка, длина, уникальность, поиск по имени', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Win', 'b', 0, 10), 1001);
  assert.equal(cleanName('  Рабочий\tноут\n '), 'Рабочий ноут');
  assert.equal(cleanName('<b>x</b>'), 'bx/b');
  assert.equal(cleanName('x'.repeat(21)), null);
  assert.equal(renameDevice(s, 'Mac', 'Работа'), 'Работа');
  assert.equal(renameDevice(s, 'Win', 'работа'), null); // занято (без учёта регистра)
  assert.equal(renameDevice(s, 'Nope', 'X'), null);
  assert.equal(findDevice(s, 'РАБОТА'), 'Mac');
  assert.equal(findDevice(s, 'win'), 'Win');
});

test('пулы считаются независимо, машины и имена общие', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Win', 'b', 0, 10), 1001);
  applyReport(s, { ...rep('Win', 'z1', 0, 5), pool: 'zai' }, 1002);
  applyReport(s, { ...rep('Win', 'z1', 3, 9.5), pool: 'zai' }, 1010);
  applyReport(s, rep('Mac', 'a', 2, 12), 1020);
  close(s.pools.zai.windows.seven_day.alloc.Win, 4.5);
  assert.equal(s.pools.zai.windows.seven_day.alloc.Mac, undefined);
  close(s.pools.claude.windows.seven_day.alloc.Mac, 2);
  renameDevice(s, 'Win', 'ПК');
  const zp = participants(s, 'zai');
  assert.deepEqual(zp.map((x) => x.id), ['Win', 'web', 'prior']); // Mac в zai не отчитывался
  assert.equal(zp[0].name, 'ПК');
  assert.equal(zp[0].color, 1); // цвет как в Claude: Win — вторая машина вообще
  assert.equal(zp[1].short, 'др');
  const v = view(s, 1030);
  assert.deepEqual(v.pools.map((p) => p.pool), ['claude', 'zai']);
});

test('миграция: старое состояние одного пула становится пулом claude', () => {
  const old = {
    windows: { seven_day: { resets_at: R7, total: 54, alloc: { prior: 27.8, Mac: 26.2 }, pend: {}, hold: 0, hold_t: 0, baselines: { Mac: true }, notified: {} } },
    sessions: { x: { d: 'Mac', c: 1, t: 1000 } },
    devices: { Mac: { last_seen: 1000, first_seen: 900 } },
    history: [],
  };
  const s = migrate(old);
  assert.equal(s.v, 2);
  assert.equal(s.pools.claude.windows.seven_day.alloc.Mac, 26.2);
  assert.equal(s.devices.Mac.first_seen, 900);
  assert.ok(s.pools.claude.devices.Mac);
  assert.equal(migrate(s), s);
});

test('уведомления несут пул', () => {
  const s = emptyState();
  applyReport(s, { ...rep('Mac', 'z', 0, 40), pool: 'zai' }, 1000);
  const n = dueNotifications(s, { notify_week: true }, R7 - 3 * 3600);
  assert.deepEqual(n.map((x) => [x.pool, x.key]), [['zai', 'week_6h']]);
});

test('zai: прирост с задержкой достаётся машине, которая недавно тратила, а не «др»', () => {
  const s = emptyState();
  const z = (d, sid, c, p, t) => applyReport(s, { ...rep(d, sid, c, p), pool: 'zai' }, t);
  z('Mac', 'a', 0, 10, 1000);
  z('Mac', 'a', 2, 11, 1060);   // часть списания видна сразу — раздали, pend пуст
  z('Win', 'b', 0, 13, 1300);   // хвост +2% проявился позже, трат нет
  expireHolds(s, 1300 + 601);
  close(s.pools.zai.windows.seven_day.alloc.Mac, 3);
  assert.equal(s.pools.zai.windows.seven_day.alloc.web, undefined);
});

test('claude: тот же сценарий остаётся web (лимит обновляется без задержки)', () => {
  const s = emptyState();
  applyReport(s, rep('Mac', 'a', 0, 10), 1000);
  applyReport(s, rep('Mac', 'a', 2, 11), 1060);
  applyReport(s, rep('Win', 'b', 0, 13), 1300);
  expireHolds(s, 1300 + 601);
  close(s.pools.claude.windows.seven_day.alloc.web, 2);
});

test('zai: давние траты не забирают хвост — уходит в «др»', () => {
  const s = emptyState();
  const z = (d, sid, c, p, t) => applyReport(s, { ...rep(d, sid, c, p), pool: 'zai' }, t);
  z('Mac', 'a', 0, 10, 1000);
  z('Mac', 'a', 2, 11, 1060);
  z('Win', 'b', 0, 13, 1060 + 3600); // через час
  expireHolds(s, 1060 + 3600 + 601);
  close(s.pools.zai.windows.seven_day.alloc.web, 2);
});

test('ручная корректировка: точная доля и «остальное»', () => {
  const s = emptyState();
  const z = (d, sid, c, p, t) => applyReport(s, { ...rep(d, sid, c, p), pool: 'zai' }, t);
  z('Mac', 'a', 0, 77.2, 1000);   // prior 77.2
  z('Win', 'b', 0, 77.2, 1001);
  z('Mac', 'a', 1, 82.7, 1010);   // Mac +5.5
  s.pools.zai.windows.seven_day.alloc.web = 0.3; s.pools.zai.windows.seven_day.alloc.Mac = 5.2;
  adjustShare(s, 'zai', 'Win', 22);
  const a = s.pools.zai.windows.seven_day.alloc;
  close(a.Win, 22); close(a.prior, 55.2);
  adjustShare(s, 'zai', 'Mac', 'rest');
  close(a.Mac, 60.7); assert.equal(a.prior, undefined); assert.equal(a.web, undefined);
  close(a.Mac + a.Win, 82.7);
  // уменьшение доли возвращает излишек в «ранее»
  adjustShare(s, 'zai', 'Win', 20);
  close(a.Win, 20); close(a.prior, 2);
  assert.ok(adjustShare(s, 'zai', 'Win', 99).error);
  assert.ok(adjustShare(s, 'zai', 'Nope', 1).error);
});
