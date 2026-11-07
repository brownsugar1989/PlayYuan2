// 照片切切樂 後端（Cloudflare Worker + D1 + R2）
const DAY = 86400, TTL = 30 * DAY, LIM = { o: 10, b: 2 }, MAX_BYTES = 1_500_000;
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rid = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function hmac(env, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(env.SIGN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
// 只允許建立者網頁的來源跨網域呼叫管理 API
const originOf = u => { try { return new URL(u).origin; } catch (e) { return ''; } }; // 容許 ALLOWED_ORIGIN 寫成含路徑或結尾斜線的網址
const cors = (env, req) => { const o = req.headers.get('Origin'); return o && o === originOf(env.ALLOWED_ORIGIN) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', Vary: 'Origin' } : {}; };
const json = (env, req, data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(env, req) } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, req) });
    try {
      if (!env.SIGN_SECRET && (p.startsWith('/api/') || p.startsWith('/img/'))) return json(env, req, { error: 'missing_secret' }, 500); // 尚未設定 SIGN_SECRET
      if (p.startsWith('/g/')) return playPage(env, url); // 遊玩頁
      if (p === '/api/games' && req.method === 'POST') return create(req, env);
      let m;
      if ((m = p.match(/^\/api\/play\/([\w-]{16,})$/))) return play(req, env, m[1]);
      if ((m = p.match(/^\/img\/([\w-]+)\/([\w-]+)$/))) return img(env, url, m[1], m[2]);
      if (p.startsWith('/api/manage')) return manage(req, env, url, p);
      if (p.startsWith('/api/')) return json(env, req, { error: 'not_found' }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) { console.error('worker error', (e && e.stack) || e); return json(env, req, { error: 'server' }, 500); }
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(cleanup(env)); },
};

// 靜態資源預設會把 /play.html 轉址到 /play；若把轉址直接回給瀏覽器，網址會變成 /play、遊戲代碼就不見了，所以在這裡內部跟隨轉址
async function playPage(env, url) {
  let r = await env.ASSETS.fetch(new Request(url.origin + '/play.html'));
  for (let i = 0; i < 3 && r.status >= 300 && r.status < 400 && r.headers.get('Location'); i++)
    r = await env.ASSETS.fetch(new Request(new URL(r.headers.get('Location'), url.origin)));
  return r;
}

async function create(req, env) {
  const b = await req.json().catch(() => ({}));
  if (env.TURNSTILE_SECRET && !(await turnstile(env, b.token, req))) return json(env, req, { error: 'captcha' }, 403);
  const playId = rid(16), key = rid(32), t = now();
  const email = typeof b.email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email) ? b.email.slice(0, 200) : null;
  await env.DB.prepare('INSERT INTO games(play_id,manage_hash,title,email,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .bind(playId, await sha(key), String(b.title || '').slice(0, 60), email, t, t + TTL).run();
  const playUrl = `${env.PUBLIC_PLAY_BASE}/g/${playId}`, manageUrl = `${env.CREATOR_URL}#key=${key}`;
  if (email) await mail(env, email, `你的${env.GAME_NAME || '面目全非'}連結`, `遊玩連結：${playUrl}\n管理連結：${manageUrl}\n連結在最後一次遊玩或修改後 30 天失效。`);
  return json(env, req, { playUrl, manageUrl, key, expiresAt: t + TTL });
}

// 滑動式 30 天：一天內最多寫入一次，避免佔用 D1 寫入額度
async function touch(env, g) {
  const t = now();
  if (g.expires_at - t < TTL - DAY) { await env.DB.prepare('UPDATE games SET expires_at=?,reminded=0 WHERE play_id=?').bind(t + TTL, g.play_id).run(); g.expires_at = t + TTL; }
}
async function signed(env, pid, fid) { const exp = now() + 600; return `/img/${pid}/${fid}?exp=${exp}&sig=${await hmac(env, `${pid}.${fid}.${exp}`)}`; } // 10 分鐘短效網址
async function photoList(env, id, kind) {
  const { results } = await env.DB.prepare('SELECT id FROM photos WHERE play_id=? AND kind=? ORDER BY position').bind(id, kind).all();
  return Promise.all(results.map(async r => ({ id: r.id, url: await signed(env, id, r.id) })));
}

async function play(req, env, id) {
  const g = await env.DB.prepare('SELECT * FROM games WHERE play_id=?').bind(id).first();
  if (!g || g.expires_at < now()) return json(env, req, { error: 'gone' }, 410);
  await touch(env, g);
  return json(env, req, { title: g.title, items: await photoList(env, id, 'o'), bombs: await photoList(env, id, 'b') });
}

