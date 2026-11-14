// Kairos — module « Soirée choisie »
// Pas de bibliothèque externe : on parle directement aux API REST de Supabase (Auth + RPC).
'use strict';
const APP_VER = '1.0.0';
const CFG = window.KAIROS_CONFIG || {};
const URL_BASE = (CFG.supabaseUrl || '').replace(/\/+$/, '');
const KEY = CFG.supabaseKey || '';
const LS_SESSION = 'kairos.session';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

let session = null;      // {access_token, refresh_token, expires_at, user:{email}}
let data = null;         // réponse de kairos_dashboard
let signupMode = false;

// ---------------------------------------------------------------- Supabase
async function api(path, { method = 'POST', body, auth = true } = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (auth && session) headers.Authorization = 'Bearer ' + session.access_token;
  const res = await fetch(URL_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
  if (!res.ok) {
    const msg = (json && (json.msg || json.message || json.error_description || json.error)) || ('Erreur ' + res.status);
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return json;
}

function saveSession(s) {
  session = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at || (Math.floor(Date.now() / 1000) + (s.expires_in || 3600)),
    user: { email: (s.user && s.user.email) || (session && session.user && session.user.email) || '' }
  };
  store.set(LS_SESSION, session);
}

async function ensureFresh() {
  if (!session) return false;
  if (session.expires_at - 60 > Date.now() / 1000) return true;
  try {
    const s = await api('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token }, auth: false });
    saveSession(s); return true;
  } catch { logoutLocal(); return false; }
}

async function rpc(fn, args = {}) {
  if (!(await ensureFresh())) throw new Error('Session expirée');
  try { return await api('/rest/v1/rpc/' + fn, { body: args }); }
  catch (e) {
    if (e.status === 401) { session.expires_at = 0; if (await ensureFresh()) return api('/rest/v1/rpc/' + fn, { body: args }); }
    throw e;
  }
}

// Retour depuis le lien de confirmation d'e-mail (#access_token=…)
function readHashSession() {
  if (!location.hash.includes('access_token=')) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  saveSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600 });
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

// ---------------------------------------------------------------- Vues
function show(view) {
  for (const v of ['setup', 'auth', 'app']) $('v-' + v).classList.toggle('hidden', v !== view);
}
function tab(name) {
  $('t-tonight').classList.toggle('hidden', name !== 'tonight');
  $('t-settings').classList.toggle('hidden', name !== 'settings');
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- Format
const fmtMin = (m) => {
  m = Math.round(m || 0);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' h' + (r ? ' ' + String(r).padStart(2, '0') : '');
};
const parseDay = (s) => { const [y, mo, d] = s.split('-').map(Number); return new Date(y, mo - 1, d); };
const dayShort = (s) => parseDay(s).toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
const dayLong = (s) => { const t = parseDay(s).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' }); return t.charAt(0).toUpperCase() + t.slice(1); };
const ago = (iso) => {
  if (!iso) return null;
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'à l\'instant';
  if (s < 3600) return 'il y a ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h';
  return 'il y a ' + Math.round(s / 86400) + ' j';
};

// ---------------------------------------------------------------- Rendu « Ce soir »
function render() {
  if (!data) return;
  const st = data.settings, days = data.days || [];
  const today = days[days.length - 1] || { day: '', insta: 0, lecture: 0 };
  const read = +today.lecture, scroll = +today.insta, goal = st.reading_goal_min, quota = st.insta_quota_min;

  $('dayLabel').textContent = today.day ? 'Journée du ' + dayLong(today.day).toLowerCase() : '';
  $('emptyCard').classList.toggle('hidden', data.events_count > 0);

  // Titre selon la soirée
  let hero;
  if (read >= goal && scroll <= quota) hero = 'Objectif atteint, <em>belle soirée.</em>';
  else if (read >= goal) hero = 'Objectif lecture atteint. <em>Insta peut attendre.</em>';
  else if (scroll >= quota && quota > 0) hero = 'Quota Insta atteint. <em>Place à la lecture.</em>';
  else if (read > 0) hero = 'Encore ' + fmtMin(goal - read) + ' <em>pour ta série.</em>';
  else hero = 'Ta soirée, <em>ton choix.</em>';
  $('hero').innerHTML = hero;

  // Compteurs
  $('readNum').textContent = Math.round(read);
  $('readBar').style.width = Math.min(100, goal ? read / goal * 100 : 0) + '%';
  $('readBarWrap').setAttribute('aria-valuenow', Math.round(read));
  $('readSub').innerHTML = read >= goal ? '<span class="tag ok">✓ objectif ' + goal + ' min</span>' : 'objectif ' + goal + ' min';
  $('scrollNum').textContent = Math.round(scroll);
  $('scrollBar').style.width = Math.min(100, quota ? scroll / quota * 100 : (scroll > 0 ? 100 : 0)) + '%';
  $('scrollBarWrap').setAttribute('aria-valuenow', Math.round(scroll));
  $('scrollSub').innerHTML = scroll > quota
    ? '<span class="tag over">+' + Math.round(scroll - quota) + ' min sur ' + quota + '</span>'
    : 'reste ' + Math.max(0, Math.round(quota - scroll)) + ' sur ' + quota + ' min';

  // Série
  $('streakNum').textContent = data.streak;
  $('streakTxt').innerHTML = (data.streak > 1 ? 'journées d\'affilée' : 'journée d\'affilée') + '<br>record : <b>' + data.best + '</b>';
  $('dots').innerHTML = days.slice(-14).map((d, i, arr) => {
    const on = +d.lecture >= goal, isToday = i === arr.length - 1;
    return '<div title="' + dayLong(d.day) + ' : ' + fmtMin(d.lecture) + ' de lecture"><span class="' + (on ? 'on ' : '') + (isToday ? 'today' : '') + '"></span>' + dayShort(d.day).charAt(0).toUpperCase() + '</div>';
  }).join('');

  renderChart(days.slice(-7), quota);
  renderWeek(days);

  const sig = ago(data.last_event);
  $('lastSig').textContent = sig ? 'Dernier signal des raccourcis : ' + sig : 'Aucun signal des raccourcis pour l\'instant';
}

function renderWeek(days) {
  const cur = days.slice(-7), prev = days.slice(-14, -7);
  const sum = (arr, k) => arr.reduce((a, d) => a + (+d[k] || 0), 0);
  const r = sum(cur, 'lecture'), s = sum(cur, 'insta'), pr = sum(prev, 'lecture'), ps = sum(prev, 'insta');
  const delta = (a, b, goodUp) => {
    if (!b) return '';
    const p = Math.round((a - b) / b * 100);
    if (p === 0) return ' · stable';
    const good = goodUp ? p > 0 : p < 0;
    return ' · <span class="' + (good ? 'ok' : 'over') + '" style="color:var(' + (good ? '--ok' : '--danger') + ')">' + (p > 0 ? '▲ +' : '▼ −') + Math.abs(p) + ' %</span>';
  };
  $('weekSum').innerHTML =
    '<span class="tag"><i class="dot read"></i>Lecture ' + fmtMin(r) + delta(r, pr, true) + '</span>' +
    '<span class="tag"><i class="dot scroll"></i>Insta ' + fmtMin(s) + delta(s, ps, false) + '</span>';
  $('dataTable').innerHTML = '<tr><th>Journée</th><th>Lecture</th><th>Insta</th></tr>' +
    days.slice(-7).slice().reverse().map(d => '<tr><td>' + dayLong(d.day) + '</td><td>' + fmtMin(d.lecture) + '</td><td>' + fmtMin(d.insta) + '</td></tr>').join('');
}

// Barres groupées : lecture / Insta par journée, ligne pointillée = quota Insta.
function renderChart(days, quota) {
  const W = 340, H = 170, padL = 30, padB = 22, padT = 8, innerW = W - padL, innerH = H - padB - padT;
  const max = Math.max(quota, 10, ...days.map(d => Math.max(+d.lecture, +d.insta)));
  const step = max > 90 ? 30 : max > 45 ? 15 : 10;
  const top = Math.ceil(max / step) * step;
  const y = (v) => padT + innerH - (v / top) * innerH;
  const colW = innerW / days.length, barW = Math.min(14, (colW - 10) / 2), gap = 2;
  const bar = (x, v, cls) => {
    const h = Math.max(0, (v / top) * innerH); if (h < 0.5) return '';
    const r = Math.min(4, barW / 2, h), y0 = padT + innerH, y1 = y0 - h;
    return '<path style="fill:var(' + cls + ')" d="M' + x + ',' + y0 + 'V' + (y1 + r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 +
      'H' + (x + barW - r) + 'Q' + (x + barW) + ',' + y1 + ' ' + (x + barW) + ',' + (y1 + r) + 'V' + y0 + 'Z"/>';
  };
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Minutes de lecture et d\'Insta sur les 7 dernières journées">';
  for (let v = 0; v <= top; v += step) {
    s += '<line class="grid" x1="' + padL + '" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
    s += '<text x="' + (padL - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
  }
  days.forEach((d, i) => {
    const cx = padL + colW * i + colW / 2, x0 = cx - barW - gap / 2;
    s += '<g class="col" data-i="' + i + '"><rect class="hl" x="' + (padL + colW * i + 2) + '" y="' + padT + '" width="' + (colW - 4) + '" height="' + innerH + '" rx="8" fill="transparent"/>';
    s += bar(x0, +d.lecture, '--s-read') + bar(cx + gap / 2, +d.insta, '--s-scroll');
    s += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + dayShort(d.day) + '</text>';
    s += '<rect class="hit" x="' + (padL + colW * i) + '" y="0" width="' + colW + '" height="' + H + '"/></g>';
  });
  if (quota > 0 && quota <= top) {
    s += '<line class="quota" x1="' + padL + '" x2="' + W + '" y1="' + y(quota) + '" y2="' + y(quota) + '"/>';
  }
  s += '</svg>';
  const box = $('chart'), tip = $('tip');
  box.innerHTML = s; box.appendChild(tip);
  const svg = box.querySelector('svg');
  const showTip = (g) => {
    box.querySelectorAll('.col').forEach(c => c.classList.toggle('active', c === g));
    const d = days[+g.dataset.i];
    tip.innerHTML = '<div class="d">' + dayLong(d.day) + '</div>' +
      '<div class="r"><i class="dot read"></i>Lecture<b>' + fmtMin(d.lecture) + '</b></div>' +
      '<div class="r"><i class="dot scroll"></i>Insta<b>' + fmtMin(d.insta) + '</b></div>';
    const sb = svg.getBoundingClientRect(), bb = box.getBoundingClientRect(), k = sb.width / W;
    const i = +g.dataset.i, cx = (padL + colW * i + colW / 2) * k;
    const tw = 170, left = Math.max(tw / 2, Math.min(bb.width - tw / 2, cx));
    tip.style.left = left + 'px'; tip.style.top = '0px';
    tip.classList.add('show');
  };
  const hide = () => { tip.classList.remove('show'); box.querySelectorAll('.col').forEach(c => c.classList.remove('active')); };
  box.querySelectorAll('.col').forEach(g => {
    g.addEventListener('pointerenter', () => showTip(g));
    g.addEventListener('click', () => showTip(g));
  });
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) hide(); }, { once: true });
}

// ---------------------------------------------------------------- Réglages
function renderSettings() {
  if (!data) return;
  const st = data.settings;
  document.querySelectorAll('.stepper').forEach(el => { el.querySelector('output').textContent = st[el.dataset.key] + ' min'; });
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === st.mode));
  $('modeDesc').textContent = st.mode === 'ferme' ? 'Ouvrir Insta ouvre Manga Pin' : 'Une notification te propose de lire';
  $('dayEnd').value = String(st.day_end_hour);
  $('cUrl').textContent = URL_BASE + '/rest/v1/rpc/kairos_log';
  $('cKey').textContent = KEY;
  $('cTok').textContent = st.token;
  $('accEmail').textContent = (session && session.user.email) || 'Connecté';
  $('accStats').textContent = data.events_count + ' signaux enregistrés';
}

