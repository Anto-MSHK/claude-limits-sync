import { DurableObject } from 'cloudflare:workers';
import {
  migrate, applyReport, expireHolds, view, poolView, dueNotifications, participants, allDevices,
  findDevice, renameDevice, poolMeta, adjustShare, NAME_MAX, POOL_META,
} from './logic.js';
import { renderLimits, renderHistory, renderNotification, renderDevices, esc } from './format.js';

// Владельцы бота: любой Telegram-аккаунт, приславший /start <API_TOKEN>. У каждого свои настройки.
//   cfg.owners = { "<chatId>": { notify_week, notify_5h, pending_rename, since } }
const defaultOwner = (now) => ({ notify_week: true, notify_5h: true, pending_rename: null, since: now });

function migrateCfg(c) {
  const cfg = { owners: {}, ...(c ?? {}) };
  if (cfg.owner != null) { // старый формат: один владелец и общие настройки
    cfg.owners[String(cfg.owner)] = {
      ...defaultOwner(0), notify_week: cfg.notify_week ?? true, notify_5h: cfg.notify_5h ?? true,
    };
    delete cfg.owner; delete cfg.notify_week; delete cfg.notify_5h; delete cfg.pending_rename;
  }
  return cfg;
}

// Уведомление → какая настройка владельца его включает.
const NOTE_FLAG = (key) => (key.startsWith('5h') ? 'notify_5h' : 'notify_week');
const nowSec = () => Math.floor(Date.now() / 1000);

const REFRESH_KB = { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'refresh' }]] };

