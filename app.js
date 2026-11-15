// Kairos — module « Soirée choisie »
// Pas de bibliothèque externe : on parle directement aux API REST de Supabase (Auth + RPC).
'use strict';
const APP_VER = '1.4.0';
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
let authMode = 'login';     // login | signup | forgot | reset
let signupAllowed = true;

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

// Retour depuis un lien reçu par e-mail (#access_token=…) : confirmation ou mot de passe oublié
function readHashSession() {
  if (!location.hash.includes('access_token=')) return false;
  const p = new URLSearchParams(location.hash.slice(1));
  saveSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600 });
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('type') === 'recovery') authMode = 'reset';
  return true;
}

// ---------------------------------------------------------------- Connexion
function setAuthMode(m) {
  authMode = m;
  const t = {
    login:  ['Ta soirée, ton choix.', 'Se connecter', 'Mot de passe'],
    signup: ['Crée ton compte Kairos.', 'Créer mon compte', 'Mot de passe'],
    forgot: ['On t\'envoie un lien pour choisir un nouveau mot de passe.', 'Recevoir le lien', ''],
    reset:  ['Choisis ton nouveau mot de passe.', 'Enregistrer', 'Nouveau mot de passe']
  }[m];
  $('authSub').textContent = t[0]; $('authBtn').textContent = t[1]; $('passLabel').textContent = t[2];
  $('emailField').classList.toggle('hidden', m === 'reset');
  $('email').required = m !== 'reset';
  $('passField').classList.toggle('hidden', m === 'forgot');
  $('password').required = m !== 'forgot';
  $('password').autocomplete = (m === 'login') ? 'current-password' : 'new-password';
  $('forgotBtn').classList.toggle('hidden', m !== 'login');
  $('authSwitch').classList.toggle('hidden', m === 'reset' || (m === 'login' && !signupAllowed));
  $('authSwitch').textContent = m === 'login' ? 'Pas encore de compte ? Créer un compte' : 'Retour à la connexion';
  $('authMsg').textContent = ''; $('authMsg').className = 'msg';
}

function authError(msg) {
  if (/invalid login|invalid_credentials/i.test(msg)) return 'E-mail ou mot de passe incorrect. Utilise ton compte Hepha, ou « Mot de passe oublié ».';
  if (/signups? not allowed|signup_disabled/i.test(msg)) return 'Les inscriptions sont fermées : connecte-toi avec ton compte Hepha.';
  if (/not confirmed|confirm/i.test(msg)) return 'Confirme d\'abord ton e-mail (lien reçu par mail).';
  if (/rate limit|security purposes|too many/i.test(msg)) return 'Trop de tentatives ou d\'e-mails envoyés. Réessaie dans quelques minutes.';
  if (/should be different/i.test(msg)) return 'Choisis un mot de passe différent de l\'ancien.';
  if (/weak|at least|characters/i.test(msg)) return 'Mot de passe trop court (6 caractères minimum).';
  return msg;
}

async function loadAuthSettings() {
  try {
    const r = await fetch(URL_BASE + '/auth/v1/settings', { headers: { apikey: KEY } });
    const j = await r.json();
    signupAllowed = !j.disable_signup;
  } catch {}
  if (authMode === 'login') setAuthMode('login');
}

