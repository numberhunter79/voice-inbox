// Voice Inbox: hold the button, speak, let go.
// Notes are saved on the phone first, then sent to the owner's Drive.
const VERSION = '0.1.0';
const KEEP_DAYS = 14;            // sent notes are cleared from the phone after this
const MAX_REC_MS = 15 * 60e3;    // safety stop
const TAP_MS = 450;              // shorter press = hands-free mode

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

// ---------- storage (IndexedDB) ----------
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('voice-inbox', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('captures', { keyPath: 'id' });
      d.createObjectStore('chunks', { keyPath: ['id', 'seq'] });
      d.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Storage aborted'));
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const put = (store, v) => tx(store, 'readwrite', s => req(s.put(v)));
const get = (store, k) => tx(store, 'readonly', s => req(s.get(k)));
const del = (store, k) => tx(store, 'readwrite', s => req(s.delete(k)));
const all = (store) => tx(store, 'readonly', s => req(s.getAll()));
const delRange = (store, range) => tx(store, 'readwrite', s => req(s.delete(range)));

async function update(id, patch) {
  const c = await get('captures', id);
  if (!c) return null;
  Object.assign(c, patch);
  await put('captures', c);
  return c;
}

// ---------- config (which link this phone uses) ----------
let cfg = null;   // { api, token, role, name, linkName }
async function loadCfg() {
  try { cfg = (await get('kv', 'cfg'))?.v || null; } catch { cfg = null; }
  if (!cfg) { try { cfg = JSON.parse(localStorage.getItem('vi.cfg') || 'null'); } catch { cfg = null; } }
}
async function saveCfg(c) {
  cfg = c;
  await put('kv', { k: 'cfg', v: c });
  try { localStorage.setItem('vi.cfg', JSON.stringify(c)); } catch {}
}

async function readJoinLink() {
  if (!location.hash.includes('join=')) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const token = h.get('join'), api = h.get('api');
  const role = ['owner', 'person', 'group'].includes(h.get('r')) ? h.get('r') : 'person';
  const n = (h.get('n') || '').slice(0, 30);
  history.replaceState(null, '', location.pathname + location.search);   // keep the key out of the address bar
  if (!token || !api || !/^https:\/\//.test(api) && !DEBUG) return;
  const keepName = cfg && cfg.token === token ? cfg.name : null;
  await saveCfg({ api, token, role, linkName: n, name: role === 'group' ? keepName : n });
  ping();
}

// ---------- server ----------
async function call(body, timeoutMs = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(cfg.api, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // simple request: no CORS preflight
      body: JSON.stringify({ ...body, token: cfg.token, v: VERSION }),
      redirect: 'follow',
      signal: ac.signal,
    });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch {
      throw new Error(r.ok ? 'Server replied oddly' : 'Server not available (' + r.status + ')');
    }
    if (!j.ok) { const e = new Error(j.error || 'Server error'); e.code = j.error; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

let linkOff = false;
async function ping() {
  if (!cfg || !navigator.onLine) return;
  try {
    const j = await call({ action: 'ping' }, 20000);
    linkOff = false;
    if (j.role && j.role !== cfg.role) await saveCfg({ ...cfg, role: j.role });
  } catch (e) {
    if (e.code === 'link-off' || e.code === 'bad-token') linkOff = true;
  }
  render();
}

// ---------- recording ----------
let rec = null;
let ignoreUp = false;
let pressAt = 0;

function isoLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }

async function startRec() {
  const r = { id: crypto.randomUUID(), seq: 0, started: 0, locked: false, stopping: false };
  rec = r;
  setMic('rec'); setStatus('Starting…');
  r.ready = (async () => {
    r.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mime = pickMime();
    r.mr = new MediaRecorder(r.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    r.mime = r.mr.mimeType || mime || 'audio/webm';
    r.chunks = [];
    r.saves = [];
    r.mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      r.chunks.push(e.data);
      // Save as we go, so a crash or phone call doesn't lose the note.
      r.saves.push(put('chunks', { id: r.id, seq: r.seq++, blob: e.data, mime: r.mime, started: r.started }).catch(() => {}));
    };
    r.mr.start(1000);
    r.started = Date.now();
    try { r.wake = await navigator.wakeLock?.request('screen'); } catch {}
  })();
  try {
    await r.ready;
  } catch (e) {
    rec = null;
    setMic('');
    setStatus(e.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in Chrome settings.' : 'Mic problem: ' + e.message, true);
    return;
  }
  if (rec !== r) return;
  vibrate(40);
  setStatus(r.locked ? 'Recording. Tap to stop.' : 'Recording. Let go to save.');
  tick();
  r.cap = setTimeout(() => stopRec(), MAX_REC_MS);
}

async function stopRec() {
  const r = rec;
  if (!r || r.stopping) return;
  r.stopping = true;
  try { await r.ready; } catch { return; }
  clearTimeout(r.cap);
  const stopped = new Promise(res => { r.mr.onstop = res; });
  if (r.mr.state !== 'inactive') r.mr.stop();
  await stopped;
  r.stream.getTracks().forEach(t => t.stop());
  try { await r.wake?.release(); } catch {}
  rec = null;
  const ms = Date.now() - r.started;
  await Promise.all(r.saves);
  if (ms < 600) {
    await delRange('chunks', IDBKeyRange.bound([r.id, 0], [r.id, Infinity]));
    setMic(''); setStatus('Too short, not saved. Hold to record');
    $('timer').textContent = '';
    return;
  }
  const blob = new Blob(r.chunks, { type: r.mime });
  await saveCapture({ id: r.id, blob, mime: r.mime, started: r.started, ms });
  await delRange('chunks', IDBKeyRange.bound([r.id, 0], [r.id, Infinity]));
}

async function saveCapture({ id, blob, mime, started, ms, recovered = false }) {
  const c = {
    id, createdAt: isoLocal(new Date(started)), ts: started,
    durationSec: Math.round(ms / 100) / 10, mime, audio: blob,
    transcript: '', tStatus: 'pending', tModel: '', up: 'pending', err: '', tries: 0, recovered,
    name: cfg?.name || '',
  };
  await put('captures', c);
  vibrate([30, 80, 30]);
  setMic('saved'); setStatus('Saved ✓');
  $('timer').textContent = '';
  setTimeout(() => { if (!rec) { setMic(''); setStatus('Hold to record'); } }, 1800);
  render();
  queueTranscribe(c);
  pump();
}

// Notes left half-recorded (app closed, phone call): rebuild them from saved pieces.
async function recoverChunks() {
  const pieces = await all('chunks');
  if (!pieces.length) return;
  const byId = {};
  for (const p of pieces) (byId[p.id] ||= []).push(p);
  for (const [id, ps] of Object.entries(byId)) {
    if (rec && rec.id === id) continue;
    ps.sort((a, b) => a.seq - b.seq);
    if (!(await get('captures', id))) {
      const blob = new Blob(ps.map(p => p.blob), { type: ps[0].mime });
      await saveCapture({ id, blob, mime: ps[0].mime, started: ps[0].started || Date.now(), ms: ps.length * 1000, recovered: true });
    }
    await delRange('chunks', IDBKeyRange.bound([id, 0], [id, Infinity]));
  }
}

function tick() {
  if (!rec || !rec.started) return;
  const s = Math.floor((Date.now() - rec.started) / 1000);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  requestAnimationFrame(() => setTimeout(tick, 250));
}

function setMic(state) {
  const m = $('mic');
  m.classList.toggle('rec', state === 'rec');
  m.classList.toggle('saved', state === 'saved');
  m.classList.toggle('locked', !!(rec && rec.locked));
}
function setStatus(t, err = false) { const s = $('status'); s.textContent = t; s.style.color = err ? '#d77' : ''; }

function wireMic() {
  const m = $('mic');
  m.addEventListener('contextmenu', e => e.preventDefault());
  m.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { m.setPointerCapture(e.pointerId); } catch {}
    pressAt = Date.now();
    if (rec) { ignoreUp = true; stopRec(); return; }      // second tap ends hands-free mode
    startRec();
  });
  const up = (e) => {
    if (ignoreUp) { ignoreUp = false; return; }
    if (!rec || rec.stopping) return;
    if (e.type === 'pointerup' && Date.now() - pressAt < TAP_MS) {
      rec.locked = true; setMic('rec');
      setStatus('Recording. Tap to stop.');
      return;
    }
    stopRec();                                              // let go (or cancelled): save
  };
  m.addEventListener('pointerup', up);
  m.addEventListener('pointercancel', up);
  m.addEventListener('keydown', (e) => {                    // keyboard: Enter/Space toggles
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (rec) stopRec(); else { startRec().then(() => { if (rec) { rec.locked = true; setMic('rec'); setStatus('Recording. Press again to stop.'); } }); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && rec && !rec.locked) stopRec();   // app sent to background mid-hold: save what we have
  });
}

// ---------- transcription (on the phone) ----------
let worker = null;
let model = { state: 'off', pct: 0, device: '' };
const tQueue = new Set();

function startWorker() {
  if (worker) return;
  try { worker = new Worker('worker.js', { type: 'module' }); } catch (e) { model.state = 'error'; model.msg = e.message; return; }
  const files = {};
  worker.onmessage = async (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      files[m.file] = m; let l = 0, t = 0;
      for (const f of Object.values(files)) { l += f.loaded; t += f.total; }
      model.state = 'loading'; model.pct = t ? Math.round(l / t * 100) : 0;
      renderModel();
    } else if (m.type === 'ready') {
      model.state = 'ready'; model.device = m.device; renderModel();
    } else if (m.type === 'loadError') {
      model.state = 'error'; model.msg = m.message; renderModel();
    } else if (m.type === 'result') {
      tQueue.delete(m.id);
      await update(m.id, { transcript: m.text, tStatus: m.text ? 'done' : 'empty', tModel: m.model });
      render(); pump();
    } else if (m.type === 'error') {
      tQueue.delete(m.id);
      await update(m.id, { tStatus: 'failed', tErr: m.message });
      render(); pump();
    }
  };
  worker.onerror = (e) => { model.state = 'error'; model.msg = e.message || 'worker failed'; renderModel(); };
  worker.postMessage({ type: 'load', device: params.get('device') || 'wasm', model: params.get('model') || undefined });
  model.state = 'loading'; renderModel();
}