// Один экземпляр на всё: Durable Object обрабатывает запросы последовательно,
// поэтому одновременные отчёты с разных машин не затирают друг друга.
export class LimitsHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = migrate(await ctx.storage.get('state'));
      this.cfg = migrateCfg(await ctx.storage.get('cfg'));
    });
  }

  get tz() {
    return this.env.TZ_NAME || 'Europe/Moscow';
  }

  async save() {
    await this.ctx.storage.put({ state: this.s, cfg: this.cfg });
  }

  current() {
    const now = nowSec();
    expireHolds(this.s, now);
    return view(this.s, now);
  }

  // --- API для клиентов -------------------------------------------------------

  // Клиенту нужен только его пул.
  async report(r) {
    const now = nowSec();
    if (!applyReport(this.s, r, now)) return { error: 'too many pools' };
    await this.save();
    return poolView(this.s, r.pool || 'claude', now);
  }

  async state() {
    return this.current();
  }

  // Ручная корректировка доли: { pool, device (id или имя), value: число | 'rest', kind? }
  async adjust({ pool, device, value, kind }) {
    const poolId = this.findPool(pool);
    if (!poolId) return { error: 'нет такого пула' };
    const id = findDevice(this.s, device);
    if (!id) return { error: 'нет такой машины' };
    const res = adjustShare(this.s, poolId, id, value === 'rest' ? 'rest' : Number(value), kind || 'seven_day');
    if (!res.error) await this.save();
    return { pool: poolId, device: id, ...res };
  }

  findPool(q) {
    const k = String(q ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (this.s.pools[k]) return k;
    return Object.keys(this.s.pools).find((id) => (POOL_META[id]?.title ?? id).toLowerCase().replace(/[^a-z0-9_-]/g, '') === k) ?? null;
  }

  async tick() {
    const now = nowSec();
    expireHolds(this.s, now);
    // Отмечаем уведомления отправленными один раз, а кому слать — решают настройки каждого владельца.
    const notes = dueNotifications(this.s, { notify_week: true, notify_5h: true }, now);
    await this.save();
    let sent = 0;
    for (const n of notes) {
      const text = renderNotification(n, participants(this.s, n.pool), poolMeta(n.pool).title, this.tz);
      for (const [chatId, o] of Object.entries(this.cfg.owners)) {
        if (!o[NOTE_FLAG(n.key)]) continue;
        await this.send(chatId, text, REFRESH_KB);
        sent++;
      }
    }
    return { notes: notes.length, sent };
  }

  // --- Telegram ---------------------------------------------------------------

  async tg(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.log('telegram error', method, JSON.stringify(data));
    return data;
  }

  send(chatId, text, markup) {
    return this.tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) });
  }

  owner(chatId) {
    return this.cfg.owners[String(chatId)] ?? null;
  }

  settingsMarkup(o) {
    const mark = (on) => (on ? '✅' : '❌');
    return {
      inline_keyboard: [
        [{ text: `${mark(o.notify_week)} Неделя: напоминания перед сбросом`, callback_data: 'tog:week' }],
        [{ text: `${mark(o.notify_5h)} 5 часов: напоминание за 30 мин`, callback_data: 'tog:5h' }],
      ],
    };
  }

  renameMarkup() {
    const devs = allDevices(this.s);
    return { inline_keyboard: devs.map((p) => [{ text: p.name, callback_data: `ren:${p.id}`.slice(0, 64) }]) };
  }

  async doRename(chatId, id, raw) {
    const old = allDevices(this.s).find((p) => p.id === id)?.name ?? id;
    const name = renameDevice(this.s, id, raw);
    if (!name) {
      await this.send(chatId, `Не подошло. Имя: 1–${NAME_MAX} символов, без &lt; &gt; &amp; и кавычек, и не должно совпадать с именем другой машины.`);
      return false;
    }
    const o = this.owner(chatId);
    if (o) o.pending_rename = null;
    await this.save();
    await this.send(chatId, `✅ <b>${esc(old)}</b> → <b>${esc(name)}</b>\nВ статус-лайнах обновится со следующего отчёта.`);
    return true;
  }

  async telegram(update) {
    if (update.callback_query) return this.onCallback(update.callback_query);
    const msg = update.message;
    if (!msg?.text || msg.chat?.type !== 'private') return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    const m = text.match(/^(\/\w+)(?:@\w+)?\s*(.*)$/s);
    const cmd = (m?.[1] ?? '').toLowerCase();
    const rest = (m?.[2] ?? '').trim();

    // Привязка: /start <API_TOKEN> добавляет аккаунт в владельцы (их может быть сколько угодно).
    if (cmd === '/start' && rest) {
      if (rest !== this.env.API_TOKEN) {
        await this.send(chatId, '❌ Неверный токен.');
        return;
      }
      const already = !!this.owner(chatId);
      if (!already) this.cfg.owners[String(chatId)] = defaultOwner(nowSec());
      await this.save();
      await this.send(chatId, `${already ? 'ℹ️ Этот аккаунт уже привязан.' : '✅ Аккаунт привязан.'}\n`
        + `Привязано аккаунтов: ${Object.keys(this.cfg.owners).length}.\n`
        + 'Удали сообщение с токеном из чата. /help — команды.');
      return;
    }

    const o = this.owner(chatId);
    if (!o) {
      await this.send(chatId, 'Этот аккаунт не привязан. Отправь: <code>/start API_TOKEN</code>');
      return;
    }

    // Ждём новое имя после нажатия кнопки в /rename
    if (o.pending_rename && !text.startsWith('/')) {
      await this.doRename(chatId, o.pending_rename, text);
      return;
    }
    if (o.pending_rename && cmd) { o.pending_rename = null; await this.save(); }

    switch (cmd) {
      case '/start':
      case '/help':
        await this.send(chatId, '<b>Команды</b>\n'
          + '/limits — текущие лимиты и кто сколько потратил\n'
          + '/devices — машины\n'
          + '/rename — переименовать машину\n'
          + '/history — прошлые недели\n'
          + '/settings — уведомления (у каждого аккаунта свои)\n'
          + '/unlink — отвязать этот аккаунт');
        break;
      case '/assign': { // скрытая команда: нет в меню и /help
        const w = rest.split(/\s+/);
        if (w.length < 3) {
          await this.send(chatId, 'Формат: <code>/assign пул машина проценты</code> или <code>/assign пул машина rest</code>\n'
            + `Пулы: ${Object.keys(this.s.pools).join(', ')}`);
          return;
        }
        const value = w[w.length - 1].toLowerCase().replace(',', '.');
        const r = await this.adjust({ pool: w[0], device: w.slice(1, -1).join(' '), value: value === 'rest' ? 'rest' : value });
        if (r.error) { await this.send(chatId, `❌ ${esc(r.error)}`); return; }
        await this.send(chatId, '✅ Готово. Сейчас:', null);
        await this.send(chatId, renderLimits(this.current(), this.tz), REFRESH_KB);
        break;
      }
      case '/unlink':
        delete this.cfg.owners[String(chatId)];
        await this.save();
        await this.send(chatId, '👋 Аккаунт отвязан. Привязать снова: <code>/start API_TOKEN</code>');
        break;
      case '/limits':
      case '/l':
      case '/status':
        await this.send(chatId, renderLimits(this.current(), this.tz), REFRESH_KB);
        break;
      case '/devices':
        await this.send(chatId, renderDevices(allDevices(this.s)));
        break;
      case '/rename': {
        if (rest) {
          // /rename <id или имя> <новое имя>: пробуем самые длинные префиксы как текущее имя
          const words = rest.split(/\s+/);
          for (let i = words.length - 1; i >= 1; i--) {
            const id = findDevice(this.s, words.slice(0, i).join(' '));
            if (id) { await this.doRename(chatId, id, words.slice(i).join(' ')); return; }
          }
          await this.send(chatId, 'Не нашёл такую машину. Формат: <code>/rename id Новое имя</code>, список — /devices');
          return;
        }
        const kb = this.renameMarkup();
        if (!kb.inline_keyboard.length) { await this.send(chatId, 'Машин пока нет.'); return; }
        await this.send(chatId, 'Какую машину переименовать?', kb);
        break;
      }
      case '/history':
        await this.send(chatId, renderHistory(Object.entries(this.s.pools).map(([id, p]) => ({
          title: poolMeta(id).title, history: p.history, participants: participants(this.s, id),
        })), this.tz));
        break;
      case '/settings':
        await this.send(chatId, '🔔 Уведомления для этого аккаунта', this.settingsMarkup(o));
        break;
      default:
        await this.send(chatId, renderLimits(this.current(), this.tz), REFRESH_KB);
    }
  }

  async onCallback(q) {
    const chatId = q.message?.chat?.id;
    const answer = (text) => this.tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) });
    const o = this.owner(chatId);
    if (!o) return answer('Аккаунт не привязан');

    if (q.data === 'refresh') {
      await this.tg('editMessageText', {
        chat_id: chatId, message_id: q.message.message_id,
        text: renderLimits(this.current(), this.tz), parse_mode: 'HTML', reply_markup: REFRESH_KB,
      });
      return answer('Обновлено');
    }
    if (q.data === 'tog:week' || q.data === 'tog:5h') {
      const key = q.data === 'tog:week' ? 'notify_week' : 'notify_5h';
      o[key] = !o[key];
      await this.save();
      await this.tg('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: this.settingsMarkup(o) });
      return answer(o[key] ? 'Включено' : 'Выключено');
    }
    if (q.data?.startsWith('ren:')) {
      const id = q.data.slice(4);
      const p = allDevices(this.s).find((x) => x.id === id);
      if (!p) return answer('Машина не найдена');
      o.pending_rename = id;
      await this.save();
      await this.send(chatId, `Пришли новое имя для <b>${esc(p.name)}</b> (до ${NAME_MAX} символов). Отмена — любая команда.`);
      return answer();
    }
    return answer();
  }
}
