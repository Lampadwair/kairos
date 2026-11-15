// Kairos — module « Argent » (chargé après app.js, partage ses outils : $, rpc, session, URL_BASE…)
'use strict';

const CATS = {
  courses: ['🛒', 'Courses'], resto: ['🍔', 'Resto & livraison'], transport: ['🚇', 'Transport'],
  jeux: ['🎮', 'Jeux'], sorties: ['🎉', 'Sorties'], achats: ['🛍️', 'Achats'],
  abonnements: ['🔁', 'Abonnements'], sante: ['💊', 'Santé'], maison: ['🏠', 'Maison'], autre: ['📦', 'Autre']
};
const catOf = (k) => CATS[k] || CATS.autre;
let money = null, mMonth = null, mFilter = null;

const eur = (v) => {
  v = +v || 0;
  const dec = Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : 2;
  return v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: dec, maximumFractionDigits: dec });
};
const eur2 = (v) => (+v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtIn = (v) => (+v).toFixed(2).replace('.', ',').replace(',00', '');
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
const monthName = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }); };
const monthOnly = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long' }); };
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const daysUntil = (iso) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(y, m - 1, d) - t) / 86400000); };
const whenTxt = (iso) => {
  const n = daysUntil(iso);
  if (n <= 0) return "aujourd'hui"; if (n === 1) return 'demain'; if (n <= 14) return 'dans ' + n + ' j';
  const [y, m, d] = iso.split('-').map(Number);
  return 'le ' + new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
};

async function loadMoney() {
  try {
    const [mny] = await Promise.all([
      rpc('kairos_money', { p_month: mMonth ? mMonth + '-01' : null }),
      typeof loadPlan === 'function' ? loadPlan() : null
    ]);
    money = mny;
    if (!mMonth) mMonth = money.month;
    renderMoney(); renderBudget();
  } catch (e) { $('mBudgetTxt').textContent = 'Erreur : ' + e.message; }
}

