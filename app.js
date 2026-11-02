/* Кино вдвоём — совместный просмотр через WebRTC (PeerJS).
 * Хост выбирает фильм или серии → видео транслируется гостю (captureStream).
 * Гость может открыть те же файлы у себя → режим синхронизации.
 * Синхронизация: каждое нажатие отправляется сразу, плюс хост раз в секунду
 * рассылает эталонное состояние (и на паузе тоже) — потерянная команда исправляется сама.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const PREFIX = 'kinovdvoem-v1-';
  const ICE = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ] };
  const peerOpts = () => Object.assign({ config: ICE, debug: 1 }, window.KINO_PEER || {});

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
    file: svg('<path d="M4 6.5h6l2 2h8v10H4z"/>'),
    subs: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7 14.5h4M13 14.5h4M7 11h10"/>'),
    send: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    prev: svg('<path d="M6 5v14"/><path d="M18 5L9 12l9 7z" fill="currentColor"/>'),
    next: svg('<path d="M18 5v14"/><path d="M6 5l9 7-9 7z" fill="currentColor"/>'),
    list: svg('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.5" cy="6.5" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="17.5" r="1" fill="currentColor"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  };
  const setIcon = (id, ic) => { $(id).innerHTML = IC[ic]; };
  [['back10','back'],['fwd10','fwd'],['fsBtn','fs'],['changeBtn','file'],['subsCtl','subs'],['prevEp','prev'],['nextEp','next'],['epsBtn','list'],['epsClose','close']].forEach(([i, k]) => setIcon(i, k));
  $('sendBtn').innerHTML = IC.send;

  const params = new URLSearchParams(location.search);
  let roomId = params.get('r');
  const role = roomId && !params.get('h') ? 'guest' : 'host';

  let myName = localStorage.getItem('kino-name') || '';
  let partnerName = '';
  let peer = null, conn = null, call = null;
  let hasLocalFile = false;
  let guestMode = 'stream';          // гость: 'stream' | 'local'
  let partnerWantsStream = true;     // хост
  let remote = { playing: false, time: 0, duration: 0, at: 0 }; // эталон хоста
  let lastMyAction = 0;
  let subsVtt = null;

  // плейлист: у хоста — его файлы; у гостя — свои файлы (если открыл) и названия серий хоста
  let playlist = [];                 // File[] (мои)
  let epNames = [];                  // названия серий (общие)
  let curEp = 0;
  let autoNextT = null;

  const v = $('video');
  const player = $('player');

  /* ---------- лобби ---------- */
  $('nameInput').value = myName;
  if (role === 'guest') {
    $('enterBtn').textContent = 'Занять место';
    $('lobbySub').textContent = 'Тебя позвали на фильм. Займи место — кино начнётся, когда его включат.';
    $('stubSeats').innerHTML = 'место<br>2';
  }
  const enter = () => {
    myName = $('nameInput').value.trim() || (role === 'host' ? 'Я' : 'Гость');
    localStorage.setItem('kino-name', myName);
    $('seatMeName').textContent = myName;
    $('lobby').classList.remove('active');
    $('room').classList.add('active');
    startRoom();
  };
  $('enterBtn').onclick = enter;
  $('nameInput').onkeydown = (e) => e.key === 'Enter' && enter();

  /* ---------- утилиты ---------- */
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const prettyName = (n) => String(n || '').replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim();
  const natSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  let toastT;
  const toast = (t, ms = 2500) => {
    const el = $('toast'); el.textContent = t; el.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), ms);
  };
  // кресло собеседника
  const seat = (text, on) => { $('seatThemName').textContent = text; $('seatThem').classList.toggle('on', !!on); };
  const send = (msg) => { if (conn && conn.open) try { conn.send(msg); } catch (e) {} };
  const shareLink = () => location.origin + location.pathname + '?r=' + roomId;
  const pName = () => partnerName || 'собеседник';
  const isSeries = () => epNames.length > 1;

  function setEmpty(title, text, { loading = false, actions = false } = {}) {
    $('emptyState').classList.remove('hidden');
    $('emptyTitle').textContent = title;
    $('emptyText').textContent = text;
    $('loader').classList.toggle('hidden', !loading);
    $('emptyActions').classList.toggle('hidden', !actions);
  }

  /* ---------- комната / PeerJS ---------- */
  function startRoom() {
    if (role === 'host') {
      if (!roomId) {
        roomId = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
        history.replaceState(null, '', '?r=' + roomId + '&h=1');
      }
      seat('свободно');
      createHostPeer();
    } else {
      $('copyLinkBtn').classList.add('hidden');
      $('pickLabel').textContent = 'У меня есть фильм';
      $('pickHint').textContent = 'открыть свой файл';
      $('seriesLabel').textContent = 'У меня есть серии';
      $('seriesHint').textContent = 'выдели все сразу';
      setEmpty('Подключаемся', 'Ищем зал по ссылке.', { loading: true });
      seat('подключаемся…');
      createGuestPeer();
    }
    renderSource();
    tick();
  }

  function createHostPeer(attempt = 0) {
    peer = new Peer(PREFIX + roomId, peerOpts());
    peer.on('connection', (c) => {
      if (conn && conn.open) { try { conn.close(); } catch (e) {} }
      setupConn(c);
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempt < 8) {
        peer.destroy(); setTimeout(() => createHostPeer(attempt + 1), 2500);
      } else if (err.type !== 'peer-unavailable') toast('Проблема с сетью: ' + err.type, 5000);
    });
  }

  function createGuestPeer() {
    peer = new Peer(peerOpts());
    peer.on('open', connectToHost);
    peer.on('call', (c) => {
      if (call) try { call.close(); } catch (e) {}
      call = c;
      c.answer();
      c.on('stream', onRemoteStream);
      c.on('close', () => { if (call === c) call = null; });
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        seat('зал закрыт');
        setEmpty('Зал ещё закрыт', 'Тот, кто тебя позвал, пока не открыл страницу. Подключимся сами, как только он появится.', { loading: true });
        setTimeout(connectToHost, 4000);
      }
    });
  }
  function connectToHost() {
    if (conn && conn.open) return;
    setupConn(peer.connect(PREFIX + roomId, { reliable: true }));
  }

  function setupConn(c) {
    conn = c;
    c.on('open', () => {
      send({ t: 'hello', name: myName, mode: guestMode });
      if (subsVtt) send({ t: 'subs', vtt: subsVtt });
    });
    c.on('data', onData);
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      seat(partnerName ? partnerName + ' вышел(ла)' : 'свободно');
      sysMsg(pName() + ' вышел(ла) из зала');
      if (role === 'guest') setTimeout(connectToHost, 3000);
      if (role === 'host' && call) { try { call.close(); } catch (e) {} call = null; }
      renderSource();
    });
  }

  /* ---------- входящие ---------- */
  function onData(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        partnerName = m.name || 'Собеседник';
        seat(partnerName, true);
        sysMsg(partnerName + ' в зале');
        if (role === 'host') {
          partnerWantsStream = m.mode !== 'local';
          sendFileInfo();
          if (hasLocalFile) { sendState(); if (partnerWantsStream) startCall(); }
        } else if (!hasLocalFile && !v.srcObject) guestWaiting();
        renderSource();
        break;
      case 'file':
        epNames = m.list || (m.name ? [m.name] : []);
        curEp = m.ep || 0;
        if (role === 'guest') {
          if (guestMode === 'local' && playlist.length) guestLoadMatching();
          else if (!v.srcObject) guestWaiting();
        }
        renderEps(); renderSource();
        break;
      case 'mode':
        partnerWantsStream = m.mode !== 'local';
        if (partnerWantsStream && hasLocalFile) startCall();
        else if (!partnerWantsStream && call) { try { call.close(); } catch (e) {} call = null; }
        renderSource();
        break;
      case 'state': {
        remote = { playing: m.playing, time: m.time, duration: m.duration, at: performance.now() };
        if (!hasLocalFile) break;
        if (role === 'guest' && m.ep !== undefined && m.ep !== curEp) break; // серия ещё грузится
        if (m.src === 'beat' && performance.now() - lastMyAction < 1500) break; // мой клик ещё в пути
        if (m.src === 'action' && m.by) toast(m.by + (m.playing ? ' включает' : ' ставит на паузу'), 1800);
        applyState(m, m.src === 'action' ? 0.5 : 1.5);
        if (role === 'host' && m.src === 'action') sendState('beat');
        break;
      }
      case 'cmd':
        if (role !== 'host' || !hasLocalFile) break;
        if (m.action === 'play') v.play().catch(() => {});
        if (m.action === 'pause') v.pause();
        if (m.action === 'seek') v.currentTime = m.time;
        if (m.action === 'ep') { playEp(m.i, true); toast(pName() + ' включает серию ' + (m.i + 1), 2200); break; }
        toast(pName() + ({ play: ' включает', pause: ' ставит на паузу', seek: ' перематывает на ' + fmt(m.time) }[m.action] || ''), 1800);
        setTimeout(() => sendState('action'), 60);
        break;
      case 'restream': if (role === 'host') restartCall('guest asked'); break;
      case 'chat': addMsg(m.text, 'them', m.vt); typingOff(); break;
      case 'typing': typingOn(); break;
      case 'react': floatEmoji(m.e); break;
      case 'subs': addSubs(m.vtt, false); toast('Субтитры добавлены'); break;
    }
  }

  /* ---------- синхронизация ---------- */
  function sendState(src = 'action') {
    if (!hasLocalFile) return;
    send({ t: 'state', src, ep: curEp, by: src === 'action' ? myName : undefined,
      playing: !v.paused && !v.ended, time: v.currentTime, duration: v.duration || 0 });
  }
  function applyState(m, tolerance) {
    if (Math.abs(v.currentTime - m.time) > tolerance) v.currentTime = m.time;
    if (m.playing && v.paused) v.play().catch(showTap);
    if (!m.playing && !v.paused) v.pause();
  }
  setInterval(() => { if (role === 'host' && hasLocalFile) sendState('beat'); }, 1000);

  // конец серии → следующая
  v.addEventListener('ended', () => {
    if (role !== 'host') return;
    sendState('beat');
    if (curEp < playlist.length - 1) {
      toast('Через 5 секунд — серия ' + (curEp + 2), 4800);
      clearTimeout(autoNextT);
      autoNextT = setTimeout(() => playEp(curEp + 1, true), 5000);
    }
  });

  /* ---------- трансляция (хост) ---------- */
  function capture() {
    if (v.captureStream) return v.captureStream();
    if (v.mozCaptureStream) return v.mozCaptureStream();
    return null;
  }
  async function startCall() {
    if (role !== 'host' || !conn || !conn.open || !partnerWantsStream || !hasLocalFile) return;
    if (call) { try { call.close(); } catch (e) {} call = null; }
    if (v.readyState < 2) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    const stream = capture();
    capStream = stream; window.__cs = stream;
    if (!stream) { toast('Этот браузер не умеет транслировать видео. Открой сайт в Chrome или Edge.', 6000); return; }
    const t0 = performance.now();
    while (stream.getTracks().length < 2 && performance.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 100));
    stream.getVideoTracks().forEach((t) => { try { t.contentHint = 'motion'; } catch (e) {} });
    call = peer.call(conn.peer, stream);
    setTimeout(() => {
      const pc = call && call.peerConnection;
      if (!pc) return;
      pc.getSenders().forEach((s) => {
        if (!s.track || s.track.kind !== 'video') return;
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 8_000_000;
        s.setParameters(p).catch(() => {});
      });
    }, 1500);
    renderSource();
  }

  // Chrome после конца видео/перезагрузки меняет дорожки captureStream —
  // подменяем их в трансляции, а если не выходит — перезапускаем звонок.
  let capStream = null, restartT = null;
  const restartCall = (why) => { clearTimeout(restartT); restartT = setTimeout(() => { if (role === 'host' && hasLocalFile && partnerWantsStream) startCall(); }, 300); };
  async function healTracks() {
    if (role !== 'host' || !call || !capStream) return;
    const pc = call.peerConnection;
    if (!pc) return;
    const live = { video: capStream.getVideoTracks().find((t) => t.readyState === 'live'), audio: capStream.getAudioTracks().find((t) => t.readyState === 'live') };
    for (const s of pc.getSenders()) {
      const kind = s.track ? s.track.kind : null;
      if (!kind) continue;
      if (!live[kind]) { if (kind === 'video') restartCall('no live track'); continue; }
      if (s.track !== live[kind]) { try { await s.replaceTrack(live[kind]); } catch (e) { restartCall('replace failed'); } }
    }
  }
  setInterval(healTracks, 1500);
  // после конца фильма следующий запуск — со свежей трансляцией
  let endedOnce = false;
  v.addEventListener('ended', () => { endedOnce = true; });
  v.addEventListener('play', () => { if (role === 'host' && endedOnce) { endedOnce = false; restartCall('replay'); } });

  /* ---------- приём трансляции (гость) ---------- */
  function onRemoteStream(s) {
    if (guestMode === 'local') return;
    $('emptyState').classList.add('hidden');
    v.srcObject = s;
    v.play().catch(showTap);
    renderSource();
  }
  // гость: если фильм идёт, а кадры не приходят — просим перезапустить трансляцию
  let frames = 0, lastFrames = 0, stuck = 0, lastAsk = 0;
  const countFrames = () => { frames++; v.requestVideoFrameCallback(countFrames); };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(countFrames);
  else setInterval(() => { frames += v.currentTime !== countFrames.t ? 1 : 0; countFrames.t = v.currentTime; }, 500);
  const askRestream = () => { lastAsk = performance.now(); send({ t: 'restream' }); };
  setInterval(() => {
    if (role !== 'guest' || guestMode !== 'stream' || !v.srcObject || !remote.playing) { stuck = 0; lastFrames = frames; return; }
    if (v.paused) v.play().catch(showTap);
    stuck = frames === lastFrames ? stuck + 1 : 0;
    lastFrames = frames;
    if (stuck >= 3 && performance.now() - lastAsk > 8000) askRestream();
  }, 1000);

  function showTap(err) {
    if (err && err.name !== 'NotAllowedError') return;
    $('tapOverlay').classList.remove('hidden');
  }
  v.addEventListener('playing', () => $('tapOverlay').classList.add('hidden'));
  $('tapOverlay').onclick = () => { $('tapOverlay').classList.add('hidden'); v.play().catch(() => {}); };

  function guestWaiting() {
    const title = epNames.length ? prettyName(epNames[curEp]) : '';
    if (title) setEmpty(title, 'Сейчас начнётся. Если эти файлы есть и у тебя — открой их, картинка будет в исходном качестве.', { loading: true, actions: true });
    else setEmpty(pName() + ' выбирает, что смотреть', 'Как только выберет — кино появится здесь.', { loading: true });
  }

  /* ---------- выбор файлов ---------- */
  const pickFiles = (files) => {
    files = [...files].filter((f) => f.type.startsWith('video/') || /\.(mkv|mp4|webm|mov|m4v|avi)$/i.test(f.name)).sort(natSort);
    if (!files.length) { toast('Среди выбранного нет видео', 3000); return; }
    if (role === 'host') { playlist = files; epNames = files.map((f) => f.name); playEp(0, false); }
    else { playlist = files; guestMode = 'local'; if (call) { try { call.close(); } catch (e) {} call = null; } send({ t: 'mode', mode: 'local' }); guestLoadMatching(); }
  };
  $('fileInput').onchange = (e) => { pickFiles(e.target.files); e.target.value = ''; };
  $('seriesInput').onchange = (e) => { pickFiles(e.target.files); e.target.value = ''; };
  $('changeBtn').onclick = () => $('seriesInput').click(); // можно выбрать один файл или несколько
  $('subsCtl').onclick = () => $('subsInput').click();

  // хост: включить серию i
  function playEp(i, autoplay) {
    if (i < 0 || i >= playlist.length) return;
    clearTimeout(autoNextT);
    curEp = i;
    loadFileIntoPlayer(playlist[i]);
    sendFileInfo();
    v.addEventListener('loadeddata', () => {
      if (autoplay) v.play().catch(() => {});
      setTimeout(() => sendState('action'), 100);
      startCall();
    }, { once: true });
    renderEps(); renderSource();
  }
  const sendFileInfo = () => send({ t: 'file', list: epNames, ep: curEp });

  // гость в режиме «свои файлы»: найти у себя ту же серию
  function guestLoadMatching() {
    if (!playlist.length) return;
    const want = epNames[curEp];
    let f = want && playlist.find((x) => x.name === want);
    if (!f) f = playlist[curEp] || (playlist.length === 1 ? playlist[0] : null);
    if (!f) { toast('У тебя нет серии ' + (curEp + 1) + ' — смотрим трансляцию', 4000); backToStream(); return; }
    if (want && f.name !== want) toast('Имена файлов отличаются — проверь, та ли это серия', 4000);
    loadFileIntoPlayer(f);
    v.addEventListener('loadedmetadata', () => {
      if (remote.at) applyState({ playing: remote.playing, time: remoteNow() }, 0.5);
    }, { once: true });
    renderSource();
  }

  function loadFileIntoPlayer(f) {
    v.srcObject = null;
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(f);
    hasLocalFile = true;
    $('emptyState').classList.add('hidden');
    v.addEventListener('error', () => toast('Браузер не открывает этот формат. Нужен mp4 (H.264).', 6000), { once: true });
  }

  function backToStream() {
    guestMode = 'stream';
    hasLocalFile = false;
    playlist = [];
    v.pause();
    if (v.src) { URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); }
    guestWaiting();
    send({ t: 'mode', mode: 'stream' });
    renderSource();
  }

  /* ---------- серии ---------- */
  const goEp = (i) => {
    if (i < 0 || i >= epNames.length) return;
    $('epsPanel').classList.add('hidden');
    if (role === 'host') playEp(i, true);
    else send({ t: 'cmd', action: 'ep', i });
  };
  $('prevEp').onclick = () => goEp(curEp - 1);
  $('nextEp').onclick = () => goEp(curEp + 1);
  $('epsBtn').onclick = () => $('epsPanel').classList.toggle('hidden');
  $('epsClose').onclick = () => $('epsPanel').classList.add('hidden');
  function renderEps() {
    const series = isSeries();
    ['prevEp', 'nextEp', 'epsBtn'].forEach((id) => $(id).classList.toggle('hidden', !series));
    if (!series) { $('epsPanel').classList.add('hidden'); return; }
    $('epsTitle').textContent = 'Серии: ' + epNames.length;
    const ol = $('epsList');
    ol.innerHTML = '';
    epNames.forEach((n, i) => {
      const li = document.createElement('li');
      if (i === curEp) li.className = 'cur';
      li.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="t">' + esc(prettyName(n)) + '</span>';
      li.onclick = () => goEp(i);
      ol.appendChild(li);
    });
  }

  function renderSource() {
    const bar = $('sourceBar');
    bar.innerHTML = '';
    const add = (html) => { const s = document.createElement('span'); s.innerHTML = html; bar.appendChild(s); };
    const btn = (text, fn) => { const b = document.createElement('button'); b.textContent = text; b.onclick = fn; bar.appendChild(b); };
    const title = epNames.length ? (isSeries() ? 'Серия ' + (curEp + 1) + ' из ' + epNames.length + ': ' : '') + '<b>' + esc(prettyName(epNames[curEp])) + '</b>' : '';
    if (role === 'host') {
      if (!hasLocalFile) { add(conn ? pName() + ' уже в зале. Выбери, что смотреть.' : 'Нажми «Пригласить» и отправь ссылку.'); return; }
      add(title);
      add(!conn ? 'ждём второго зрителя' : esc(pName()) + (partnerWantsStream ? ' смотрит твою трансляцию' : ' смотрит со своих файлов, синхронно с тобой'));
    } else if (guestMode === 'local') {
      add(title);
      btn('Смотреть трансляцию', backToStream);
    } else if (v.srcObject) {
      add(title);
      btn('Нет картинки? Переподключить', () => { askRestream(); toast('Переподключаем видео…'); });
      btn('Открыть свои файлы — качество лучше', () => $(isSeries() ? 'seriesInput' : 'fileInput').click());
    }
  }

  /* ---------- субтитры ---------- */
  $('subsInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    let text = await f.text();
    if (!/^WEBVTT/.test(text.trim())) text = 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    addSubs(text, true);
    e.target.value = '';
  };
  function addSubs(vtt, share) {
    subsVtt = vtt;
    [...v.querySelectorAll('track')].forEach((t) => t.remove());
    const tr = document.createElement('track');
    tr.kind = 'subtitles'; tr.label = 'Субтитры'; tr.default = true;
    tr.src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    v.appendChild(tr);
    setTimeout(() => { if (v.textTracks[0]) v.textTracks[0].mode = 'showing'; }, 50);
    if (share) { send({ t: 'subs', vtt }); toast('Субтитры добавлены'); }
  }

  /* ---------- управление ---------- */
  const remoteNow = () => {
    if (!remote.at) return 0;
    const t = remote.time + (remote.playing ? (performance.now() - remote.at) / 1000 : 0);
    return remote.duration ? Math.min(t, remote.duration) : t;
  };
  const curTime = () => (hasLocalFile ? v.currentTime : remoteNow());
  const duration = () => (hasLocalFile ? v.duration : remote.duration) || 0;
  const isPlaying = () => (hasLocalFile ? !v.paused : remote.playing);

  function togglePlay() {
    lastMyAction = performance.now();
    if (hasLocalFile) {
      if (v.paused) v.play().catch(showTap); else v.pause();
      sendState('action');
      return;
    }
    if (role === 'guest' && v.srcObject) {
      if (v.paused) v.play().catch(() => {});
      const action = remote.playing ? 'pause' : 'play';
      remote.time = remoteNow(); remote.playing = !remote.playing; remote.at = performance.now();
      send({ t: 'cmd', action });
    }
  }
  function seekTo(t) {
    t = Math.max(0, Math.min(t, duration() || 0));
    lastMyAction = performance.now();
    if (hasLocalFile) { v.currentTime = t; sendState('action'); }
    else if (role === 'guest' && v.srcObject) { send({ t: 'cmd', action: 'seek', time: t }); remote.time = t; remote.at = performance.now(); }
  }

  $('playBtn').onclick = togglePlay;
  $('back10').onclick = () => seekTo(curTime() - 10);
  $('fwd10').onclick = () => seekTo(curTime() + 10);
  v.addEventListener('click', togglePlay);
  v.addEventListener('dblclick', toggleFs);

  const updVol = () => { $('muteBtn').innerHTML = v.muted || v.volume === 0 ? IC.mute : IC.vol; };
  $('volume').oninput = (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; updVol(); };
  $('muteBtn').onclick = () => { v.muted = !v.muted; updVol(); };
  updVol();

  // перемотка
  const seekWrap = $('seekWrap');
  const pctAt = (e) => { const r = $('seek').getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  let dragging = false;
  const preview = (p) => { $('seekFill').style.width = p * 100 + '%'; $('seekHead').style.left = p * 100 + '%'; };
  seekWrap.addEventListener('pointerdown', (e) => { if (!duration()) return; dragging = true; seekWrap.setPointerCapture(e.pointerId); preview(pctAt(e)); });
  seekWrap.addEventListener('pointermove', (e) => {
    const p = pctAt(e);
    $('seekTip').style.left = p * 100 + '%';
    $('seekTip').textContent = fmt(p * duration());
    if (dragging) preview(p);
  });
  seekWrap.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; seekTo(pctAt(e) * duration()); });

  let lastPlayIcon = null;
  function tick() {
    const d = duration(), t = curTime();
    if (!dragging) preview(d ? t / d : 0);
    $('time').textContent = fmt(t) + ' / ' + fmt(d);
    const pl = isPlaying();
    if (pl !== lastPlayIcon) { setIcon('playBtn', pl ? 'pause' : 'play'); lastPlayIcon = pl; }
    if (hasLocalFile && v.buffered.length && d) $('seekBuf').style.width = (v.buffered.end(v.buffered.length - 1) / d) * 100 + '%';
    requestAnimationFrame(tick);
  }

  // во весь экран — с чатом поверх
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
  fsForm.innerHTML = '<input maxlength="500" placeholder="Написать (Enter)">';
  $('fsDock').appendChild(fsForm);
  fsForm.onsubmit = (e) => { e.preventDefault(); const i = fsForm.firstChild; sendChat(i.value); i.value = ''; i.blur(); };
  const fsChange = () => fsForm.classList.toggle('hidden', !inFs());
  fsForm.firstChild.addEventListener('focus', () => wake());
  document.addEventListener('fullscreenchange', fsChange);
  new MutationObserver(fsChange).observe(player, { attributes: true, attributeFilter: ['class'] });

  // автоскрытие панели
  let idleT;
  const wake = () => {
    player.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (isPlaying()) player.classList.add('idle'); }, 2600);
  };
  player.addEventListener('pointermove', wake);
  player.addEventListener('pointerdown', wake);

  // клавиши
  document.addEventListener('keydown', (e) => {
    if (!$('room').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.code === 'Space' || e.code === 'KeyK') { e.preventDefault(); togglePlay(); wake(); }
    else if (e.key === 'ArrowLeft') { seekTo(curTime() - 5); wake(); }
    else if (e.key === 'ArrowRight') { seekTo(curTime() + 5); wake(); }
    else if (e.code === 'KeyF') toggleFs();
    else if (e.code === 'KeyM') { v.muted = !v.muted; updVol(); }
    else if (e.code === 'KeyN' && isSeries()) goEp(curEp + 1);
    else if (e.key === 'Enter') { e.preventDefault(); (inFs() ? fsForm.firstChild : $('chatInput')).focus(); }
  });

  /* ---------- чат ---------- */
  $('chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('chatInput').value); $('chatInput').value = ''; };
  function sendChat(text) {
    text = (text || '').trim();
    if (!text) return;
    const vt = duration() ? curTime() : null;
    addMsg(text, 'me', vt);
    send({ t: 'chat', text, name: myName, vt });
  }
  let lastTyping = 0;
  $('chatInput').addEventListener('input', () => {
    if (performance.now() - lastTyping > 1500) { lastTyping = performance.now(); send({ t: 'typing' }); }
  });
  let typingT;
  const typingOn = () => {
    $('typing').textContent = pName() + ' печатает…';
    $('typing').classList.remove('hidden');
    clearTimeout(typingT); typingT = setTimeout(typingOff, 3000);
  };
  const typingOff = () => $('typing').classList.add('hidden');

  function bubble(text, who, vt) {
    const d = document.createElement('div');
    d.className = 'msg ' + who;
    const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = esc(text) + '<span class="meta">' +
      (vt != null ? '<span class="ts" data-t="' + vt + '" title="Перемотать сюда">на ' + fmt(vt) + '</span>, ' : '') + time + '</span>';
    const ts = d.querySelector('.ts');
    if (ts) ts.onclick = () => seekTo(+ts.dataset.t);
    return d;
  }
  function addMsg(text, who, vt) {
    const box = $('messages');
    box.appendChild(bubble(text, who, vt));
    box.scrollTop = box.scrollHeight;
    const fs = $('fsChat');
    const b = bubble(text, who, null);
    fs.appendChild(b);
    while (fs.children.length > 5) fs.firstChild.remove();
    setTimeout(() => b.classList.add('fade'), 8000);
    setTimeout(() => b.remove(), 9200);
    if (who === 'them' && document.hidden) document.title = pName() + ': ' + text.slice(0, 30);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Кино вдвоём'; });
  function sysMsg(text) {
    const d = document.createElement('div');
    d.className = 'sys'; d.textContent = text;
    $('messages').appendChild(d);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  /* ---------- реакции ---------- */
  document.querySelectorAll('.react').forEach((b) => { b.onclick = () => { floatEmoji(b.dataset.e); send({ t: 'react', e: b.dataset.e }); }; });
  function floatEmoji(e) {
    const el = document.createElement('div');
    el.className = 'float'; el.textContent = e;
    el.style.left = 8 + Math.random() * 84 + '%';
    $('reactions').appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  /* ---------- приглашение ---------- */
  $('copyLinkBtn').onclick = async () => {
    const link = shareLink();
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована. Отправь её.'); }
    catch (e) { prompt('Скопируй ссылку:', link); }
  };
  window.addEventListener('beforeunload', () => { try { peer && peer.destroy(); } catch (e) {} });
})();