// ---------------------------------------------------------------- Vues
function show(view) {
  for (const v of ['setup', 'auth', 'app']) $('v-' + v).classList.toggle('hidden', v !== view);
}
let currentTab = 'tonight';
function tab(name) {
  currentTab = name;
  $('t-tonight').classList.toggle('hidden', name !== 'tonight');
  $('t-money').classList.toggle('hidden', name !== 'money');
  $('t-nights').classList.toggle('hidden', name !== 'nights');
  $('t-settings').classList.toggle('hidden', name !== 'settings');
  if (name === 'nights' || name === 'settings') { if (typeof loadNights === 'function') loadNights(); }
  if (name === 'money' || (name === 'settings' && typeof money !== 'undefined' && !money)) { if (typeof loadMoney === 'function') loadMoney(); }
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
  document.querySelectorAll('.stepper[data-key]').forEach(el => { el.querySelector('output').textContent = st[el.dataset.key] + ' min'; });
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === st.mode));
  $('modeDesc').textContent = st.mode === 'ferme' ? 'Ouvrir Insta ouvre Manga Pin' : 'Une notification te propose de lire';
  $('dayEnd').value = String(st.day_end_hour);
  $('cUrl').textContent = URL_BASE + '/rest/v1/rpc/kairos_log';
  $('cKey').textContent = KEY;
  $('cTok').textContent = st.token;
  $('accEmail').textContent = (session && session.user.email) || 'Connecté';
  $('accStats').textContent = data.events_count + ' signaux enregistrés';
  document.querySelectorAll('#remindSeg button').forEach(b => b.classList.toggle('on', (b.dataset.on === '1') === !!st.remind_enabled));
  $('remindDesc').textContent = !st.remind_enabled ? 'Désactivés'
    : st.remind_snoozed ? 'En pause jusqu\'à la fin de la soirée'
    : 'Après ' + st.remind_after_min + ' min, puis toutes les ' + st.remind_every_min + ' min';
  renderPushState();
}

let saveTimer = null, savePending = false;
async function flushSave() {
  clearTimeout(saveTimer);
  if (!savePending || !data) return;
  const st = data.settings;
  try {
    await rpc('kairos_save_settings', { p_quota: st.insta_quota_min, p_goal: st.reading_goal_min, p_mode: st.mode, p_day_end: st.day_end_hour,
      p_remind: !!st.remind_enabled, p_remind_after: st.remind_after_min, p_remind_every: st.remind_every_min });
    savePending = false;
    const el = $('saved'); el.textContent = 'Enregistré ✓'; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1400);
    load();
  } catch (e) { const el = $('saved'); el.textContent = 'Échec de l\'enregistrement : ' + e.message; el.classList.add('show'); }
}
function queueSave() {
  savePending = true;
  const el = $('saved'); el.textContent = 'Enregistrement…'; el.classList.add('show');
  renderSettings(); render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 350);
}


// ---------------------------------------------------------------- Notifications (rappels)
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let pushSubscribed = false;

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function checkPush() {
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    pushSubscribed = !!sub && Notification.permission === 'granted';
    if (sub && session) await sendSub(sub); // garde le serveur à jour
  } catch {}
  renderPushState();
}

