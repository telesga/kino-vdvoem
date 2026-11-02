// Кино вдвоём — серверная версия.
// Фильм загружается на сервер один раз, оба смотрят его отсюда в исходном качестве.
// Зависимость одна: ws. Нужен ffmpeg/ffprobe в PATH.
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.KINO_DATA || path.join(__dirname, 'data');
const PASSWORD = process.env.KINO_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'public');
const MEDIA = path.join(DATA, 'media');
const UPLOADS = path.join(DATA, 'uploads');
for (const d of [DATA, MEDIA, UPLOADS]) fs.mkdirSync(d, { recursive: true });
if (!PASSWORD) console.warn('ВНИМАНИЕ: KINO_PASSWORD не задан — вход без пароля');

/* ---------- авторизация ---------- */
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();
const TOKEN = crypto.createHmac('sha256', SECRET).update('kino:' + PASSWORD).digest('hex');
// ключ для ссылки-приглашения: меняется вместе с паролем
const INVITE = crypto.createHmac('sha256', SECRET).update('invite:' + PASSWORD).digest('hex').slice(0, 20);
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((x) => x[0]));
const authed = (req) => !PASSWORD || cookies(req).kino === TOKEN;
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

/* ---------- утилиты ---------- */
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req, limit = 1e6) => new Promise((ok, fail) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > limit) { fail(new Error('too big')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } }); req.on('error', fail);
});
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const cleanName = (n) => String(n).replace(/[\/\\\0]/g, '_').replace(/^\.+/, '').slice(0, 200) || 'file';
const natSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.jpg': 'image/jpeg' };

/* ---------- библиотека ---------- */
// media/<id>/meta.json: { title, created, files: [{ src, out, status, progress, error, subs:[{label,file}], duration }] }
const metaPath = (id) => path.join(MEDIA, id, 'meta.json');
async function readMeta(id) { try { return JSON.parse(await fsp.readFile(metaPath(id), 'utf8')); } catch { return null; } }
const metaLocks = new Map();
async function updateMeta(id, fn) {
  const prev = metaLocks.get(id) || Promise.resolve();
  const next = prev.then(async () => {
    const m = (await readMeta(id)) || { title: id, created: Date.now(), files: [] };
    fn(m);
    m.files.sort((a, b) => natSort(a.src, b.src));
    await fsp.writeFile(metaPath(id) + '.tmp', JSON.stringify(m));
    await fsp.rename(metaPath(id) + '.tmp', metaPath(id));
    return m;
  });
  metaLocks.set(id, next.catch(() => {}));
  return next;
}
async function library() {
  const ids = await fsp.readdir(MEDIA).catch(() => []);
  const items = [];
  for (const id of ids) {
    const m = await readMeta(id);
    if (!m) continue;
    items.push({ id, title: m.title, created: m.created, files: m.files.map((f) => ({
      name: f.src, status: f.status, progress: f.progress || 0, error: f.error || null, duration: f.duration || 0,
      url: f.status === 'ready' ? '/media/' + id + '/' + encodeURIComponent(f.out) : null,
      subs: (f.subs || []).map((s) => ({ label: s.label, url: '/media/' + id + '/' + encodeURIComponent(s.file) })),
    })) });
  }
  items.sort((a, b) => b.created - a.created);
  return items;
}