function renderMoney() {
  if (!money) return;
  const m = money, total = +m.total, budget = m.budget != null ? +m.budget : null;
  $('mLabel').textContent = monthName(m.month);
  $('mNext').disabled = m.is_current; $('mNext').style.opacity = m.is_current ? .35 : 1;
  $('payEmpty').classList.toggle('hidden', m.applepay_count > 0 || !m.is_current);
  $('mHeroLbl').textContent = 'Dépensé en ' + monthOnly(m.month);
  $('mTotal').textContent = eur(total);

  const bar = $('mBudgetBar');
  if (budget) {
    bar.classList.remove('hidden'); bar.classList.toggle('over', total > budget);
    bar.firstElementChild.style.width = Math.min(100, total / budget * 100) + '%';
    $('mBudgetTxt').innerHTML = total <= budget
      ? 'Reste <b>' + eur(budget - total) + '</b> sur un budget de ' + eur(budget)
      : '<span style="color:var(--danger)">' + eur(total - budget) + ' au-dessus</span> du budget de ' + eur(budget);
  } else {
    bar.classList.add('hidden');
    $('mBudgetTxt').innerHTML = 'Pas de budget défini — tu peux en fixer un dans Réglages.';
  }
  const prev = m.is_current ? +m.prev_total_same_point : +m.prev_total;
  if (prev > 0) {
    const p = Math.round((total - prev) / prev * 100);
    const prevName = monthOnly(ymOf(new Date(+m.month.slice(0, 4), +m.month.slice(5, 7) - 2, 1)));
    $('mCompare').innerHTML = (p === 0 ? 'Comme' : (p > 0 ? '▲ +' : '▼ −') + Math.abs(p) + ' % vs') + ' ' + prevName + (m.is_current ? ' à la même date' : '');
  } else $('mCompare').textContent = '';

  // Catégories (avec enveloppes du budget s'il y en a)
  const envs = (typeof plan !== 'undefined' && plan && plan.envelopes) || {};
  const byCat = {}; (m.by_cat || []).forEach(c => byCat[c.cat] = c);
  const keys = [...new Set([...Object.keys(byCat), ...Object.keys(envs)])]
    .sort((a, b) => (+(byCat[b]?.total || 0)) - (+(byCat[a]?.total || 0)) || (+envs[b] || 0) - (+envs[a] || 0));
  const max = Math.max(1, ...keys.map(k => +(byCat[k]?.total || 0)));
  $('mCats').innerHTML = keys.length ? keys.map(k => {
    const [e, n] = catOf(k), c = byCat[k] || { total: 0, n: 0 }, lim = envs[k] ? +envs[k] : null, sp = +c.total;
    const w = lim ? Math.min(100, sp / lim * 100) : sp / max * 100, over = lim && sp > lim;
    return '<div class="catrow' + (mFilter === k ? ' sel' : '') + '" data-cat="' + k + '"><div class="e">' + e + '</div>' +
      '<div><div class="n">' + n + '<small>' + (c.n ? c.n + ' paiement' + (c.n > 1 ? 's' : '') : 'rien encore') + '</small></div>' +
      '<div class="bar' + (over ? ' over' : '') + '"><i style="width:' + w + '%"></i></div></div>' +
      '<div class="v">' + eur(sp) + (lim ? '<small' + (over ? ' style="color:var(--danger)"' : '') + '>/ ' + eur(lim) + '</small>' : '') + '</div></div>';
  }).join('') : '<p class="note" style="margin:0">Aucune dépense ce mois-ci pour l\'instant.</p>';
  $('mCats').querySelectorAll('.catrow').forEach(r => r.addEventListener('click', () => {
    mFilter = mFilter === r.dataset.cat ? null : r.dataset.cat; renderMoney();
  }));

  // Abonnements
  const subs = m.subs || [], perMonth = subs.reduce((a, s) => a + (+s.monthly), 0);
  $('mSubsSum').innerHTML = subs.length ? '<b style="color:var(--ink)">' + eur2(perMonth) + ' / mois</b> · ' + eur(perMonth * 12) + ' / an' : '';
  $('mSubs').innerHTML = subs.length ? subs.map(s => {
    const n = daysUntil(s.next_date), per = { mois: '/ mois', an: '/ an', semaine: '/ sem.' }[s.period];
    return '<div class="listrow" data-sub="' + s.id + '"><div class="e">🔁</div><div><div class="t">' + esc(s.name) + '</div>' +
      '<div class="d">' + eur2(s.amount) + ' ' + per + '</div></div>' +
      '<div><span class="chip' + (n <= s.notify_days ? ' soon' : '') + '">' + whenTxt(s.next_date) + '</span></div></div>';
  }).join('') : '<p class="note" style="margin:0">Ajoute tes abonnements (streaming, jeux, apps…) : Kairos te prévient avant chaque renouvellement.</p>';
  $('mSubs').querySelectorAll('[data-sub]').forEach(r => r.addEventListener('click', () => subSheet(subs.find(s => String(s.id) === r.dataset.sub))));

  // Objectifs
  const goals = m.goals || [];
  $('mGoals').innerHTML = goals.length ? goals.map(g => {
    const pct = Math.min(100, +g.saved / +g.target * 100);
    return '<div class="goal"><div class="top"><b>' + esc(g.name) + '</b><span>' + eur(g.saved) + ' / ' + eur(g.target) + '</span></div>' +
      '<div class="bar money"><i style="width:' + pct + '%"></i></div>' +
      '<div class="addrow" style="margin-top:10px"><button class="btn small" type="button" data-gadd="' + g.id + '">+ Mettre de côté</button>' +
      '<button class="btn ghost small" type="button" data-gedit="' + g.id + '">Modifier</button></div></div>';
  }).join('') : '<p class="note" style="margin:0">Un achat ou un voyage en tête ? Fixe un objectif et note ce que tu mets de côté.</p>';
  $('mGoals').querySelectorAll('[data-gadd]').forEach(b => b.addEventListener('click', () => goalAddSheet(goals.find(g => String(g.id) === b.dataset.gadd))));
  $('mGoals').querySelectorAll('[data-gedit]').forEach(b => b.addEventListener('click', () => goalSheet(goals.find(g => String(g.id) === b.dataset.gedit))));

  // Dépenses
  const tx = (m.tx || []).filter(t => !mFilter || t.category === mFilter);
  $('mTxTitle').innerHTML = mFilter ? 'Dépenses · ' + catOf(mFilter)[1] + ' <button class="linkbtn" type="button" id="mClearFilter" style="padding:0 6px;font-size:12px">tout voir</button>' : 'Dépenses';
  if ($('mClearFilter')) $('mClearFilter').addEventListener('click', () => { mFilter = null; renderMoney(); });
  let lastDay = '', html = '';
  for (const t of tx) {
    const d = new Date(t.at); let day = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); day = day.charAt(0).toUpperCase() + day.slice(1);
    if (day !== lastDay) { html += '<div class="daysep">' + day + '</div>'; lastDay = day; }
    const [e, n] = catOf(t.category);
    html += '<div class="listrow" data-tx="' + t.id + '"><div class="e">' + e + '</div><div><div class="t">' + esc(t.merchant || n) + '</div>' +
      '<div class="d">' + n + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) + (t.source === 'applepay' ? ' ·  Pay' : '') + '</div></div>' +
      '<div class="v">' + eur2(t.amount) + '</div></div>';
  }
  $('mTx').innerHTML = html || '<p class="note" style="margin:0">Rien ici pour l\'instant.</p>';
  $('mTx').querySelectorAll('[data-tx]').forEach(r => r.addEventListener('click', () => txSheet(tx.find(t => String(t.id) === r.dataset.tx))));
}

