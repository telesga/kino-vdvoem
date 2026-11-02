/* Кино вдвоём — совместный просмотр через WebRTC (PeerJS).
 * Хост выбирает файл → видео транслируется гостю (captureStream).
 * Гость может открыть тот же файл у себя → режим синхронизации (лучшее качество).
 * Чат, реакции и субтитры идут по data-каналу. Сервер не нужен.
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

  const params = new URLSearchParams(location.search);
  let roomId = params.get('r');
  let role = roomId && !params.get('h') ? 'guest' : 'host';

  let myName = localStorage.getItem('kino-name') || '';
  let partnerName = '';
  let peer = null, conn = null, call = null;
  let hostFileName = '';           // имя файла (у хоста — свой, у гостя — хоста)
  let hasLocalFile = false;        // есть ли у меня локальный файл в плеере
  let guestMode = 'stream';        // для гостя: 'stream' | 'local'
  let partnerWantsStream = true;   // для хоста
  let remote = { playing: false, time: 0, duration: 0, at: 0 }; // состояние хоста (для гостя-трансляции)
  let suppressUntil = 0;
  let subsVtt = null;

  const v = $('video');
  const player = $('player');

  /* ---------- лобби ---------- */
  $('nameInput').value = myName;
  if (role === 'guest') {
    $('enterBtn').textContent = 'Войти в комнату';
    $('lobbySub').textContent = 'Тебя пригласили посмотреть фильм вместе 💕';
  }
  const enter = () => {
    myName = $('nameInput').value.trim() || (role === 'host' ? 'Я' : 'Гость');
    localStorage.setItem('kino-name', myName);
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
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let toastT;
  const toast = (t, ms = 2500) => {
    const el = $('toast'); el.textContent = t; el.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), ms);
  };
  const setStatus = (text, cls) => {
    $('statusText').textContent = text;
    $('status').className = 'status ' + (cls || '');
  };
  const send = (msg) => { if (conn && conn.open) try { conn.send(msg); } catch (e) {} };
  const isLocal = () => hasLocalFile;
  const shareLink = () => location.origin + location.pathname + '?r=' + roomId;

  /* ---------- комната / PeerJS ---------- */
  function startRoom() {
    if (role === 'host') {
      if (!roomId) {
        roomId = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
        history.replaceState(null, '', '?r=' + roomId + '&h=1');
      }
      setStatus('Отправь ссылку и ждём собеседника…');
      createHostPeer();
    } else {
      $('emptyTitle').textContent = 'Подключаемся…';
      $('emptyText').textContent = 'Ищем комнату';
      $('pickBtn').firstChild.textContent = '📁 У меня есть этот файл';
      $('emptyFoot').textContent = 'Если у тебя есть тот же файл — открой его: качество будет как в оригинале, а плеер синхронизируется.';
      $('copyLinkBtn').classList.add('hidden');
      setStatus('Подключаемся…');
      createGuestPeer();
    }
    renderSourceBar();
    tick();
  }

  function createHostPeer(attempt = 0) {
    peer = new Peer(PREFIX + roomId, peerOpts());
    peer.on('open', () => { if (!conn) setStatus('Отправь ссылку и ждём собеседника…'); });
    peer.on('connection', (c) => {
      if (conn && conn.open) { try { conn.close(); } catch (e) {} }
      setupConn(c);
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id' && attempt < 8) {
        peer.destroy(); setTimeout(() => createHostPeer(attempt + 1), 2500);
        setStatus('Восстанавливаем комнату…');
      } else if (err.type !== 'peer-unavailable') {
        setStatus('Ошибка сети: ' + err.type, 'bad');
      }
    });
  }

  function createGuestPeer() {
    peer = new Peer(peerOpts());
    peer.on('open', connectToHost);
    peer.on('call', (c) => {
      if (call) try { call.close(); } catch (e) {}
      call = c;
      c.answer();
      c.on('stream', (s) => onRemoteStream(s));
      c.on('close', () => { if (call === c) call = null; });
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        setStatus('Комната пока не в сети — ждём…', 'bad');
        $('emptyTitle').textContent = 'Комната не найдена';
        $('emptyText').textContent = 'Похоже, хозяин комнаты ещё не открыл её. Пробуем снова…';
        setTimeout(connectToHost, 4000);
      }
    });
  }

  function connectToHost() {
    if (conn && conn.open) return;
    const c = peer.connect(PREFIX + roomId, { reliable: true });
    setupConn(c);
  }

  function setupConn(c) {
    conn = c;
    c.on('open', () => {
      setStatus('На связи', 'ok');
      send({ t: 'hello', name: myName, role, mode: guestMode });
      if (role === 'host' && hasLocalFile) sendState();
      if (subsVtt) send({ t: 'subs', vtt: subsVtt });
    });
    c.on('data', onData);
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      setStatus((partnerName || 'Собеседник') + ' отключил(ась)ся', 'bad');
      sysMsg((partnerName || 'Собеседник') + ' вышел(ла)');
      $('whoOnline').textContent = '';
      if (role === 'guest') setTimeout(connectToHost, 3000);
      if (role === 'host' && call) { try { call.close(); } catch (e) {} call = null; }
    });
    c.on('error', () => {});
  }

  /* ---------- входящие сообщения ---------- */
  function onData(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        partnerName = m.name || 'Собеседник';
        $('whoOnline').textContent = '● ' + partnerName;
        setStatus('Вместе с ' + partnerName, 'ok');
        sysMsg(partnerName + ' в комнате 💫');
        if (role === 'host') {
          partnerWantsStream = m.mode !== 'local';
          send({ t: 'file', name: hostFileName });
          if (hasLocalFile) { sendState(); if (partnerWantsStream) startCall(); }
        }
        renderSourceBar();
        break;
      case 'file':
        hostFileName = m.name || '';
        if (role === 'guest' && !hasLocalFile && !v.srcObject) guestWaitingText();
        renderSourceBar();
        break;
      case 'mode':
        partnerWantsStream = m.mode !== 'local';
        if (partnerWantsStream && hasLocalFile) startCall();
        else if (!partnerWantsStream && call) { try { call.close(); } catch (e) {} call = null; }
        renderSourceBar();
        break;
      case 'state':
        remote = { playing: m.playing, time: m.time, duration: m.duration, at: performance.now() };
        if (hasLocalFile) applyState(m);
        break;
      case 'cmd':
        if (role === 'host' && hasLocalFile) {
          if (m.action === 'play') v.play().catch(() => {});
          if (m.action === 'pause') v.pause();
          if (m.action === 'seek') v.currentTime = m.time;
          toast(partnerName + ': ' + ({ play: '▶ пуск', pause: '⏸ пауза', seek: '⏩ перемотка' }[m.action] || ''));
        }
        break;
      case 'chat': addMsg(m.text, 'them', m.name, m.vt); typingOff(); break;
      case 'typing': typingOn(); break;
      case 'react': floatEmoji(m.e); break;
      case 'subs': addSubs(m.vtt, false); toast('Субтитры получены'); break;
    }
  }

  /* ---------- синхронизация ---------- */
  const suppressed = () => performance.now() < suppressUntil;
  function sendState() {
    if (!hasLocalFile) return;
    send({ t: 'state', playing: !v.paused, time: v.currentTime, duration: v.duration || 0 });
  }
  function applyState(m) {
    suppressUntil = performance.now() + 700;
    const target = m.time + (m.playing ? 0.15 : 0);
    if (Math.abs(v.currentTime - target) > 1.2) v.currentTime = target;
    if (m.playing && v.paused) v.play().catch(showTap);
    if (!m.playing && !v.paused) v.pause();
  }
  ['play', 'pause', 'seeked'].forEach((ev) => v.addEventListener(ev, () => {
    if (!hasLocalFile || suppressed()) return;
    // гость с файлом шлёт состояние только на свои действия; хост — всегда (он главный)
    sendState();
  }));
  // хост периодически рассылает состояние для подстройки
  setInterval(() => { if (role === 'host' && hasLocalFile && !v.paused) sendState(); }, 2000);

  /* ---------- трансляция (хост) ---------- */
  function captureStream() {
    if (v.captureStream) return v.captureStream();
    if (v.mozCaptureStream) return v.mozCaptureStream();
    return null;
  }
  async function startCall() {
    if (role !== 'host' || !conn || !conn.open || !partnerWantsStream || !hasLocalFile) return;
    if (call) { try { call.close(); } catch (e) {} call = null; }
    if (v.readyState < 2) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    const stream = captureStream();
    if (!stream) { toast('Твой браузер не умеет транслировать видео. Открой сайт в Chrome/Edge.', 6000); return; }
    // ждём, пока появятся видео- и аудиодорожки
    const t0 = performance.now();
    while (stream.getTracks().length < 2 && performance.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 100));
    stream.getVideoTracks().forEach((t) => { try { t.contentHint = 'motion'; } catch (e) {} });
    call = peer.call(conn.peer, stream);
    call.on('close', () => {});
    // поднимаем битрейт видео для качества
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
    renderSourceBar();
  }

  /* ---------- приём трансляции (гость) ---------- */
  function onRemoteStream(s) {
    if (guestMode === 'local') return;
    $('emptyState').classList.add('hidden');
    v.srcObject = s;
    v.play().catch(showTap);
    renderSourceBar();
  }
  function showTap(err) {
    if (err && err.name !== 'NotAllowedError') return;
    $('tapOverlay').classList.remove('hidden');
  }
  v.addEventListener('playing', () => $('tapOverlay').classList.add('hidden'));
  $('tapOverlay').onclick = () => { $('tapOverlay').classList.add('hidden'); v.play().catch(() => {}); };

  function guestWaitingText() {
    $('emptyState').classList.remove('hidden');
    $('emptyTitle').innerHTML = '<div class="spinner"></div>';
    $('emptyText').textContent = hostFileName
      ? 'Сейчас начнётся трансляция «' + hostFileName + '»…'
      : 'Ждём, когда ' + (partnerName || 'собеседник') + ' выберет фильм 🍿';
  }

  /* ---------- выбор файла ---------- */
  $('fileInput').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    loadFile(f);
    e.target.value = '';
  };
  $('changeBtn').onclick = () => $('fileInput').click();

  function loadFile(f) {
    if (v.srcObject) { v.srcObject = null; }
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(f);
    hasLocalFile = true;
    $('emptyState').classList.add('hidden');
    if (role === 'host') {
      hostFileName = f.name;
      send({ t: 'file', name: f.name });
      v.addEventListener('loadeddata', () => { sendState(); startCall(); }, { once: true });
    } else {
      guestMode = 'local';
      if (call) { try { call.close(); } catch (e) {} call = null; }
      send({ t: 'mode', mode: 'local' });
      v.addEventListener('loadedmetadata', () => {
        if (remote.at) {
          const t = remote.time + (remote.playing ? (performance.now() - remote.at) / 1000 : 0);
          applyState({ playing: remote.playing, time: t });
        }
      }, { once: true });
      if (hostFileName && f.name !== hostFileName) toast('Внимание: у собеседника файл «' + hostFileName + '»', 5000);
    }
    v.addEventListener('error', () => toast('Браузер не может открыть этот формат. Попробуй mp4 (H.264).', 6000), { once: true });
    renderSourceBar();
  }

  function backToStream() {
    guestMode = 'stream';
    hasLocalFile = false;
    v.pause();
    if (v.src) { URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); }
    guestWaitingText();
    send({ t: 'mode', mode: 'stream' });
    renderSourceBar();
  }

  function renderSourceBar() {
    const bar = $('sourceBar');
    bar.innerHTML = '';
    const p = partnerName || 'собеседник';
    if (role === 'host') {
      if (!hasLocalFile) { bar.textContent = 'Выбери фильм — ' + p + ' увидит его сразу после выбора.'; return; }
      const s = document.createElement('span');
      s.innerHTML = '🎞 <b>' + esc(hostFileName) + '</b> · ' +
        (!conn ? 'ждём собеседника' : partnerWantsStream ? '📡 транслируется для ' + esc(p) : '🔄 у ' + esc(p) + ' свой файл, синхронизировано');
      bar.appendChild(s);
    } else {
      if (guestMode === 'local') {
        const s = document.createElement('span');
        s.innerHTML = '🎞 Свой файл, синхронизировано с ' + esc(p);
        const b = document.createElement('button');
        b.className = 'btn ghost small'; b.textContent = '📡 Вернуться к трансляции';
        b.onclick = backToStream;
        bar.append(s, b);
      } else {
        const s = document.createElement('span');
        s.innerHTML = v.srcObject ? '📡 Трансляция от ' + esc(p) + (hostFileName ? ' · <b>' + esc(hostFileName) + '</b>' : '') : '';
        const b = document.createElement('button');
        b.className = 'btn ghost small'; b.textContent = '📁 У меня есть этот файл (лучше качество)';
        b.onclick = () => $('fileInput').click();
        bar.append(s, b);
      }
    }
  }

  /* ---------- субтитры ---------- */
  $('subsInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    let text = await f.text();
    if (!/^WEBVTT/.test(text.trim())) text = srtToVtt(text);
    addSubs(text, true);
    e.target.value = '';
  };
  function srtToVtt(s) {
    return 'WEBVTT\n\n' + s.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }
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

  /* ---------- плеер: управление ---------- */
  const curTime = () => {
    if (hasLocalFile) return v.currentTime;
    if (!remote.at) return 0;
    return Math.min(remote.time + (remote.playing ? (performance.now() - remote.at) / 1000 : 0), remote.duration || Infinity);
  };
  const duration = () => (hasLocalFile ? v.duration : remote.duration) || 0;
  const isPlaying = () => (hasLocalFile ? !v.paused : remote.playing);

  function togglePlay() {
    if (hasLocalFile) { v.paused ? v.play().catch(() => {}) : v.pause(); return; }
    if (role === 'guest') {
      if (v.srcObject && v.paused) v.play().catch(() => {});
      send({ t: 'cmd', action: remote.playing ? 'pause' : 'play' });
    }
  }
  function seekTo(t) {
    t = Math.max(0, Math.min(t, duration() || 0));
    if (hasLocalFile) v.currentTime = t;
    else if (role === 'guest') { send({ t: 'cmd', action: 'seek', time: t }); remote.time = t; remote.at = performance.now(); }
  }

  $('playBtn').onclick = togglePlay;
  $('back10').onclick = () => seekTo(curTime() - 10);
  $('fwd10').onclick = () => seekTo(curTime() + 10);
  v.addEventListener('click', togglePlay);
  v.addEventListener('dblclick', toggleFs);

  // громкость
  $('volume').oninput = (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; updVol(); };
  $('muteBtn').onclick = () => { v.muted = !v.muted; updVol(); };
  const updVol = () => { $('muteBtn').textContent = v.muted || v.volume === 0 ? '🔇' : v.volume < 0.5 ? '🔉' : '🔊'; };

  // полоса перемотки
  const seekWrap = $('seek').parentElement;
  const pctAt = (e) => {
    const r = $('seek').getBoundingClientRect();
    const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    return Math.max(0, Math.min(1, x / r.width));
  };
  let dragging = false;
  seekWrap.addEventListener('pointerdown', (e) => { dragging = true; seekWrap.setPointerCapture(e.pointerId); preview(pctAt(e)); });
  seekWrap.addEventListener('pointermove', (e) => {
    const p = pctAt(e);
    $('seekTip').style.left = p * 100 + '%';
    $('seekTip').textContent = fmt(p * duration());
    if (dragging) preview(p);
  });
  seekWrap.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; seekTo(pctAt(e) * duration()); });
  const preview = (p) => { $('seekFill').style.width = p * 100 + '%'; $('seekThumb').style.left = p * 100 + '%'; };

  function tick() {
    const d = duration(), t = curTime();
    if (!dragging) preview(d ? t / d : 0);
    $('time').textContent = fmt(t) + ' / ' + fmt(d);
    $('playBtn').textContent = isPlaying() ? '⏸' : '▶';
    if (hasLocalFile && v.buffered.length && d) $('seekBuf').style.width = (v.buffered.end(v.buffered.length - 1) / d) * 100 + '%';
    requestAnimationFrame(tick);
  }

  // полный экран (с чатом поверх)
  function toggleFs() {
    if (document.fullscreenElement || player.classList.contains('pseudo-fs')) {
      if (document.fullscreenElement) document.exitFullscreen();
      player.classList.remove('pseudo-fs');
    } else if (player.requestFullscreen) {
      player.requestFullscreen().catch(() => player.classList.add('pseudo-fs'));
    } else if (player.webkitRequestFullscreen) {
      player.webkitRequestFullscreen();
    } else {
      player.classList.add('pseudo-fs');
    }
  }
  $('fsBtn').onclick = toggleFs;
  // поле ввода чата в полноэкранном режиме
  const fsInputWrap = document.createElement('form');
  fsInputWrap.className = 'fs-input hidden';
  fsInputWrap.innerHTML = '<input maxlength="500" placeholder="Сообщение… (Enter)">';
  player.appendChild(fsInputWrap);
  fsInputWrap.onsubmit = (e) => { e.preventDefault(); const i = fsInputWrap.firstChild; sendChat(i.value); i.value = ''; };
  const fsChange = () => {
    const on = !!document.fullscreenElement || player.classList.contains('pseudo-fs');
    fsInputWrap.classList.toggle('hidden', !on);
  };
  document.addEventListener('fullscreenchange', fsChange);
  new MutationObserver(fsChange).observe(player, { attributes: true, attributeFilter: ['class'] });

  // автоскрытие панели
  let idleT;
  const wake = () => {
    player.classList.remove('idle');
    clearTimeout(idleT);
    idleT = setTimeout(() => { if (isPlaying()) player.classList.add('idle'); }, 2800);
  };
  player.addEventListener('pointermove', wake);
  player.addEventListener('pointerdown', wake);

  // горячие клавиши
  document.addEventListener('keydown', (e) => {
    if (!$('room').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.code === 'Space' || e.key === 'k') { e.preventDefault(); togglePlay(); wake(); }
    else if (e.key === 'ArrowLeft') { seekTo(curTime() - 5); wake(); }
    else if (e.key === 'ArrowRight') { seekTo(curTime() + 5); wake(); }
    else if (e.key === 'f' || e.key === 'а') toggleFs();
    else if (e.key === 'm' || e.key === 'ь') { v.muted = !v.muted; updVol(); }
    else if (e.key === 'Enter') { const fi = fsInputWrap.firstChild; (fsInputWrap.classList.contains('hidden') ? $('chatInput') : fi).focus(); }
  });

  /* ---------- чат ---------- */
  $('chatForm').onsubmit = (e) => { e.preventDefault(); sendChat($('chatInput').value); $('chatInput').value = ''; };
  function sendChat(text) {
    text = (text || '').trim();
    if (!text) return;
    const vt = duration() ? curTime() : null;
    addMsg(text, 'me', myName, vt);
    send({ t: 'chat', text, name: myName, vt });
  }
  let lastTyping = 0;
  $('chatInput').addEventListener('input', () => {
    if (performance.now() - lastTyping > 1500) { lastTyping = performance.now(); send({ t: 'typing' }); }
  });
  let typingT;
  const typingOn = () => {
    $('typing').textContent = (partnerName || 'Собеседник') + ' печатает…';
    $('typing').classList.remove('hidden');
    clearTimeout(typingT); typingT = setTimeout(typingOff, 3000);
  };
  const typingOff = () => $('typing').classList.add('hidden');

  function bubble(text, who, name, vt) {
    const d = document.createElement('div');
    d.className = 'msg ' + who;
    const time = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = esc(text) + '<div class="meta">' + (who === 'them' ? esc(name || '') + ' · ' : '') + time +
      (vt != null ? ' · <span class="ts" data-t="' + vt + '">🎞 ' + fmt(vt) + '</span>' : '') + '</div>';
    const ts = d.querySelector('.ts');
    if (ts) ts.onclick = () => seekTo(+ts.dataset.t);
    return d;
  }
  function addMsg(text, who, name, vt) {
    const box = $('messages');
    box.appendChild(bubble(text, who, name, vt));
    box.scrollTop = box.scrollHeight;
    // копия в оверлей полноэкранного режима
    const fs = $('fsChat');
    const b = bubble(text, who, name, null);
    fs.appendChild(b);
    while (fs.children.length > 6) fs.firstChild.remove();
    setTimeout(() => b.classList.add('fade'), 8000);
    setTimeout(() => b.remove(), 9500);
    if (who === 'them' && document.hidden) document.title = '💬 ' + (name || '') + ': ' + text.slice(0, 30);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Кино вдвоём'; });
  function sysMsg(text) {
    const d = document.createElement('div');
    d.className = 'sys'; d.textContent = text;
    $('messages').appendChild(d);
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  /* ---------- реакции ---------- */
  document.querySelectorAll('.react').forEach((b) => b.onclick = () => { floatEmoji(b.dataset.e); send({ t: 'react', e: b.dataset.e }); });
  function floatEmoji(e) {
    const el = document.createElement('div');
    el.className = 'float';
    el.textContent = e;
    el.style.left = 10 + Math.random() * 80 + '%';
    $('reactions').appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  /* ---------- ссылка ---------- */
  $('copyLinkBtn').onclick = async () => {
    const link = shareLink();
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована 💌'); }
    catch (e) { prompt('Скопируй ссылку:', link); }
  };
  window.addEventListener('beforeunload', () => { try { peer && peer.destroy(); } catch (e) {} });
})();