/* ---------- перекодирование ---------- */
const queue = [];
let busy = false;
function enqueue(job) { queue.push(job); pump(); }
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  try { await processFile(job.id, job.src); }
  catch (e) { console.error('processing failed', job, e); await updateMeta(job.id, (m) => { const f = m.files.find((x) => x.src === job.src); if (f) { f.status = 'error'; f.error = String(e.message || e).slice(0, 300); } }); }
  busy = false;
  broadcast({ t: 'library' });
  pump();
}
const run = (cmd, args, onLine) => new Promise((ok, fail) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; if (onLine) String(d).split('\n').forEach(onLine); });
  p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  p.on('error', fail);
  p.on('close', (code) => code === 0 ? ok(out) : fail(new Error(cmd + ' exited ' + code + ': ' + err.split('\n').slice(-4).join(' '))));
});
const LANG = { rus: 'Русские', ru: 'Русские', eng: 'Английские', en: 'English', ukr: 'Украинские', jpn: 'Японские', ger: 'Немецкие', fre: 'Французские', spa: 'Испанские' };
async function processFile(id, src) {
  const dir = path.join(MEDIA, id);
  const input = path.join(dir, src);
  const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', input]));
  const streams = probe.streams || [];
  const duration = parseFloat(probe.format && probe.format.duration) || 0;
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('В файле нет видео');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  // предпочитаем русскую дорожку
  const lang = (s) => ((s.tags && (s.tags.language || s.tags.LANGUAGE)) || '').toLowerCase();
  const a = audios.find((s) => ['rus', 'ru'].includes(lang(s))) || audios[0];
  const base = src.replace(/\.[^.]+$/, '');
  const out = base + '.web.mp4';
  const vCopy = v.codec_name === 'h264' && (!v.pix_fmt || v.pix_fmt === 'yuv420p');
  const aCopy = a && a.codec_name === 'aac' && (a.channels || 2) <= 2;
  const args = ['-y', '-hide_banner', '-i', input, '-map', '0:' + v.index];
  if (a) args.push('-map', '0:' + a.index);
  if (vCopy) args.push('-c:v', 'copy');
  else args.push('-c:v', 'libx264', '-preset', process.env.KINO_PRESET || 'veryfast', '-crf', process.env.KINO_CRF || '20', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2");
  if (a) args.push(...(aCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
  args.push('-sn', '-dn', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', path.join(dir, out + '.part.mp4'));
  await updateMeta(id, (m) => { const f = m.files.find((x) => x.src === src); f.status = 'processing'; f.progress = 0; f.duration = duration; f.mode = vCopy ? 'remux' : 'transcode'; });
  broadcast({ t: 'library' });
  let lastSent = 0;
  await run('ffmpeg', args, (line) => {
    const m = line.match(/^out_time_(?:ms|us)=(\d+)/);
    if (!m || !duration) return;
    const p = Math.min(0.99, (+m[1] / 1e6) / duration);
    if (Date.now() - lastSent > 1500) {
      lastSent = Date.now();
      updateMeta(id, (mm) => { const f = mm.files.find((x) => x.src === src); if (f) f.progress = p; }).then(() => broadcast({ t: 'progress', id, src, progress: p }));
    }
  });
  await fsp.rename(path.join(dir, out + '.part.mp4'), path.join(dir, out));
  // встроенные текстовые субтитры → vtt
  const subs = [];
  const textSubs = streams.filter((s) => s.codec_type === 'subtitle' && ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'].includes(s.codec_name));
  for (const [i, s] of textSubs.entries()) {
    const file = base + '.' + i + '.vtt';
    try {
      await run('ffmpeg', ['-y', '-hide_banner', '-i', input, '-map', '0:' + s.index, '-f', 'webvtt', path.join(dir, file)]);
      const l = lang(s), title = s.tags && (s.tags.title || s.tags.TITLE);
      subs.push({ label: (LANG[l] || l || 'Субтитры') + (title ? ' — ' + title : ''), file });
    } catch (e) { console.warn('subs failed', e.message); }
  }
  await updateMeta(id, (m) => { const f = m.files.find((x) => x.src === src); f.status = 'ready'; f.progress = 1; f.out = out; f.subs = (f.subs || []).concat(subs); });
  if (out !== src) await fsp.unlink(input).catch(() => {});
}
// после перезапуска — доделать незавершённое
(async () => {
  for (const id of await fsp.readdir(MEDIA).catch(() => [])) {
    const m = await readMeta(id);
    if (m) for (const f of m.files) if (f.status === 'queued' || f.status === 'processing') enqueue({ id, src: f.src });
  }
})();

/* ---------- загрузка с докачкой ---------- */
// id загрузки зависит от названия, имени и размера — после обрыва клиент продолжает с того же места
async function uploadInit(body) {
  const title = String(body.title || '').trim().slice(0, 120) || 'Без названия';
  const name = cleanName(body.name), size = +body.size;
  if (!size || size < 0) throw new Error('bad size');
  const lib = await fsp.readdir(MEDIA).catch(() => []);
  const existing = [];
  for (const id of lib) { const m = await readMeta(id); if (m && m.title === title) existing.push(id); }
  const itemId = existing[0] || hash('item:' + title);
  const upId = hash(itemId + '|' + name + '|' + size);
  const part = path.join(UPLOADS, upId + '.part');
  const st = await fsp.stat(part).catch(() => null);
  await fsp.writeFile(path.join(UPLOADS, upId + '.json'), JSON.stringify({ itemId, title, name, size }));
  return { upId, itemId, offset: st ? st.size : 0 };
}
async function uploadChunk(req, upId) {
  const info = JSON.parse(await fsp.readFile(path.join(UPLOADS, upId + '.json'), 'utf8'));
  const part = path.join(UPLOADS, upId + '.part');
  const st = await fsp.stat(part).catch(() => ({ size: 0 }));
  const offset = +req.headers['x-offset'];
  if (offset !== st.size) return { conflict: true, offset: st.size };
  await new Promise((ok, fail) => {
    const ws = fs.createWriteStream(part, { flags: 'a' });
    req.pipe(ws); ws.on('finish', ok); ws.on('error', fail); req.on('error', fail);
  });
  const now = (await fsp.stat(part)).size;
  if (now > info.size) { await fsp.truncate(part, info.size); }
  if (now >= info.size) {
    const dir = path.join(MEDIA, info.itemId);
    await fsp.mkdir(dir, { recursive: true });
    let name = info.name;
    if (fs.existsSync(path.join(dir, name))) name = name.replace(/(\.[^.]+)?$/, '-' + upId.slice(0, 4) + '$1');
    await fsp.rename(part, path.join(dir, name));
    await fsp.unlink(path.join(UPLOADS, upId + '.json')).catch(() => {});
    const isSub = /\.(srt|vtt|ass)$/i.test(name);
    await updateMeta(info.itemId, (m) => {
      m.title = info.title;
      if (isSub) return; // субтитры прикрепим ниже
      m.files.push({ src: name, status: 'queued', progress: 0, subs: [] });
    });
    if (isSub) await attachSub(info.itemId, name);
    else enqueue({ id: info.itemId, src: name });
    broadcast({ t: 'library' });
    return { done: true, offset: info.size };
  }
  return { offset: now };
}
// внешние субтитры: «Серия 1.srt» прикрепляется к «Серия 1.mkv» (или к единственному файлу)
async function attachSub(id, name) {
  const dir = path.join(MEDIA, id);
  const vtt = name.replace(/\.[^.]+$/, '') + '.ext.vtt';
  await run('ffmpeg', ['-y', '-hide_banner', '-sub_charenc', 'UTF-8', '-i', path.join(dir, name), '-f', 'webvtt', path.join(dir, vtt)])
    .catch(() => run('ffmpeg', ['-y', '-hide_banner', '-sub_charenc', 'CP1251', '-i', path.join(dir, name), '-f', 'webvtt', path.join(dir, vtt)]));
  await fsp.unlink(path.join(dir, name)).catch(() => {});
  await updateMeta(id, (m) => {
    const stem = name.replace(/\.[^.]+$/, '').toLowerCase();
    const f = m.files.find((x) => stem.startsWith(x.src.replace(/\.[^.]+$/, '').toLowerCase())) || (m.files.length === 1 ? m.files[0] : m.files[m.files.length - 1]);
    if (f) { f.subs = f.subs || []; f.subs.unshift({ label: 'Загруженные', file: vtt }); }
  });
}

/* ---------- раздача видео с поддержкой перемотки (Range) ---------- */
async function serveFile(req, res, file, cache) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) { res.writeHead(404); return res.end(); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'no-cache' };
  const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] ? +range[1] : st.size - +range[2];
    let end = range[2] && range[1] ? +range[2] : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const okKey = b.key && safeEq(b.key, INVITE);
      if (PASSWORD && !okKey && !safeEq(b.password || '', PASSWORD)) { await new Promise((r) => setTimeout(r, 800)); return json(res, 401, { error: 'Неверный пароль' }); }
      res.setHeader('Set-Cookie', `kino=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/') || p.startsWith('/media/')) {
      if (!authed(req)) return json(res, 401, { error: 'auth' });
    }
    if (p === '/api/me') return json(res, 200, { ok: true });
    if (p === '/api/invite') return json(res, 200, { key: INVITE });
    if (p === '/api/library' && req.method === 'GET') return json(res, 200, await library());
    if (p === '/api/disk') {
      const s = await fsp.statfs(DATA).catch(() => null);
      return json(res, 200, s ? { free: s.bavail * s.bsize, total: s.blocks * s.bsize } : {});
    }
    if (p === '/api/upload/init' && req.method === 'POST') return json(res, 200, await uploadInit(await readBody(req)));
    let m;
    if ((m = p.match(/^\/api\/upload\/([a-f0-9]{12})$/)) && req.method === 'PUT') {
      const r = await uploadChunk(req, m[1]);
      return json(res, r.conflict ? 409 : 200, r);
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{12})$/)) && req.method === 'DELETE') {
      await fsp.rm(path.join(MEDIA, m[1]), { recursive: true, force: true });
      broadcast({ t: 'library' });
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/library\/([a-f0-9]{12})$/)) && req.method === 'PATCH') {
      const b = await readBody(req);
      if (b.title) await updateMeta(m[1], (mm) => { mm.title = String(b.title).slice(0, 120); });
      broadcast({ t: 'library' });
      return json(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/media\/([a-f0-9]{12})\/([^/]+)$/))) {
      const file = path.join(MEDIA, m[1], cleanName(m[2]));
      if (/\.(json|part)$/.test(file) || /\.part\.mp4$/.test(file)) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, file, 'private, max-age=86400');
    }
    // статика
    let f = p === '/' ? '/index.html' : p;
    f = path.join(PUBLIC, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, f, 'no-cache');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});
server.requestTimeout = 0; // длинные загрузки
server.headersTimeout = 60000;

/* ---------- синхронизация и чат (WebSocket) ---------- */
// Эталон — на сервере: что смотрим, идёт ли, с какого места, и когда это было.
const state = { item: null, ep: 0, playing: false, time: 0, at: Date.now(), by: null, dur: 0 };
// текущее место; дошли до конца — фиксируем «стоп в конце», а не уходим дальше
function projected() {
  let t = state.time + (state.playing ? (Date.now() - state.at) / 1000 : 0);
  if (state.dur && t >= state.dur) { t = state.dur; if (state.playing) Object.assign(state, { playing: false, time: t, at: Date.now() }); }
  return t;
}
const clients = new Set();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !authed(req)) { sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
});
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg, except) { for (const c of clients) if (c !== except) send(c, msg); }
const snapshot = () => ({ ...state, time: projected(), now: Date.now() });
const peers = () => [...clients].map((c) => ({ id: c.id, name: c.name || 'Гость' }));
const history = []; // последние сообщения чата — чтобы тот, кто зашёл позже, их увидел
wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(4).toString('hex');
  ws.alive = true;
  clients.add(ws);
  ws.on('pong', () => { ws.alive = true; });
  send(ws, { t: 'welcome', you: ws.id, state: snapshot(), peers: peers(), history });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'hello':
        ws.name = String(m.name || 'Гость').slice(0, 24);
        broadcast({ t: 'peers', peers: peers(), joined: ws.name, id: ws.id });
        break;
      case 'select': // выбрать фильм/серию
        Object.assign(state, { item: m.item, ep: +m.ep || 0, playing: !!m.play, time: 0, at: Date.now(), by: ws.name, dur: 0 });
        broadcast({ t: 'state', state: snapshot(), action: 'select', by: ws.name, from: ws.id });
        break;
      case 'ctl': // пуск / пауза / перемотка
        if (m.item !== state.item || (+m.ep || 0) !== state.ep) break;
        if (+m.dur > 0) state.dur = +m.dur;
        Object.assign(state, { playing: !!m.playing, time: Math.max(0, +m.time || 0), at: Date.now(), by: ws.name });
        broadcast({ t: 'state', state: snapshot(), action: m.action || 'ctl', by: ws.name, from: ws.id });
        break;
      case 'dur':
        if (m.item === state.item && (+m.ep || 0) === state.ep && +m.dur > 0) state.dur = +m.dur;
        break;
      case 'sync':
        send(ws, { t: 'state', state: snapshot(), action: 'sync' });
        break;
      case 'chat': {
        const msg = { t: 'chat', name: ws.name, from: ws.id, text: String(m.text || '').slice(0, 500), vt: m.vt, ts: Date.now() };
        history.push(msg); if (history.length > 100) history.shift();
        broadcast(msg);
        break;
      }
      case 'react': broadcast({ t: 'react', e: String(m.e).slice(0, 8), from: ws.id }, ws); break;
      case 'typing': broadcast({ t: 'typing', name: ws.name, from: ws.id }, ws); break;
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ t: 'peers', peers: peers(), left: ws.name, id: ws.id });
  });
});
// эталон каждые 2 с — для подстройки; пинг — чтобы отваливались мёртвые соединения
setInterval(() => broadcast({ t: 'state', state: snapshot(), action: 'beat' }), 2000);
setInterval(() => { for (const c of clients) { if (!c.alive) { c.terminate(); continue; } c.alive = false; try { c.ping(); } catch {} } }, 20000);

server.listen(PORT, HOST, () => console.log(`Кино вдвоём: http://${HOST}:${PORT}  (данные: ${DATA})`));