async function decode16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 16000, 16000);
  const ab = await ctx.decodeAudioData(buf);
  if (ab.numberOfChannels === 1) return ab.getChannelData(0);
  const a = ab.getChannelData(0), b = ab.getChannelData(1), out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

async function queueTranscribe(c) {
  if (tQueue.has(c.id) || c.tStatus !== 'pending' || !c.audio) return;
  startWorker();
  if (!worker) return;
  tQueue.add(c.id);
  try {
    const audio = await decode16k(c.audio);
    worker.postMessage({ type: 'transcribe', id: c.id, audio }, [audio.buffer]);
  } catch (e) {
    tQueue.delete(c.id);
    await update(c.id, { tStatus: 'failed', tErr: 'decode: ' + e.message });
    render(); pump();
  }
}

// ---------- sending ----------
let pumping = false;
function b64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function pump() {
  if (pumping || !cfg || linkOff) return;
  pumping = true;
  try {
    const list = (await all('captures')).sort((a, b) => a.ts - b.ts);
    for (const c of list) {
      if (c.tStatus === 'pending' && !tQueue.has(c.id)) queueTranscribe(c);
      if (!navigator.onLine) continue;
      const tDone = c.tStatus !== 'pending';
      try {
        if (c.up === 'pending') {
          const j = await call({
            action: 'capture', id: c.id, createdAt: c.createdAt, durationSec: c.durationSec, mime: c.mime,
            name: c.name || cfg.name || '', recovered: !!c.recovered,
            transcript: c.transcript, transcriptStatus: c.tStatus, transcriptModel: c.tModel,
            audioB64: await b64(c.audio),
          }, 120000);
          await update(c.id, { up: tDone ? 'done' : 'audio', err: '', sentAt: Date.now(), file: j.file || '' });
        } else if (c.up === 'audio' && tDone) {
          await call({ action: 'transcript', id: c.id, transcript: c.transcript, transcriptStatus: c.tStatus, transcriptModel: c.tModel });
          await update(c.id, { up: 'done', err: '' });
        }
      } catch (e) {
        await update(c.id, { err: e.message, tries: (c.tries || 0) + 1 });
        if (e.code === 'not-found') await update(c.id, { up: 'pending' });   // server lost it: send again
        if (e.code === 'link-off' || e.code === 'bad-token') { linkOff = true; break; }
        if (e.name === 'AbortError' || e instanceof TypeError) break;   // offline / server unreachable: try later
      }
      render();
    }
  } finally {
    pumping = false;
    render();
  }
}

