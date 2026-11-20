import { LimitsHub } from './hub.js';
import { POOL_RE } from './logic.js';

export { LimitsHub };

const hub = (env) => env.HUB.get(env.HUB.idFromName('main'));
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const enc = new TextEncoder();
const sha256 = async (s) => crypto.subtle.digest('SHA-256', enc.encode(s));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

async function authorized(req, env) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return !!env.API_TOKEN && !!token && safeEqual(token, env.API_TOKEN);
}

// Секрет вебхука выводится из обоих токенов: Telegram присылает его в заголовке каждого апдейта.
const webhookSecret = async (env) => hex(await sha256(`tg-webhook:${env.API_TOKEN}:${env.BOT_TOKEN}`)).slice(0, 48);

const DEVICE_RE = /^[\p{L}\p{N}_.-]{1,24}$/u;

function validReport(b) {
  if (!b || typeof b !== 'object' || typeof b.device !== 'string' || !DEVICE_RE.test(b.device)) return false;
  if (b.device === 'web' || b.device === 'prior') return false;
  if (b.session_id != null && (typeof b.session_id !== 'string' || b.session_id.length > 80)) return false;
  if (b.pool != null && (typeof b.pool !== 'string' || !POOL_RE.test(b.pool))) return false;
  return true;
}

async function setup(req, env) {
  const origin = new URL(req.url).origin;
  const call = async (method, body) => {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return r.json();
  };
  const webhook = await call('setWebhook', {
    url: `${origin}/tg`,
    secret_token: await webhookSecret(env),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  const commands = await call('setMyCommands', {
    commands: [
      { command: 'limits', description: 'Текущие лимиты и кто сколько потратил' },
      { command: 'devices', description: 'Машины' },
      { command: 'rename', description: 'Переименовать машину' },
      { command: 'history', description: 'Прошлые недели' },
      { command: 'settings', description: 'Уведомления' },
      { command: 'unlink', description: 'Отвязать этот аккаунт' },
    ],
  });
  const me = await call('getMe', {});
  return { webhook, commands, bot: me.result?.username };
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    try {
      if (pathname === '/tg' && req.method === 'POST') {
        const got = req.headers.get('x-telegram-bot-api-secret-token') || '';
        if (!(await safeEqual(got, await webhookSecret(env)))) return new Response('forbidden', { status: 403 });
        await hub(env).telegram(await req.json());
        return new Response('ok');
      }
      if (pathname === '/' || pathname === '/health') return json({ ok: true });

      if (!(await authorized(req, env))) return json({ error: 'unauthorized' }, 401);

      if (pathname === '/report' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!validReport(body)) return json({ error: 'bad report' }, 400);
        return json(await hub(env).report(body));
      }
      if (pathname === '/state' && req.method === 'GET') return json(await hub(env).state());
      if (pathname === '/tick' && req.method === 'POST') return json(await hub(env).tick());
      if (pathname === '/adjust' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== 'object') return json({ error: 'bad body' }, 400);
        const r = await hub(env).adjust(body);
        return json(r, r.error ? 400 : 200);
      }
      if (pathname === '/setup' && req.method === 'POST') return json(await setup(req, env));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.log('error', e?.stack || String(e));
      return json({ error: 'internal' }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(hub(env).tick());
  },
};