let saveTimer = null;
function queueSave() {
  renderSettings(); render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const st = data.settings;
    try {
      await rpc('kairos_save_settings', { p_quota: st.insta_quota_min, p_goal: st.reading_goal_min, p_mode: st.mode, p_day_end: st.day_end_hour });
      const el = $('saved'); el.textContent = 'Enregistré ✓'; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1400);
      load();
    } catch (e) { const el = $('saved'); el.textContent = 'Échec : ' + e.message; el.classList.add('show'); }
  }, 500);
}

// ---------------------------------------------------------------- Chargement
async function load() {
  try {
    data = await rpc('kairos_dashboard', { p_days: 14 });
    store.set('kairos.cache', data);
    render(); renderSettings();
  } catch (e) {
    if (!session) return start();
    $('lastSig').textContent = 'Hors ligne ou erreur : ' + e.message;
  }
}

function logoutLocal() { session = null; data = null; store.del(LS_SESSION); store.del('kairos.cache'); }

function start() {
  if (!URL_BASE || !KEY) return show('setup');
  readHashSession();
  session = session || store.get(LS_SESSION);
  if (!session) return show('auth');
  show('app');
  data = store.get('kairos.cache');
  if (data) { render(); renderSettings(); }
  load();
}

// ---------------------------------------------------------------- Événements
function wire() {
  $('authSwitch').addEventListener('click', () => {
    signupMode = !signupMode;
    $('authBtn').textContent = signupMode ? 'Créer mon compte' : 'Se connecter';
    $('authSwitch').textContent = signupMode ? 'Déjà un compte ? Se connecter' : 'Pas encore de compte ? Créer un compte';
    $('password').autocomplete = signupMode ? 'new-password' : 'current-password';
    $('authMsg').textContent = '';
  });
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim(), password = $('password').value, msg = $('authMsg');
    msg.className = 'msg'; msg.textContent = '…'; $('authBtn').disabled = true;
    try {
      if (signupMode) {
        const redirect = encodeURIComponent(location.origin + location.pathname);
        const r = await api('/auth/v1/signup?redirect_to=' + redirect, { body: { email, password }, auth: false });
        if (r && r.access_token) { saveSession(r); start(); }
        else { msg.className = 'msg ok'; msg.textContent = 'Compte créé. Confirme ton e-mail avec le lien reçu, puis reviens te connecter.'; }
      } else {
        const r = await api('/auth/v1/token?grant_type=password', { body: { email, password }, auth: false });
        saveSession(r); start();
      }
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = /confirm/i.test(err.message) ? 'Confirme d\'abord ton e-mail (lien reçu par mail).'
        : /invalid/i.test(err.message) ? 'E-mail ou mot de passe incorrect.' : err.message;
    } finally { $('authBtn').disabled = false; }
  });

  document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => { tab(b.dataset.goto); $('guide').open = true; }));

  document.querySelectorAll('.stepper').forEach(el => {
    const [minus, , plus] = el.children;
    const change = (dir) => {
      if (!data) return;
      const k = el.dataset.key, step = +el.dataset.step;
      data.settings[k] = Math.max(+el.dataset.min, Math.min(+el.dataset.max, data.settings[k] + dir * step));
      queueSave();
    };
    minus.addEventListener('click', () => change(-1));
    plus.addEventListener('click', () => change(1));
  });
  document.querySelectorAll('#modeSeg button').forEach(b => b.addEventListener('click', () => { if (data) { data.settings.mode = b.dataset.mode; queueSave(); } }));
  $('dayEnd').addEventListener('change', (e) => { if (data) { data.settings.day_end_hour = +e.target.value; queueSave(); } });

  document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    const txt = $(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(txt); b.textContent = 'Copié ✓'; }
    catch { const r = document.createRange(); r.selectNodeContents($(b.dataset.copy)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Sélectionné'; }
    setTimeout(() => (b.textContent = 'Copier'), 1500);
  }));

  $('newToken').addEventListener('click', async () => {
    if (!confirm('Changer de jeton ? Il faudra recoller le nouveau dans le raccourci Kairos.')) return;
    try { const t = await rpc('kairos_new_token'); data.settings.token = t; renderSettings(); } catch (e) { alert(e.message); }
  });
  $('clearHist').addEventListener('click', async () => {
    if (!confirm('Effacer tout l\'historique de minutes ? Tes réglages sont gardés.')) return;
    try { await rpc('kairos_clear_history'); load(); } catch (e) { alert(e.message); }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('/auth/v1/logout', {}); } catch {}
    logoutLocal(); show('auth');
  });

  $('readNow').addEventListener('click', (e) => {
    e.preventDefault();
    location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(CFG.readShortcut || 'Kairos Lire');
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && session) load(); });
  setInterval(() => { if (document.visibilityState === 'visible' && session) load(); }, 60000);

  $('ver').textContent = 'Kairos ' + APP_VER;
}

wire();
start();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