async function cleanup() {
  const cut = Date.now() - KEEP_DAYS * 864e5;
  for (const c of await all('captures')) {
    if (c.up === 'done' && (c.sentAt || c.ts) < cut) await del('captures', c.id);
  }
}

// ---------- screen ----------
function show(id, on) { $(id).hidden = !on; }
function fmtWhen(ts) {
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' ' + t;
}
function stateText(c) {
  if (c.err && c.up !== 'done') return { t: 'Not sent yet', err: true };
  if (c.up === 'pending') return { t: navigator.onLine ? 'Sending…' : 'On phone' };
  if (c.tStatus === 'pending') return { t: 'Sent · text to follow' };
  if (c.up === 'audio') return { t: 'Sent · text to follow' };
  return { t: c.tStatus === 'done' ? 'Sent ✓' : 'Sent ✓ (no text)' };
}

const open = new Set();
const urls = {};
async function render() {
  const ready = !!cfg && (cfg.role !== 'group' || !!cfg.name);
  show('setup', !cfg);
  show('askName', !!cfg && cfg.role === 'group' && !cfg.name);
  show('capture', ready);
  show('recent', ready);
  show('shareBtn', !!cfg && cfg.role === 'owner');
  $('ownerQr').hidden = !(cfg && cfg.role === 'owner');
  $('who').textContent = cfg ? (cfg.name || '') + (cfg.role === 'group' && cfg.linkName ? ' · ' + cfg.linkName : '') : '';
  $('ver').textContent = VERSION;
  if (linkOff) setStatus('This link has been switched off. Ask for a new one.', true);
  $('mic').disabled = linkOff;
  if (!ready) return;

  const list = (await all('captures')).sort((a, b) => b.ts - a.ts);
  const waiting = list.filter(c => c.up !== 'done').length;
  const q = $('queueBtn');
  q.textContent = waiting ? `${waiting} waiting` : 'All sent ✓';
  q.classList.toggle('warn', !!waiting);

  const ul = $('recentList');
  ul.textContent = '';
  for (const c of list.slice(0, 20)) {
    const li = document.createElement('li');
    li.classList.toggle('open', open.has(c.id));
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = c.transcript || (c.tStatus === 'pending' ? 'Turning speech into text…' : `Voice note (${c.durationSec}s)`);
    const st = document.createElement('span');
    const s = stateText(c);
    st.className = 'st' + (s.err ? ' err' : '');
    st.textContent = fmtWhen(c.ts) + ' · ' + s.t;
    li.append(txt, st);
    li.onclick = (e) => { if (e.target.closest('button,audio')) return; open.has(c.id) ? open.delete(c.id) : open.add(c.id); render(); };
    if (open.has(c.id)) {
      if (c.audio) {
        const a = document.createElement('audio');
        a.controls = true;
        a.src = urls[c.id] ||= URL.createObjectURL(c.audio);
        li.append(a);
      }
      if (c.err) { const p = document.createElement('div'); p.className = 'small dim'; p.textContent = 'Last error: ' + c.err; li.append(p); }
      const act = document.createElement('div');
      act.className = 'actions';
      const d = document.createElement('button');
      d.className = 'chip danger'; d.type = 'button';
      d.textContent = c.up === 'done' ? 'Remove from phone' : 'Delete (not sent)';
      d.onclick = async () => {
        const msg = c.up === 'done' ? 'Remove from this phone? It is already sent.' : 'This note has NOT been sent. Delete it for good?';
        if (!confirm(msg)) return;
        await del('captures', c.id); open.delete(c.id); render();
      };
      act.append(d);
      li.append(act);
    }
    ul.append(li);
  }
}

