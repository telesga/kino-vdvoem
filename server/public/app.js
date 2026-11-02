/* Смотрим вместе — клиент серверной версии.
 * Видео берётся с сервера (у обоих оригинальное качество).
 * Эталон «что смотрим / идёт ли / с какого места» хранит сервер; клиенты подстраиваются.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const v = $('video'), player = $('player');
  // форма окна плеера = форма видео (важно на телефоне)
  v.addEventListener('loadedmetadata', () => { if (v.videoWidth && v.videoHeight) player.style.setProperty('--ar', v.videoWidth + '/' + v.videoHeight); });
  v.addEventListener('resize', () => { if (v.videoWidth && v.videoHeight) player.style.setProperty('--ar', v.videoWidth + '/' + v.videoHeight); });

  /* ---------- иконки ---------- */
  const svg = (d) => '<svg viewBox="0 0 24 24">' + d + '</svg>';
  const IC = {
    play: svg('<path d="M7.5 5v14l11-7z" fill="currentColor"/>'),
    pause: svg('<rect x="6.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none"/>'),
    back: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.8h3.8"/><text x="12.3" y="15.3" font-size="6.8" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none" font-family="Onest,sans-serif">10</text>'),
    fwd: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v3.8h-3.8"/><text x="11.7" y="15.3" font-size="6.8" font-weight="600" text-anchor="middle" fill="currentColor" stroke="none" font-family="Onest,sans-serif">10</text>'),
    vol: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    mute: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
    fs: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
    lib: svg('<rect x="3.5" y="4.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="6" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="6" rx="1.5"/>'),
    subs: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7 14.5h4M13 14.5h4M7 11h10"/>'),
    send: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    prev: svg('<path d="M6 5v14"/><path d="M18 5L9 12l9 7z" fill="currentColor"/>'),
    next: svg('<path d="M18 5v14"/><path d="M6 5l9 7-9 7z" fill="currentColor"/>'),
    list: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="17.5" r="1" fill="currentColor"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
  };
  const setIcon = (id, k) => { $(id).innerHTML = IC[k]; };
  [['back10','back'],['fwd10','fwd'],['fsBtn','fs'],['libCtl','lib'],['subsBtn','subs'],['prevEp','prev'],['nextEp','next'],['epsBtn','list'],['epsClose','close'],['libClose','close'],['sendBtn','send']].forEach(([i, k]) => setIcon(i, k));

  /* ---------- утилиты ---------- */
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pretty = (n) => String(n || '').replace(/\.web\.mp4$/, '').replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
  const gb = (b) => (b / 1e9).toFixed(b > 1e10 ? 0 : 1) + ' ГБ';
  let toastT;
  const toast = (t, ms = 2500) => { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), ms); };
  const api = async (url, opt = {}) => {
    const r = await fetch(url, { credentials: 'same-origin', ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) } });
    if (r.status === 401) { showLogin(); throw new Error('auth'); }
    return r;
  };

  /* ---------- вход ---------- */
  let myName = localStorage.getItem('kino-name') || '';
  $('nameInput').value = myName;
  function showLogin(msg) {
    $('room').classList.remove('active'); $('lobby').classList.add('active');
    if (msg) { $('loginErr').textContent = msg; $('loginErr').classList.remove('hidden'); }
  }
  $('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    myName = $('nameInput').value.trim() || 'Гость';
    localStorage.setItem('kino-name', myName);
    // уже вошли по ссылке-приглашению — пароль не нужен
    if ((await fetch('/api/me', { credentials: 'same-origin' })).ok) { enterRoom(); return; }
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('passInput').value }) });
    if (!r.ok) { $('loginErr').textContent = 'Неверный пароль'; $('loginErr').classList.remove('hidden'); return; }
    enterRoom();
  };
  (async () => {
    // вход по ссылке-приглашению: ?k=ключ — пароль не нужен
    const k = new URLSearchParams(location.search).get('k');
    if (k) {
      await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: k }) });
      history.replaceState(null, '', location.pathname);
    }
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (r.ok && myName) enterRoom();
    else if (r.ok) { $('passInput').parentNode && ($('passInput').style.display = 'none'); document.querySelector('label[for=passInput]').style.display = 'none'; }
  })();

  let started = false;
  function enterRoom() {
    $('lobby').classList.remove('active'); $('room').classList.add('active');
    if (started) return;
    started = true;
    connect(); loadLibrary(); tick();
  }

  /* ---------- WebSocket ---------- */
  let ws = null, me = null, peers = [], wsRetry = 0;
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { wsRetry = 0; wsSend({ t: 'hello', name: myName }); };
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => { renderSeats(true); setTimeout(connect, Math.min(8000, 800 * ++wsRetry)); };
  }
  const wsSend = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  function onMsg(m) {
    switch (m.t) {
      case 'welcome':
        me = m.you; peers = m.peers || [];
        $('messages').innerHTML = '';
        (m.history || []).forEach((c) => addMsg(c.text, c.from === me || c.name === myName ? 'me' : 'them', c.vt, c.name, true));
        renderSeats(); applyState(m.state, 'welcome');
        break;
      case 'peers':
        peers = m.peers || [];
        renderSeats();
        if (m.joined && m.id !== me) sysMsg(m.joined + ' в зале');
        if (m.left && m.id !== me) sysMsg(m.left + ' вышел(ла)');
        break;
      case 'state': applyState(m.state, m.action, m.by, m.from); break;
      case 'library': loadLibrary(); break;
      case 'progress': {
        const it = lib.find((x) => x.id === m.id); const f = it && it.files.find((x) => x.name === m.src);
        if (f) { f.progress = m.progress; f.status = 'processing'; renderLibrary(); }
        break;
      }
      case 'chat': if (m.from !== me) { addMsg(m.text, 'them', m.vt, m.name); typingOff(); } break;
      case 'typing': typingOn(m.name); break;
      case 'react': floatEmoji(m.e); break;
    }
  }

  function renderSeats(offline) {
    const box = $('seats'); box.innerHTML = '';
    const list = offline ? [{ id: 'x', name: myName }] : peers;
    list.forEach((p) => {
      const d = document.createElement('div');
      d.className = 'seat' + (offline ? '' : ' on');
      d.dataset.i = (p.name || '?').slice(0, 1).toUpperCase();
      d.innerHTML = '<span>' + esc(p.name) + (p.id === me ? ' (ты)' : '') + '</span>';
      box.appendChild(d);
    });
    if (offline) { const s = document.createElement('span'); s.className = 'lib-sub'; s.textContent = 'нет связи, переподключаемся…'; box.appendChild(s); }
  }

  /* ---------- библиотека ---------- */
  let lib = [];
  let cur = { item: null, ep: 0 };
  async function loadLibrary() {
    try {
      lib = await (await api('/api/library')).json();
      const d = await (await api('/api/disk')).json();
      $('diskInfo').textContent = d.free ? 'Свободно на сервере: ' + gb(d.free) + ' из ' + gb(d.total) : '';
    } catch (e) { return; }
    renderLibrary();
    // если сейчас выбрано то, что только что дообработалось — подгрузить
    if (srv && srv.item && !v.src) applyState(srvRaw, 'library');
    renderEps(); renderNow();
  }
  const readyFiles = (it) => it ? it.files : [];
  function renderLibrary() {
    const g = $('libGrid'); g.innerHTML = '';
    $('libEmpty').classList.toggle('hidden', lib.length > 0 || uploads.length > 0);
    lib.forEach((it) => {
      const ready = it.files.filter((f) => f.status === 'ready').length;
      const proc = it.files.find((f) => f.status === 'processing' || f.status === 'queued');
      const err = it.files.find((f) => f.status === 'error');
      const c = document.createElement('div');
      c.className = 'card' + (it.id === cur.item ? ' cur' : '') + (ready ? '' : ' busy');
      const n = it.files.length;
      let meta = n > 1 ? n + ' ' + plural(n, 'серия', 'серии', 'серий') : (it.files[0] && it.files[0].duration ? fmt(it.files[0].duration) : 'фильм');
      let barHtml = '';
      if (proc) {
        const p = proc.status === 'queued' ? 0 : proc.progress;
        meta = (proc.status === 'queued' ? 'В очереди на подготовку' : 'Готовим к просмотру: ' + Math.round(p * 100) + '%') + (n > 1 ? ' · готово ' + ready + ' из ' + n : '');
        barHtml = '<div class="bar-p"><i style="width:' + Math.round(p * 100) + '%"></i></div>';
      } else if (err && !ready) meta = 'Ошибка: ' + err.error;
      c.innerHTML = '<b>' + esc(it.title) + '</b>' + barHtml + '<span class="meta">' + esc(meta) + '</span><button class="ic del" title="Удалить с сервера">' + IC.trash + '</button>';
      c.onclick = (e) => {
        if (e.target.closest('.del')) return;
        const i = it.files.findIndex((f) => f.status === 'ready');
        if (i < 0) { toast('Ещё готовится — подожди немного'); return; }
        lastMyAction = performance.now();
        wsSend({ t: 'select', item: it.id, ep: i, play: false });
      };
      c.querySelector('.del').onclick = async () => {
        if (!confirm('Удалить «' + it.title + '» с сервера?')) return;
        await api('/api/library/' + it.id, { method: 'DELETE' });
      };
      g.appendChild(c);
    });
  }
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
  const showLib = (on) => {
    $('library').classList.toggle('hidden', !on);
    $('libClose').classList.toggle('hidden', !cur.item || !v.src);
  };
  $('libBtn').onclick = $('libCtl').onclick = () => showLib($('library').classList.contains('hidden'));
  $('libClose').onclick = () => showLib(false);

  /* ---------- загрузка ---------- */
  let picked = [];
  const uploads = [];
  $('uploadInput').onchange = (e) => {
    picked = [...e.target.files];
    e.target.value = '';
    if (!picked.length) return;
    const vids = picked.filter((f) => !/\.(srt|vtt|ass)$/i.test(f.name));
    // название по умолчанию: общая часть имён (для сериала) или имя файла
    let title = pretty((vids[0] || picked[0]).name);
    if (vids.length > 1) {
      const names = vids.map((f) => pretty(f.name));
      let pre = names[0];
      names.forEach((n) => { while (!n.startsWith(pre)) pre = pre.slice(0, -1); });
      pre = pre.replace(/[\s\-–—_.]*(s\d*e?\d*|серия|сезон|ep?)?\s*\d*$/i, '').trim();
      if (pre.length > 2) title = pre;
    }
    $('upTitle').value = title;
    $('upFiles').textContent = picked.length + ' ' + plural(picked.length, 'файл', 'файла', 'файлов') + ', ' + gb(picked.reduce((s, f) => s + f.size, 0));
    $('upForm').classList.remove('hidden');
    $('upTitle').focus(); $('upTitle').select();
  };
  $('upCancel').onclick = () => { picked = []; $('upForm').classList.add('hidden'); };
  $('upForm').onsubmit = (e) => {
    e.preventDefault();
    const title = $('upTitle').value.trim();
    $('upForm').classList.add('hidden');
    // сначала видео по порядку, субтитры — после
    picked.sort((a, b) => (/\.(srt|vtt|ass)$/i.test(a.name) - /\.(srt|vtt|ass)$/i.test(b.name)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    picked.forEach((f) => uploads.push({ file: f, title, sent: 0, state: 'wait' }));
    picked = [];
    renderUploads(); runUploads();
  };
  let uploading = false;
  async function runUploads() {
    if (uploading) return;
    uploading = true;
    for (const u of uploads) {
      if (u.state !== 'wait') continue;
      u.state = 'up';
      try { await uploadOne(u); u.state = 'done'; }
      catch (e) { u.state = 'error'; u.err = e.message; }
      renderUploads();
    }
    uploading = false;
    setTimeout(() => { for (let i = uploads.length - 1; i >= 0; i--) if (uploads[i].state === 'done') uploads.splice(i, 1); renderUploads(); }, 4000);
  }
  async function uploadOne(u) {
    const init = await (await api('/api/upload/init', { method: 'POST', body: JSON.stringify({ title: u.title, name: u.file.name, size: u.file.size }) })).json();
    let off = init.offset;
    const CH = 8 * 1024 * 1024;
    let fails = 0, t0 = performance.now(), b0 = off;
    while (off < u.file.size) {
      try {
        const r = await fetch('/api/upload/' + init.upId, { method: 'PUT', credentials: 'same-origin', headers: { 'X-Offset': String(off), 'Content-Type': 'application/octet-stream' }, body: u.file.slice(off, off + CH) });
        const j = await r.json();
        if (r.status === 401) { showLogin(); throw new Error('Нужно войти заново'); }
        if (!r.ok && r.status !== 409) throw new Error(j.error || 'HTTP ' + r.status);
        off = j.offset; fails = 0;
      } catch (e) {
        if (++fails > 30) throw e;
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * fails)));
        continue;
      }
      u.sent = off;
      const dt = (performance.now() - t0) / 1000;
      u.speed = dt > 1 ? (off - b0) / dt : 0;
      renderUploads();
    }
  }
  function renderUploads() {
    const box = $('uploads'); box.innerHTML = '';
    uploads.forEach((u) => {
      const p = u.file.size ? u.sent / u.file.size : 0;
      const d = document.createElement('div');
      d.className = 'upl';
      let st = u.state === 'wait' ? 'в очереди' : u.state === 'done' ? 'загружено' : u.state === 'error' ? 'ошибка: ' + u.err : Math.round(p * 100) + '%' + (u.speed ? ' · ' + (u.speed * 8 / 1e6).toFixed(1) + ' Мбит/с' + (u.speed ? ' · ещё ' + fmt((u.file.size - u.sent) / u.speed) : '') : '');
      d.innerHTML = '<div class="row"><span>' + esc(u.file.name) + '</span><span>' + esc(st) + '</span></div><div class="bar-p"><i style="width:' + Math.round(p * 100) + '%"></i></div>';
      box.appendChild(d);
    });
    $('libEmpty').classList.toggle('hidden', lib.length > 0 || uploads.length > 0);
  }
  window.addEventListener('beforeunload', (e) => { if (uploads.some((u) => u.state === 'up' || u.state === 'wait')) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- синхронизация ---------- */
  let srv = null, srvRaw = null, lastMyAction = 0;
  const srvNow = () => srv ? srv.time + (srv.playing ? (performance.now() - srv.recv) / 1000 : 0) : 0;
  function applyState(s, action, by, from) {
    if (!s) return;
    srvRaw = s;
    srv = { item: s.item, ep: s.ep, playing: s.playing, time: s.time, recv: performance.now() };
    if (!s.item) { showLib(true); renderNow(); return; }
    const it = lib.find((x) => x.id === s.item);
    if (!it) return; // библиотека ещё грузится — вызовемся снова после loadLibrary
    const f = it.files[s.ep];
    if (!f || f.status !== 'ready') { renderNow(); return; }
    if (cur.item !== s.item || cur.ep !== s.ep || !v.src) {
      loadSource(it, s.ep);
      if (action === 'select' && from !== me && by) toast(by + ' включает «' + it.title + (it.files.length > 1 ? '», серия ' + (s.ep + 1) : '»'), 3000);
      return;
    }
    if (action === 'beat' && performance.now() - lastMyAction < 1500) return; // мой клик ещё летит на сервер
    if (from && from !== me && by && action === 'ctl') toast(by + (s.playing ? ' включает' : ' ставит на паузу'), 1600);
    if (from && from !== me && by && action === 'seek') toast(by + ' перематывает на ' + fmt(s.time), 1600);
    syncNow(action === 'beat' ? 1.0 : 0.35);
  }
  function syncNow(tol) {
    if (!srv || v.readyState < 1) return;
    let t = srvNow();
    // у конца фильма: не перезапускаем закончившееся видео
    if (v.duration && t >= v.duration - 0.25) {
      if (!v.ended && Math.abs(v.currentTime - v.duration) > tol) v.currentTime = v.duration;
      return;
    }
    if (Math.abs(v.currentTime - t) > tol) v.currentTime = t;
    if (srv.playing && v.paused) v.play().catch(showTap);
    if (!srv.playing && !v.paused) v.pause();
  }
  function loadSource(it, ep) {
    cur = { item: it.id, ep };
    const f = it.files[ep];
    v.pause();
    [...v.querySelectorAll('track')].forEach((t) => t.remove());
    v.src = f.url;
    (f.subs || []).forEach((s, i) => {
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = s.label; tr.src = s.url; tr.srclang = 'ru';
      v.appendChild(tr);
    });
    v.addEventListener('loadedmetadata', () => {
      // субтитры: включаем загруженные или русские, если есть
      const tt = [...v.textTracks];
      const pick = subsChoice[it.id] !== undefined ? subsChoice[it.id] : tt.findIndex((t) => /Загруж|Рус/.test(t.label));
      tt.forEach((t, i) => { t.mode = i === pick ? 'showing' : 'disabled'; });
      wsSend({ t: 'dur', item: cur.item, ep: cur.ep, dur: v.duration });
      syncNow(0.2);
    }, { once: true });
    showLib(false);
    renderEps(); renderNow(); renderLibrary();
    $('subsBtn').classList.toggle('hidden', !(f.subs && f.subs.length));
  }
  // своё действие: применяем сразу и сообщаем серверу
  function ctl(action, playing, time) {
    if (!cur.item) return;
    lastMyAction = performance.now();
    srv = { ...(srv || {}), item: cur.item, ep: cur.ep, playing, time, recv: performance.now() };
    wsSend({ t: 'ctl', action, item: cur.item, ep: cur.ep, playing, time, dur: v.duration || 0 });
  }
  function togglePlay() {
    if (!v.src) return;
    if (v.ended || (v.duration && v.currentTime >= v.duration - 0.25)) { v.currentTime = 0; v.play().catch(showTap); ctl('seek', true, 0); return; }
    if (v.paused) { v.play().catch(showTap); ctl('ctl', true, v.currentTime); }
    else { v.pause(); ctl('ctl', false, v.currentTime); }
  }
  function seekTo(t) {
    if (!v.src) return;
    t = Math.max(0, Math.min(t, v.duration || 0));
    v.currentTime = t;
    ctl('seek', !v.paused, t);
  }
  // мягкая подстройка: раз в секунду сверяемся с эталоном
  setInterval(() => { if (srv && v.src && performance.now() - lastMyAction > 1500 && !v.seeking) syncNow(1.0); }, 1000);
  function showTap(err) { if (err && err.name !== 'NotAllowedError') return; $('tapOverlay').classList.remove('hidden'); }
  $('tapOverlay').onclick = () => { $('tapOverlay').classList.add('hidden'); v.play().catch(() => {}); };
  v.addEventListener('playing', () => { $('tapOverlay').classList.add('hidden'); $('buffering').classList.add('hidden'); });
  v.addEventListener('waiting', () => $('buffering').classList.remove('hidden'));
  v.addEventListener('canplay', () => $('buffering').classList.add('hidden'));
  v.addEventListener('error', () => { if (v.src) toast('Не получилось открыть видео', 4000); });

  // конец серии → следующая через 5 секунд
  let nextT = null;
  v.addEventListener('ended', () => {
    if (srv && srv.playing) ctl('end', false, v.duration || v.currentTime);
    const it = lib.find((x) => x.id === cur.item);
    if (!it || cur.ep >= it.files.length - 1 || it.files[cur.ep + 1].status !== 'ready') return;
    toast('Через 5 секунд — серия ' + (cur.ep + 2), 4800);
    clearTimeout(nextT);
    const ep = cur.ep;
    nextT = setTimeout(() => { if (cur.ep === ep) wsSend({ t: 'select', item: cur.item, ep: ep + 1, play: true }); }, 5000);
  });

  /* ---------- серии ---------- */
  const goEp = (i) => {
    const it = lib.find((x) => x.id === cur.item);
    if (!it || i < 0 || i >= it.files.length) return;
    if (it.files[i].status !== 'ready') { toast('Эта серия ещё готовится'); return; }
    $('epsPanel').classList.add('hidden');
    wsSend({ t: 'select', item: cur.item, ep: i, play: true });
  };
  $('prevEp').onclick = () => goEp(cur.ep - 1);
  $('nextEp').onclick = () => goEp(cur.ep + 1);
  $('epsBtn').onclick = () => $('epsPanel').classList.toggle('hidden');
  $('epsClose').onclick = () => $('epsPanel').classList.add('hidden');
  function renderEps() {
    const it = lib.find((x) => x.id === cur.item);
    const series = it && it.files.length > 1;
    ['prevEp', 'nextEp', 'epsBtn'].forEach((id) => $(id).classList.toggle('hidden', !series));
    if (!series) { $('epsPanel').classList.add('hidden'); return; }
    $('epsTitle').textContent = it.title;
    const ol = $('epsList'); ol.innerHTML = '';
    it.files.forEach((f, i) => {
      const li = document.createElement('li');
      li.className = (i === cur.ep ? 'cur' : '') + (f.status !== 'ready' ? ' wait' : '');
      li.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="t">' + esc(pretty(f.name)) + (f.status !== 'ready' ? ' — готовится' : '') + '</span>';
      li.onclick = () => goEp(i);
      ol.appendChild(li);
    });
  }
  function renderNow() {
    const bar = $('nowBar'); bar.innerHTML = '';
    const it = lib.find((x) => x.id === cur.item);
    if (!it) { bar.textContent = srv && srv.item ? 'Готовим видео…' : 'Выберите, что смотреть'; return; }
    const s = document.createElement('span');
    s.innerHTML = '<b>' + esc(it.title) + '</b>' + (it.files.length > 1 ? ' · серия ' + (cur.ep + 1) + ' из ' + it.files.length : '');
    bar.appendChild(s);
  }

  /* ---------- субтитры ---------- */
  const subsChoice = {};
  $('subsBtn').onclick = () => {
    const m = $('subsMenu');
    if (!m.classList.contains('hidden')) { m.classList.add('hidden'); return; }
    m.innerHTML = '';
    const tt = [...v.textTracks];
    const opt = (label, idx) => {
      const b = document.createElement('button');
      b.textContent = label;
      if ((idx < 0 && tt.every((t) => t.mode !== 'showing')) || (idx >= 0 && tt[idx].mode === 'showing')) b.className = 'on';
      b.onclick = () => { tt.forEach((t, i) => { t.mode = i === idx ? 'showing' : 'disabled'; }); subsChoice[cur.item] = idx; m.classList.add('hidden'); };
      m.appendChild(b);
    };
    opt('Без субтитров', -1);
    tt.forEach((t, i) => opt(t.label || 'Дорожка ' + (i + 1), i));
    m.classList.remove('hidden');
  };

  /* ---------- плеер: управление ---------- */
  $('playBtn').onclick = togglePlay;
  $('back10').onclick = () => seekTo(v.currentTime - 10);
  $('fwd10').onclick = () => seekTo(v.currentTime + 10);
  // на телефоне первое касание показывает панель, второе — пауза
  let wasIdle = false;
  v.addEventListener('click', () => {
    if (matchMedia('(hover: none)').matches && wasIdle) { wasIdle = false; wake(); return; }
    togglePlay();
  });
  v.addEventListener('dblclick', toggleFs);
  const updVol = () => { $('muteBtn').innerHTML = v.muted || v.volume === 0 ? IC.mute : IC.vol; };
  $('volume').value = localStorage.getItem('kino-vol') || 1; v.volume = +$('volume').value;
  $('volume').oninput = (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; localStorage.setItem('kino-vol', v.volume); updVol(); };
  $('muteBtn').onclick = () => { v.muted = !v.muted; updVol(); };
  updVol();

  const seekWrap = $('seekWrap');
  const pctAt = (e) => { const r = $('seek').getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  let dragging = false;
  const preview = (p) => { $('seekFill').style.width = p * 100 + '%'; $('seekHead').style.left = p * 100 + '%'; };
  seekWrap.addEventListener('pointerdown', (e) => { if (!v.duration) return; dragging = true; seekWrap.setPointerCapture(e.pointerId); preview(pctAt(e)); });
  seekWrap.addEventListener('pointermove', (e) => { const p = pctAt(e); $('seekTip').style.left = p * 100 + '%'; $('seekTip').textContent = fmt(p * (v.duration || 0)); if (dragging) preview(p); });
  seekWrap.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; seekTo(pctAt(e) * v.duration); });

  let lastIcon = null;
  function tick() {
    const d = v.duration || 0, t = v.currentTime || 0;
    if (!dragging) preview(d ? t / d : 0);
    $('time').textContent = fmt(t) + ' / ' + fmt(d);
    const pl = !v.paused;
    if (pl !== lastIcon) { setIcon('playBtn', pl ? 'pause' : 'play'); lastIcon = pl; }
    if (v.buffered.length && d) {
      let end = 0; for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 1) end = Math.max(end, v.buffered.end(i));
      $('seekBuf').style.width = (end / d) * 100 + '%';
    }
    requestAnimationFrame(tick);
  }

  // подсветка от кадра
  const amb = $('ambient'), actx = amb.getContext('2d');
  setInterval(() => {
    const has = v.src && v.readyState >= 2 && v.videoWidth;
    amb.classList.toggle('on', !!has);
    if (!has || document.hidden) return;
    try { actx.drawImage(v, 0, 0, amb.width, amb.height); } catch (e) {}
  }, 150);

  // полный экран + чат поверх
  const inFs = () => !!document.fullscreenElement || player.classList.contains('pseudo-fs');
  function toggleFs() {
    if (inFs()) { if (document.fullscreenElement) document.exitFullscreen(); player.classList.remove('pseudo-fs'); }
    else if (player.requestFullscreen) player.requestFullscreen().catch(() => player.classList.add('pseudo-fs'));
    else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
    else player.classList.add('pseudo-fs');
  }
  $('fsBtn').onclick = toggleFs;
  const fsForm = document.createElement('form');
  fsForm.className = 'fs-input hidden';
  fsForm.innerHTML = '<input maxlength="500" placeholder="Просто начни печатать"><button class="send" type="submit" title="Отправить">' + IC.send + '</button>';
  $('fsDock').appendChild(fsForm);
  fsForm.onsubmit = (e) => { e.preventDefault(); const i = fsForm.firstChild; sendChat(i.value); i.value = ''; i.blur(); };
  const fsChange = () => fsForm.classList.toggle('hidden', !inFs());
  document.addEventListener('fullscreenchange', fsChange);
  new MutationObserver(fsChange).observe(player, { attributes: true, attributeFilter: ['class'] });
  fsForm.firstChild.addEventListener('focus', () => wake());

  let idleT;
  const wake = () => { player.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (!v.paused) player.classList.add('idle'); }, 2600); };
  player.addEventListener('pointermove', wake);
  v.addEventListener('play', () => wake()); // панель прячется сама через пару секунд после старта
  player.addEventListener('pointerdown', () => { wasIdle = player.classList.contains('idle'); wake(); });

  document.addEventListener('keydown', (e) => {
    if (!$('room').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return; }
    if (inFs() && e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); const i = fsForm.firstChild; i.focus(); i.value += e.key; wake(); return;
    }
    if (e.code === 'Space' || e.code === 'KeyK') { e.preventDefault(); togglePlay(); wake(); }
    else if (e.key === 'ArrowLeft') { seekTo(v.currentTime - 5); wake(); }
    else if (e.key === 'ArrowRight') { seekTo(v.currentTime + 5); wake(); }
    else if (e.code === 'KeyF') toggleFs();
    else if (e.code === 'KeyM') { v.muted = !v.muted; updVol(); }
    else if (e.code === 'KeyN') goEp(cur.ep + 1);
    else if (e.key === 'Enter') { e.preventDefault(); (inFs() ? fsForm.firstChild : $('chatInput')).focus(); }
  });

  /* ---------- чат ---------- */
  $('chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('chatInput').value); $('chatInput').value = ''; };
  function sendChat(text) {
    text = (text || '').trim();
    if (!text) return;
    const vt = v.src && v.duration ? v.currentTime : null;
    addMsg(text, 'me', vt);
    wsSend({ t: 'chat', text, vt });
  }
  let lastTyping = 0;
  $('chatInput').addEventListener('input', () => { if (performance.now() - lastTyping > 1500) { lastTyping = performance.now(); wsSend({ t: 'typing' }); } });
  let typingT;
  const typingOn = (name) => { $('typing').textContent = (name || 'Собеседник') + ' печатает…'; $('typing').classList.remove('hidden'); clearTimeout(typingT); typingT = setTimeout(typingOff, 3000); };
  const typingOff = () => $('typing').classList.add('hidden');
  function bubble(text, who, vt) {
    const d = document.createElement('div');
    d.className = 'msg ' + who;
    const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = esc(text) + '<span class="meta">' + (vt != null ? '<span class="ts" data-t="' + vt + '" title="Перемотать сюда">на ' + fmt(vt) + '</span>, ' : '') + time + '</span>';
    const ts = d.querySelector('.ts'); if (ts) ts.onclick = () => seekTo(+ts.dataset.t);
    return d;
  }
  function addMsg(text, who, vt, name, quiet) {
    const box = $('messages');
    box.appendChild(bubble(text, who, vt));
    box.scrollTop = box.scrollHeight;
    if (quiet) return;
    const fs = $('fsChat'); const b = bubble(text, who, null);
    fs.appendChild(b); while (fs.children.length > 5) fs.firstChild.remove();
    setTimeout(() => b.classList.add('fade'), 8000); setTimeout(() => b.remove(), 9200);
    if (who === 'them' && document.hidden) document.title = (name || '') + ': ' + text.slice(0, 30);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Смотрим вместе'; });
  function sysMsg(text) { const d = document.createElement('div'); d.className = 'sys'; d.textContent = text; $('messages').appendChild(d); $('messages').scrollTop = $('messages').scrollHeight; }

  /* ---------- реакции ---------- */
  document.querySelectorAll('.react').forEach((b) => { b.onclick = () => { floatEmoji(b.dataset.e); wsSend({ t: 'react', e: b.dataset.e }); }; });
  function floatEmoji(e) { const el = document.createElement('div'); el.className = 'float'; el.textContent = e; el.style.left = 8 + Math.random() * 84 + '%'; $('reactions').appendChild(el); setTimeout(() => el.remove(), 2500); }

  /* ---------- приглашение ---------- */
  $('copyLinkBtn').onclick = async () => {
    let link = location.origin + '/';
    try { const j = await (await api('/api/invite')).json(); link += '?k=' + j.key; } catch (e) {}
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована — по ней можно зайти без пароля', 3500); }
    catch (e) { prompt('Скопируй ссылку:', link); }
  };
})();