async function img(env, url, pid, fid) {
  const exp = +url.searchParams.get('exp'), sig = url.searchParams.get('sig') || '';
  if (!(exp > now()) || !safeEq(sig, await hmac(env, `${pid}.${fid}.${exp}`))) return new Response('forbidden', { status: 403 });
  const o = await env.BUCKET.get(`g/${pid}/${fid}`);
  if (!o) return new Response('not found', { status: 404 });
  return new Response(o.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
}

async function manage(req, env, url, p) {
  const key = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (key.length < 30) return json(env, req, { error: 'auth' }, 401);
  const g = await env.DB.prepare('SELECT * FROM games WHERE manage_hash=?').bind(await sha(key)).first();
  if (!g || g.expires_at < now()) return json(env, req, { error: 'gone' }, 410);
  const sub = p.slice('/api/manage'.length), id = g.play_id, M = req.method;
  if (sub === '' && M === 'GET') {
    await touch(env, g);
    return json(env, req, { playUrl: `${env.PUBLIC_PLAY_BASE}/g/${id}`, title: g.title, hasEmail: !!g.email, expiresAt: g.expires_at, items: await photoList(env, id, 'o'), bombs: await photoList(env, id, 'b') });
  }
  if (sub === '' && M === 'PUT') { const b = await req.json().catch(() => ({})); await env.DB.prepare('UPDATE games SET title=? WHERE play_id=?').bind(String(b.title || '').slice(0, 60), id).run(); await touch(env, g); return json(env, req, { ok: 1 }); }
  if (sub === '' && M === 'DELETE') { await deleteGame(env, id); return json(env, req, { ok: 1 }); }
  if (sub === '/renew' && M === 'POST') { await env.DB.prepare('UPDATE games SET expires_at=?,reminded=0 WHERE play_id=?').bind(now() + TTL, id).run(); return json(env, req, { expiresAt: now() + TTL }); }
  if (sub === '/photos' && M === 'POST') { // body：處理好的 PNG；?kind=o（物件）或 b（炸彈）
    const kind = url.searchParams.get('kind');
    if (!LIM[kind]) return json(env, req, { error: 'kind' }, 400);
    const buf = await req.arrayBuffer(), u = new Uint8Array(buf);
    if (buf.byteLength > MAX_BYTES) return json(env, req, { error: 'too_large' }, 413);
    if (!(u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47)) return json(env, req, { error: 'png_only' }, 415);
    const c = await env.DB.prepare('SELECT COUNT(*) n FROM photos WHERE play_id=? AND kind=?').bind(id, kind).first();
    if (c.n >= LIM[kind]) return json(env, req, { error: 'limit' }, 409);
    const fid = rid(12);
    await env.BUCKET.put(`g/${id}/${fid}`, buf, { httpMetadata: { contentType: 'image/png' } });
    await env.DB.prepare('INSERT INTO photos(id,play_id,kind,position,created_at) VALUES(?,?,?,?,?)').bind(fid, id, kind, Date.now(), now()).run();
    await touch(env, g);
    return json(env, req, { id: fid, url: await signed(env, id, fid) });
  }
  const m = sub.match(/^\/photos\/([\w-]+)$/);
  if (m && M === 'DELETE') {
    const ph = await env.DB.prepare('SELECT id FROM photos WHERE id=? AND play_id=?').bind(m[1], id).first();
    if (!ph) return json(env, req, { error: 'not_found' }, 404);
    await env.BUCKET.delete(`g/${id}/${ph.id}`);
    await env.DB.prepare('DELETE FROM photos WHERE id=?').bind(ph.id).run();
    await touch(env, g);
    return json(env, req, { ok: 1 });
  }
  return json(env, req, { error: 'not_found' }, 404);
}

async function deleteGame(env, id) { // 照片與設定一併刪除
  const { results } = await env.DB.prepare('SELECT id FROM photos WHERE play_id=?').bind(id).all();
  if (results.length) await env.BUCKET.delete(results.map(r => `g/${id}/${r.id}`));
  await env.DB.batch([env.DB.prepare('DELETE FROM photos WHERE play_id=?').bind(id), env.DB.prepare('DELETE FROM games WHERE play_id=?').bind(id)]);
}

async function cleanup(env) { // 每日排程：刪除過期遊戲、到期前 3 天寄提醒
  const t = now();
  const { results: old } = await env.DB.prepare('SELECT play_id FROM games WHERE expires_at<? LIMIT 200').bind(t).all();
  for (const g of old) await deleteGame(env, g.play_id);
  const { results: soon } = await env.DB.prepare('SELECT play_id,email FROM games WHERE email IS NOT NULL AND reminded=0 AND expires_at BETWEEN ? AND ?').bind(t, t + 3 * DAY).all();
  for (const g of soon) {
    await mail(env, g.email, `你的${env.GAME_NAME || '面目全非'}連結即將失效`, '遊戲連結將在 3 天內失效。有人遊玩或你到管理頁按「延長」，就會重新計 30 天；否則照片與設定會被刪除。');
    await env.DB.prepare('UPDATE games SET reminded=1 WHERE play_id=?').bind(g.play_id).run();
  }
}

async function turnstile(env, token, req) {
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token || '', remoteip: req.headers.get('CF-Connecting-IP') || '' }) });
  return (await r.json()).success === true;
}
async function mail(env, to, subject, text) { // 選用：設定 RESEND_API_KEY 才會寄信
  if (!env.RESEND_API_KEY) return;
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }) }).catch(() => {});
}