function renderModel() {
  const el = $('modelState');
  const m = { off: 'Speech model not loaded yet.', loading: `Getting speech model ready… ${model.pct}%`,
    ready: `Speech model ready (${model.device}). Works offline.`, error: 'Speech model problem: ' + (model.msg || '') + '. Notes still save; text can be done later.' };
  el.textContent = m[model.state] || '';
}

async function renderStorage() {
  try {
    const persisted = await navigator.storage?.persisted?.();
    const est = await navigator.storage?.estimate?.();
    $('storageState').textContent = `Storage ${persisted ? 'kept' : 'may be cleared by the phone'}` +
      (est ? ` · ${Math.round(est.usage / 1e6)} MB used` : '');
  } catch {}
}

// ---------- share (owner only) ----------
function appUrl() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
function joinUrl(token, role, name) {
  const h = new URLSearchParams({ join: token, api: cfg.api, r: role, n: name || '' });
  return appUrl() + '#' + h.toString();
}
function qrSvg(text) {
  if (!window.qrcode) return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

async function refreshLinks() {
  const ul = $('linkList');
  ul.textContent = 'Loading…';
  try {
    const j = await call({ action: 'listLinks' }, 20000);
    ul.textContent = '';
    for (const l of j.links) {
      const li = document.createElement('li');
      li.classList.toggle('off', !l.active);
      const s = document.createElement('span');
      s.textContent = `${l.name} · ${l.kind === 'group' ? 'group' : 'person'} → ${l.dest}`;
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button';
      b.textContent = l.active ? 'Switch off' : 'Switch on';
      b.onclick = async () => {
        if (l.active && !confirm(`Switch off ${l.name}'s link? Their button stops working.`)) return;
        await call({ action: 'setLinkActive', link: l.id, active: !l.active }); refreshLinks();
      };
      li.append(s, b);
      ul.append(li);
    }
    if (!j.links.length) ul.textContent = 'No links yet.';
  } catch (e) { ul.textContent = 'Could not load links: ' + e.message; }
}

function wireShare() {
  $('shareBtn').onclick = () => { $('shareOut').hidden = true; $('shareDlg').showModal(); refreshLinks(); };
  $('shareMake').onclick = async () => {
    const name = $('shareName').value.trim();
    if (!name) { $('shareName').focus(); return; }
    const kind = document.querySelector('input[name=kind]:checked').value;
    const dest = $('shareDest').value.trim() || 'Shared';
    $('shareMake').disabled = true;
    try {
      const j = await call({ action: 'createLink', name, kind, dest }, 20000);
      const url = joinUrl(j.token, kind, name);
      $('qr').innerHTML = qrSvg(url);
      $('shareUrl').textContent = url;
      $('shareOut').hidden = false;
      $('shareSend').onclick = () => navigator.share?.({ title: 'Voice Inbox', text: 'Tap to set up your Voice Inbox button:', url }).catch(() => {});
      $('shareSend').hidden = !navigator.share;
      $('shareCopy').onclick = () => navigator.clipboard?.writeText(url).then(() => { $('shareCopy').textContent = 'Copied ✓'; });
      refreshLinks();
    } catch (e) { alert('Could not make the link: ' + e.message); }
    finally { $('shareMake').disabled = false; }
  };
}

// ---------- more panel ----------
function wireMore() {
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('moreBtn').onclick = () => { renderModel(); renderStorage(); $('ownerQrOut').hidden = true; $('moreDlg').showModal(); };
  $('queueBtn').onclick = () => { linkOff = false; ping(); pump(); };
  $('syncNow').onclick = () => { linkOff = false; ping(); pump(); };
  $('ownerQr').onclick = () => {
    const out = $('ownerQrOut');
    out.innerHTML = qrSvg(joinUrl(cfg.token, 'owner', cfg.name || ''));
    out.hidden = false;
  };
  $('exportBtn').onclick = async () => {
    const list = (await all('captures')).filter(c => c.up !== 'done' && c.audio);
    if (!list.length) { alert('Nothing unsent.'); return; }
    for (const c of list) {
      const ext = c.mime.includes('mp4') ? 'm4a' : c.mime.includes('ogg') ? 'ogg' : 'webm';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(c.audio);
      a.download = `voice-note-${c.createdAt.slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
      document.body.append(a); a.click(); a.remove();
      if (c.transcript) {
        const t = document.createElement('a');
        t.href = URL.createObjectURL(new Blob([c.transcript], { type: 'text/plain' }));
        t.download = a.download.replace(/\.\w+$/, '.txt');
        document.body.append(t); t.click(); t.remove();
      }
    }
  };
  $('forget').onclick = async () => {
    const waiting = (await all('captures')).filter(c => c.up !== 'done').length;
    const msg = waiting ? `${waiting} note(s) are NOT sent yet and will stay on this phone. Remove the setup anyway?` : 'Remove this phone\'s setup? You will need the link again.';
    if (!confirm(msg)) return;
    await del('kv', 'cfg'); try { localStorage.removeItem('vi.cfg'); } catch {}
    cfg = null; $('moreDlg').close(); render();
  };
  $('nameSave').onclick = async () => {
    const n = $('nameInput').value.trim().slice(0, 30);
    if (!n) { $('nameInput').focus(); return; }
    await saveCfg({ ...cfg, name: n }); render();
  };
}

// ---------- start ----------
async function main() {
  wireMic(); wireShare(); wireMore();
  await loadCfg();
  await readJoinLink();
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { await navigator.storage?.persist?.(); } catch {}
  await recoverChunks();
  await cleanup();
  if (cfg) { ping(); startWorker(); pump(); }
  addEventListener('online', () => { ping(); pump(); });
  addEventListener('hashchange', async () => {                       // link opened while the app is already open
    if (!location.hash.includes('join=')) return;
    linkOff = false;
    await readJoinLink(); render(); startWorker(); pump();
  });
  setInterval(() => { if (!document.hidden) pump(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pump(); });
  if (DEBUG) {
    window.vi = { all, get, put, pump, saveCapture, decode16k, cfg: () => cfg, saveCfg, model: () => model, render };
  }
}
main();
