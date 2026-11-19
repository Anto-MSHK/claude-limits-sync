import { DurableObject } from 'cloudflare:workers';
import {
  migrate, applyReport, expireHolds, view, poolView, dueNotifications, participants, allDevices,
  findDevice, renameDevice, poolMeta, NAME_MAX,
} from './logic.js';
import { renderLimits, renderHistory, renderNotification, renderDevices, esc } from './format.js';

const defaultCfg = () => ({ owner: null, notify_week: true, notify_5h: true, pending_rename: null });
const nowSec = () => Math.floor(Date.now() / 1000);

const REFRESH_KB = { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'refresh' }]] };

// Один экземпляр на всё: Durable Object обрабатывает запросы последовательно,
// поэтому одновременные отчёты с разных машин не затирают друг друга.
export class LimitsHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.s = migrate(await ctx.storage.get('state'));
      this.cfg = { ...defaultCfg(), ...((await ctx.storage.get('cfg')) ?? {}) };
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

  async tick() {
    const now = nowSec();
    expireHolds(this.s, now);
    const notes = dueNotifications(this.s, this.cfg, now);
    await this.save();
    if (!this.cfg.owner) return { sent: 0, skipped: notes.length };
    for (const n of notes) {
      const text = renderNotification(n, participants(this.s, n.pool), poolMeta(n.pool).title, this.tz);
      await this.send(this.cfg.owner, text, REFRESH_KB);
    }
    return { sent: notes.length };
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

  settingsMarkup() {
    const mark = (on) => (on ? '✅' : '❌');
    return {
      inline_keyboard: [
        [{ text: `${mark(this.cfg.notify_week)} Неделя: напоминания перед сбросом`, callback_data: 'tog:week' }],
        [{ text: `${mark(this.cfg.notify_5h)} 5 часов: напоминание за 30 мин`, callback_data: 'tog:5h' }],
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
    this.cfg.pending_rename = null;
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

    if (!this.cfg.owner) {
      // Привязка владельца: /start <API_TOKEN> — токен знает только хозяин.
      const [cmd, arg] = text.split(/\s+/);
      if (cmd === '/start' && arg && arg === this.env.API_TOKEN) {
        this.cfg.owner = chatId;
        await this.save();
        await this.send(chatId, '✅ Бот привязан к тебе. /limits — лимиты, /devices — машины, /settings — уведомления.');
      } else {
        await this.send(chatId, 'Бот не привязан. Отправь: /start &lt;API_TOKEN&gt;');
      }
      return;
    }
    if (chatId !== this.cfg.owner) return; // чужим не отвечаем

    // Ждём новое имя после нажатия кнопки в /rename
    if (this.cfg.pending_rename && !text.startsWith('/')) {
      await this.doRename(chatId, this.cfg.pending_rename, text);
      return;
    }

    const m = text.match(/^(\/\w+)(?:@\w+)?\s*(.*)$/s);
    const cmd = (m?.[1] ?? '').toLowerCase();
    const rest = (m?.[2] ?? '').trim();
    if (this.cfg.pending_rename && cmd) { this.cfg.pending_rename = null; await this.save(); }

    switch (cmd) {
      case '/start':
      case '/help':
        await this.send(chatId, '<b>Команды</b>\n'
          + '/limits — текущие лимиты и кто сколько потратил\n'
          + '/devices — машины\n'
          + '/rename — переименовать машину\n'
          + '/history — прошлые недели\n'
          + '/settings — уведомления');
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
        await this.send(chatId, '🔔 Уведомления', this.settingsMarkup());
        break;
      default:
        await this.send(chatId, renderLimits(this.current(), this.tz), REFRESH_KB);
    }
  }

  async onCallback(q) {
    const chatId = q.message?.chat?.id;
    const answer = (text) => this.tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) });
    if (!this.cfg.owner || chatId !== this.cfg.owner) return answer();

    if (q.data === 'refresh') {
      await this.tg('editMessageText', {
        chat_id: chatId, message_id: q.message.message_id,
        text: renderLimits(this.current(), this.tz), parse_mode: 'HTML', reply_markup: REFRESH_KB,
      });
      return answer('Обновлено');
    }
    if (q.data === 'tog:week' || q.data === 'tog:5h') {
      const key = q.data === 'tog:week' ? 'notify_week' : 'notify_5h';
      this.cfg[key] = !this.cfg[key];
      await this.save();
      await this.tg('editMessageReplyMarkup', { chat_id: chatId, message_id: q.message.message_id, reply_markup: this.settingsMarkup() });
      return answer(this.cfg[key] ? 'Включено' : 'Выключено');
    }
    if (q.data?.startsWith('ren:')) {
      const id = q.data.slice(4);
      const p = allDevices(this.s).find((x) => x.id === id);
      if (!p) return answer('Машина не найдена');
      this.cfg.pending_rename = id;
      await this.save();
      await this.send(chatId, `Пришли новое имя для <b>${esc(p.name)}</b> (до ${NAME_MAX} символов). Отмена — любая команда.`);
      return answer();
    }
    return answer();
  }
}