// ---------------------------------------------------------------- Fenêtre d'édition
function openSheet(title, body, onSave, onDelete) {
  const f = $('sheetForm');
  f.innerHTML = '<h3>' + title + '</h3>' + body + '<div class="msg err" id="sheetMsg"></div>' +
    '<div class="actions">' + (onDelete ? '<button class="btn ghost danger" type="button" id="sheetDel">Supprimer</button>' : '') +
    '<button class="btn ghost" type="button" id="sheetCancel">Annuler</button><button class="btn" type="submit">Enregistrer</button></div>';
  $('sheet').classList.remove('hidden');
  const close = () => $('sheet').classList.add('hidden');
  $('sheetCancel').onclick = close;
  if (onDelete) $('sheetDel').onclick = async () => { if (!confirm('Supprimer ?')) return; try { await onDelete(); close(); loadMoney(); } catch (e) { $('sheetMsg').textContent = e.message; } };
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { await onSave(new FormData(f)); close(); loadMoney(); } catch (err) { $('sheetMsg').textContent = err.message; }
  };
  const first = f.querySelector('input'); if (first) setTimeout(() => first.focus(), 50);
}
const num = (v) => { const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); if (!isFinite(n)) throw new Error('Montant invalide'); return n; };
const catOptions = (sel) => Object.entries(CATS).map(([k, [e, n]]) => '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + e + ' ' + n + '</option>').join('');

function txSheet(t) {
  const d = t ? new Date(t.at) : new Date();
  const dIso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  openSheet(t ? 'Dépense' : 'Nouvelle dépense',
    '<label class="field"><span>Montant (€)</span><input name="amount" inputmode="decimal" required value="' + (t ? fmtIn(t.amount) : '') + '"></label>' +
    '<label class="field"><span>Où / quoi</span><input name="merchant" value="' + esc(t ? t.merchant : '') + '" placeholder="Boulangerie, Steam, resto…"></label>' +
    '<label class="field"><span>Catégorie</span><select name="category">' + (t ? '' : '<option value="">Deviner automatiquement</option>') + catOptions(t ? t.category : '') + '</select></label>' +
    '<label class="field"><span>Date</span><input type="date" name="date" value="' + dIso + '"></label>' +
    (t && t.merchant ? '<label class="chk"><input type="checkbox" name="learn" checked> Toujours classer « ' + esc(t.merchant) + ' » dans cette catégorie</label>' : ''),
    async (fd) => {
      const date = fd.get('date'); let at = null;
      if (date && date !== dIso) { const [y, mo, da] = date.split('-').map(Number); at = new Date(y, mo - 1, da, 12, 0).toISOString(); }
      if (!t && date === dIso) at = null;
      await rpc('kairos_tx_save', { p_id: t ? t.id : null, p_amount: num(fd.get('amount')), p_merchant: fd.get('merchant') || '',
        p_category: fd.get('category') || null, p_at: at, p_learn: !!fd.get('learn') });
    },
    t ? () => rpc('kairos_tx_delete', { p_id: t.id }) : null);
}

function subSheet(s) {
  openSheet(s ? 'Abonnement' : 'Nouvel abonnement',
    '<label class="field"><span>Nom</span><input name="name" required value="' + esc(s ? s.name : '') + '" placeholder="Netflix, Spotify, Game Pass…"></label>' +
    '<label class="field"><span>Montant (€)</span><input name="amount" inputmode="decimal" required value="' + (s ? fmtIn(s.amount) : '') + '"></label>' +
    '<label class="field"><span>Fréquence</span><select name="period">' +
      ['mois', 'an', 'semaine'].map(p => '<option value="' + p + '"' + (s && s.period === p ? ' selected' : '') + '>Tous les ' + (p === 'semaine' ? 'semaines' : p === 'an' ? 'ans' : 'mois') + '</option>').join('') + '</select></label>' +
    '<label class="field"><span>Prochain prélèvement</span><input type="date" name="next" required value="' + (s ? s.next_date : todayISO()) + '"></label>' +
    '<label class="field"><span>Me prévenir</span><select name="notify">' +
      [[0, 'Jamais'], [1, 'La veille'], [2, '2 jours avant'], [3, '3 jours avant'], [7, 'Une semaine avant']].map(([v, l]) => '<option value="' + v + '"' + ((s ? s.notify_days : 3) === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>',
    (fd) => rpc('kairos_sub_save', { p_id: s ? s.id : null, p_name: fd.get('name'), p_amount: num(fd.get('amount')),
      p_period: fd.get('period'), p_next_date: fd.get('next'), p_notify_days: +fd.get('notify') }),
    s ? () => rpc('kairos_sub_delete', { p_id: s.id }) : null);
}

function goalSheet(g) {
  openSheet(g ? 'Objectif' : 'Nouvel objectif',
    '<label class="field"><span>Pour quoi ?</span><input name="name" required value="' + esc(g ? g.name : '') + '" placeholder="Nouveau PC, voyage au Japon…"></label>' +
    '<label class="field"><span>Montant à atteindre (€)</span><input name="target" inputmode="decimal" required value="' + (g ? fmtIn(g.target) : '') + '"></label>' +
    '<label class="field"><span>Pour quand ? (facultatif)</span><input type="date" name="deadline" value="' + (g && g.deadline ? g.deadline : '') + '"></label>',
    (fd) => rpc('kairos_goal_save', { p_id: g ? g.id : null, p_name: fd.get('name'), p_target: num(fd.get('target')), p_deadline: fd.get('deadline') || null }),
    g ? () => rpc('kairos_goal_delete', { p_id: g.id }) : null);
}

function goalAddSheet(g) {
  const left = Math.max(0, +g.target - +g.saved);
  let hint = 'Il reste ' + eur(left) + '.';
  if (g.deadline && left > 0) {
    const months = Math.max(1, Math.ceil(daysUntil(g.deadline) / 30.4));
    hint += ' Soit environ ' + eur(left / months) + ' par mois d\'ici le ' + new Date(g.deadline).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + '.';
  }
  openSheet(esc(g.name),
    '<p class="note" style="margin-top:-6px">' + hint + '</p>' +
    '<label class="field"><span>Montant mis de côté (€)</span><input name="amount" inputmode="decimal" required placeholder="50"></label>' +
    '<label class="chk"><input type="checkbox" name="minus"> C\'est un retrait</label>',
    (fd) => rpc('kairos_goal_add', { p_id: g.id, p_amount: num(fd.get('amount')) * (fd.get('minus') ? -1 : 1) }));
}

// ---------------------------------------------------------------- Budget (Réglages)
function renderBudget() {
  const b = money && money.budget != null ? +money.budget : null;
  $('budgetOut').textContent = b ? eur(b) : 'Aucun';
  $('cPayUrl').textContent = URL_BASE + '/rest/v1/rpc/kairos_pay';
  if (typeof renderSettingsHome === 'function') renderSettingsHome();
}
let budgetTimer = null;
function changeBudget(dir) {
  if (!money) return;
  let b = money.budget != null ? +money.budget : 0;
  b = b === 0 && dir > 0 ? 300 : Math.max(0, b + dir * 50);
  money.budget = b || null; renderBudget(); renderMoney();
  clearTimeout(budgetTimer);
  budgetTimer = setTimeout(() => rpc('kairos_money_settings', { p_budget: b }).catch(e => alert(e.message)), 400);
}

// ---------------------------------------------------------------- Branchements
(function wireMoney() {
  $('mPrev').addEventListener('click', () => { const [y, m] = mMonth.split('-').map(Number); mMonth = ymOf(new Date(y, m - 2, 1)); mFilter = null; loadMoney(); if (typeof mView !== 'undefined' && mView === 'dash') loadDash(); });
  $('mNext').addEventListener('click', () => { if (money && money.is_current) return; const [y, m] = mMonth.split('-').map(Number); mMonth = ymOf(new Date(y, m, 1)); mFilter = null; loadMoney(); if (typeof mView !== 'undefined' && mView === 'dash') loadDash(); });
  $('mAddTx').addEventListener('click', () => txSheet(null));
  $('mAddSub').addEventListener('click', () => subSheet(null));
  $('mAddGoal').addEventListener('click', () => goalSheet(null));
  const [minus, , plus] = $('budgetStep').children;
  minus.addEventListener('click', () => changeBudget(-1));
  plus.addEventListener('click', () => changeBudget(1));
  $('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') $('sheet').classList.add('hidden'); });
})();
