/**
 * Cloudflare Worker: CORS-прокси + авторизация для HDREZKA (Lampa-плагин)
 * Env (необязательно): TOKEN — секрет, ALLOWED — список хостов через запятую
 *
 * POST /login  {domain, login, password} -> {success, message, cookie}
 * ANY  /fetch?url=<https://rezka...>     (заголовок X-Cookie -> Cookie)
 */
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Cookie,X-Token,X-Requested-With',
  'Access-Control-Max-Age': '86400'
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

function hostOk(u, env) {
  try {
    const h = new URL(u).hostname;
    if (env.ALLOWED) return env.ALLOWED.split(',').map(s => s.trim()).some(a => h === a || h.endsWith('.' + a));
    return h.includes('rezka');
  } catch (e) { return false; }
}

function parseCookies(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const jar = {};
  list.forEach(c => {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i < 1) return;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (v && v !== 'deleted') jar[k] = v;
  });
  return jar;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (env.TOKEN && (req.headers.get('X-Token') || url.searchParams.get('token')) !== env.TOKEN)
      return json({ success: false, message: 'forbidden' }, 403);

    if (url.pathname === '/login' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch (e) { return json({ success: false, message: 'bad json' }, 400); }
      const domain = String(b.domain || '').replace(/\/+$/, '');
      if (!hostOk(domain, env)) return json({ success: false, message: 'host not allowed' }, 400);
      const body = 'login_name=' + encodeURIComponent(b.login || '') +
                   '&login_password=' + encodeURIComponent(b.password || '') + '&login_not_save=0';
      const r = await fetch(domain + '/ajax/login/', {
        method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest',
                   'Referer': domain + '/', 'Origin': domain, 'User-Agent': UA }, body
      });
      let data = {}; try { data = JSON.parse(await r.text()); } catch (e) {}
      const jar = parseCookies(r);
      const cookie = Object.keys(jar).map(k => k + '=' + jar[k]).join('; ');
      const ok = !!data.success && /dle_user_id/.test(cookie);
      return json({ success: ok, message: data.message || (ok ? 'ok' : 'login failed'), cookie: ok ? cookie : '' });
    }

    if (url.pathname === '/fetch') {
      const target = url.searchParams.get('url');
      if (!target || !hostOk(target, env)) return json({ success: false, message: 'host not allowed' }, 400);
      const origin = new URL(target).origin;
      const h = { 'User-Agent': UA, 'Referer': origin + '/', 'Accept-Language': 'ru,en;q=0.9' };
      const ck = req.headers.get('X-Cookie'); if (ck) h['Cookie'] = ck;
      const ct = req.headers.get('Content-Type'); if (ct) h['Content-Type'] = ct;
      if (req.headers.get('X-Requested-With')) { h['X-Requested-With'] = 'XMLHttpRequest'; h['Origin'] = origin; }
      const init = { method: req.method, headers: h, redirect: 'follow' };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.text();
      const r = await fetch(target, init);
      const out = new Headers(CORS);
      out.set('Content-Type', r.headers.get('Content-Type') || 'text/plain; charset=utf-8');
      return new Response(r.body, { status: r.status, headers: out });
    }
    return json({ ok: true, usage: 'POST /login, /fetch?url=' });
  }
};