async function sendSub(sub) {
  const j = sub.toJSON();
  await rpc('kairos_save_push', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
}

function renderPushState() {
  const el = $('pushState'), btn = $('pushBtn');
  if (!el) return;
  let txt, showBtn = true;
  if (!pushSupported() || !isStandalone()) {
    txt = 'Ouvre Kairos depuis son <b>icône sur l\'écran d\'accueil</b> pour activer les notifications (iOS l\'exige).'; showBtn = false;
  } else if (Notification.permission === 'denied') {
    txt = 'Notifications refusées. Réactive-les dans <b>Réglages iPhone → Notifications → Kairos</b>.'; showBtn = false;
  } else if (pushSubscribed) {
    txt = '<b>Notifications actives</b> sur cet iPhone ✓'; showBtn = false;
  } else {
    txt = 'Notifications pas encore activées sur cet appareil.';
  }
  el.innerHTML = txt; btn.classList.toggle('hidden', !showBtn);
}

async function enablePush() {
  const btn = $('pushBtn');
  try {
    btn.disabled = true; btn.textContent = '…';
    const vapid = CFG.vapidPublicKey || await rpc('kairos_vapid_public');
    if (!vapid) throw new Error('le serveur de notifications n\'est pas encore prêt');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderPushState(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription() ||
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapid) });
    await sendSub(sub);
    pushSubscribed = true; load();
  } catch (e) { alert('Activation impossible : ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '🔔 Activer les notifications sur cet iPhone'; renderPushState(); }
}

// ---------------------------------------------------------------- Écran « pause scroll »
function showStop(minutes) {
  $('stopMin').innerHTML = (minutes || '') + '<small>min</small>';
  $('v-stop').classList.remove('hidden');
}
function hideStop() { $('v-stop').classList.add('hidden'); }
function readStopParam() {
  const q = new URLSearchParams(location.search);
  if (q.get('stop') === '1') {
    showStop(+q.get('m') || '');
    history.replaceState(null, '', location.pathname);
  } else if (q.get('tab') === 'argent' || q.get('tab') === 'nuits') {
    tab(q.get('tab') === 'argent' ? 'money' : 'nights');
    history.replaceState(null, '', location.pathname);
  }
}

// ---------------------------------------------------------------- Chargement
async function load() {
  try {
    const fresh = await rpc('kairos_dashboard', { p_days: 14 });
    if (savePending) return; // un réglage est en cours d'envoi : on ne l'écrase pas
    data = fresh;
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
  if (authMode === 'reset') { show('auth'); setAuthMode('reset'); return; }
  session = session || store.get(LS_SESSION);
  if (!session) { show('auth'); setAuthMode(authMode === 'signup' ? 'signup' : 'login'); loadAuthSettings(); return; }
  show('app');
  readStopParam();
  checkPush();
  data = store.get('kairos.cache');
  if (data) { render(); renderSettings(); }
  load();
}

// ---------------------------------------------------------------- Événements
function wire() {
  $('authSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  $('forgotBtn').addEventListener('click', () => setAuthMode('forgot'));
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim(), password = $('password').value, msg = $('authMsg');
    const redirect = encodeURIComponent(location.origin + location.pathname.replace(/index\.html$/, ''));
    msg.className = 'msg'; msg.textContent = '…'; $('authBtn').disabled = true;
    try {
      if (authMode === 'signup') {
        const r = await api('/auth/v1/signup?redirect_to=' + redirect, { body: { email, password }, auth: false });
        if (r && r.access_token) { saveSession(r); start(); }
        else { msg.className = 'msg ok'; msg.textContent = 'Compte créé. Confirme ton e-mail avec le lien reçu, puis reviens te connecter.'; }
      } else if (authMode === 'forgot') {
        await api('/auth/v1/recover?redirect_to=' + redirect, { body: { email }, auth: false });
        msg.className = 'msg ok'; msg.textContent = 'Si un compte existe pour cet e-mail, un lien vient de partir. Ouvre-le sur cet appareil.';
      } else if (authMode === 'reset') {
        await api('/auth/v1/user', { method: 'PUT', body: { password } });
        authMode = 'login'; $('password').value = '';
        start();
      } else {
        const r = await api('/auth/v1/token?grant_type=password', { body: { email, password }, auth: false });
        saveSession(r); start();
      }
    } catch (err) {
      msg.className = 'msg err'; msg.textContent = authError(err.message);
    } finally { $('authBtn').disabled = false; }
  });

  document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => tab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => { tab(b.dataset.goto); const g = $(b.dataset.open || 'guide'); g.open = true; g.scrollIntoView({ block: 'start' }); }));

  document.querySelectorAll('.stepper[data-key]').forEach(el => {
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
    logoutLocal(); show('auth'); setAuthMode('login'); loadAuthSettings();
  });

  $('readNow').addEventListener('click', (e) => {
    e.preventDefault();
    location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(CFG.readShortcut || 'Kairos Lire');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();          // on quitte l'app : on enregistre tout de suite
    else if (session) { load(); if (currentTab === 'money' && typeof loadMoney === 'function') loadMoney(); if (currentTab === 'nights' && typeof loadNights === 'function') loadNights(); }
  });
  setInterval(() => { if (document.visibilityState === 'visible' && session) load(); }, 60000);

  document.querySelectorAll('#remindSeg button').forEach(b => b.addEventListener('click', () => { if (data) { data.settings.remind_enabled = b.dataset.on === '1'; queueSave(); } }));
  $('pushBtn').addEventListener('click', enablePush);
  $('stopRead').addEventListener('click', (e) => { e.preventDefault(); hideStop(); location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(CFG.readShortcut || 'Kairos Lire'); });
  $('stopMore').addEventListener('click', hideStop);
  $('stopSnooze').addEventListener('click', async () => { hideStop(); try { await rpc('kairos_snooze_reminders'); load(); } catch (e) { alert(e.message); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'stop') showStop(e.data.m);
    if (e.data && e.data.type === 'tab') tab(e.data.tab);
  });

  $('ver').textContent = 'Kairos ' + APP_VER;
}

wire();
start();
window.addEventListener('hashchange', () => { if (location.hash.includes('access_token=')) start(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
