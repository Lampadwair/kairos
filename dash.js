// Kairos — Argent : tableau de bord et plan de budget (chargé après money.js)
'use strict';

let dash = null, plan = null, mView = 'month', topPeriod = 'month';
const WD = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const eur0 = (v) => Math.round(+v || 0).toLocaleString('fr-FR') + ' €';
const MOMENTS = [['matin', 'Matin', '5 h – 11 h'], ['midi', 'Midi', '11 h – 14 h'], ['aprem', 'Après-midi', '14 h – 19 h'], ['soir', 'Soirée', '19 h – 5 h']];
const shortMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }); };
const parseNum = (v) => { if (v == null || String(v).trim() === '') return null; const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : NaN; };

// ---------------------------------------------------------------- Vues
function setMoneyView(v) {
  mView = v;
  document.querySelectorAll('#mViews button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('mvMonth').classList.toggle('hidden', v !== 'month');
  $('mvDash').classList.toggle('hidden', v !== 'dash');
  $('mvBudget').classList.toggle('hidden', v !== 'budget');
  document.querySelector('#t-money .monthnav').style.visibility = v === 'budget' ? 'hidden' : 'visible';
  if (v === 'dash') loadDash();
  if (v === 'budget') loadPlan().then(renderPlan);
}

async function loadPlan() {
  try { plan = await rpc('kairos_plan'); } catch (e) { console.warn(e); }
  return plan;
}
async function loadDash() {
  try { dash = await rpc('kairos_money_dash', { p_month: mMonth ? mMonth + '-01' : null }); renderDash(); }
  catch (e) { $('dProj').textContent = 'Erreur : ' + e.message; }
}

// ---------------------------------------------------------------- Graphiques (SVG)
const W = 340;
function axisStep(max) { const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw || 1))); return [1, 2, 2.5, 5, 10].map(k => k * p).find(s => s >= raw) || raw; }
function attachTip(box, tip, svg, n, xOf, html) {
  const marker = svg.querySelector('.cross');
  const show = (i) => {
    tip.innerHTML = html(i); tip.classList.add('show');
    const k = svg.getBoundingClientRect().width / W, bw = box.getBoundingClientRect().width;
    tip.style.left = Math.max(85, Math.min(bw - 85, xOf(i) * k)) + 'px'; tip.style.top = '0px';
    if (marker) { marker.setAttribute('x1', xOf(i)); marker.setAttribute('x2', xOf(i)); marker.style.opacity = 1; }
    svg.querySelectorAll('[data-i]').forEach(el => el.classList.toggle('active', +el.dataset.i === i));
  };
  const hide = () => { tip.classList.remove('show'); if (marker) marker.style.opacity = 0; svg.querySelectorAll('[data-i]').forEach(el => el.classList.remove('active')); };
  const pick = (e) => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W;
    let best = 0, bd = 1e9; for (let i = 0; i < n; i++) { const d = Math.abs(xOf(i) - x); if (d < bd) { bd = d; best = i; } }
    show(best);
  };
  svg.addEventListener('pointermove', pick); svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
}

function renderPace() {
  const d = dash, nd = d.days_in_month, today = d.today, budget = d.budget ? +d.budget : null;
  const cum = (arr, upto) => { const by = {}; arr.forEach(p => by[p.d] = +p.v); const out = []; let s = 0; for (let i = 1; i <= upto; i++) { s += by[i] || 0; out.push(s); } return out; };
  const cur = cum(d.daily, today), prev = cum(d.prev_daily, nd);
  const H = 180, pl = 38, pb = 22, pt = 10, iw = W - pl - 6, ih = H - pb - pt;
  const max = Math.max(10, budget || 0, ...cur, ...prev) * 1.05, step = axisStep(max), top = Math.ceil(max / step) * step;
  const x = (day) => pl + (day - 1) / (nd - 1) * iw, y = (v) => pt + ih - v / top * ih;
  const path = (arr) => arr.map((v, i) => (i ? 'L' : 'M') + x(i + 1).toFixed(1) + ',' + y(v).toFixed(1)).join('');
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Dépenses cumulées jour par jour">';
  for (let v = 0; v <= top; v += step) s += '<line class="grid" x1="' + pl + '" x2="' + (W - 6) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (pl - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
  [1, 8, 15, 22, nd].forEach(dd => { s += '<text x="' + x(dd) + '" y="' + (H - 6) + '" text-anchor="middle">' + dd + '</text>'; });
  if (budget) s += '<line class="quota" x1="' + x(1) + '" y1="' + y(0) + '" x2="' + x(nd) + '" y2="' + y(budget) + '"/>';
  s += '<path d="' + path(prev) + '" fill="none" style="stroke:var(--s-scroll)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>';
  s += '<path d="' + path(cur) + '" fill="none" style="stroke:var(--s-read)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
  if (cur.length) s += '<circle cx="' + x(cur.length) + '" cy="' + y(cur[cur.length - 1]) + '" r="4.5" style="fill:var(--s-read);stroke:var(--chart-surface)" stroke-width="2"/>';
  s += '<line class="cross" y1="' + pt + '" y2="' + (pt + ih) + '" style="stroke:var(--muted)" stroke-width="1" opacity="0"/></svg>';
  const box = $('dPace'), tip = $('dPaceTip'); box.innerHTML = s; box.appendChild(tip);
  attachTip(box, tip, box.querySelector('svg'), nd, (i) => x(i + 1), (i) =>
    '<div class="d">' + (i + 1) + ' ' + monthOnly(d.month) + '</div>' +
    (i < cur.length ? '<div class="r"><i class="dot read"></i>Ce mois<b>' + eur(cur[i]) + '</b></div>' : '') +
    '<div class="r"><i class="dot scroll"></i>Mois dernier<b>' + eur(prev[i] ?? prev[prev.length - 1] ?? 0) + '</b></div>' +
    (budget ? '<div class="r"><i class="q" style="width:10px;border-top:1.5px dashed var(--muted)"></i>Rythme budget<b>' + eur(budget * (i + 1) / nd) + '</b></div>' : ''));

  const spent = cur[cur.length - 1] || 0;
  let txt;
  if (today < nd && today >= 3) {
    const proj = spent / today * nd;
    txt = 'À ce rythme : environ <b>' + eur0(proj) + '</b> fin ' + monthOnly(d.month);
    if (budget) txt += proj > budget ? ', soit <span style="color:var(--danger)">' + eur0(proj - budget) + ' au-dessus</span> du budget.' : ', soit ' + eur0(budget - proj) + ' sous le budget.';
    else txt += '.';
    if (budget) {
      const ideal = budget * today / nd, diff = spent - ideal;
      txt += ' Aujourd\'hui, tu es ' + (Math.abs(diff) < 5 ? 'pile dans le rythme' : diff > 0 ? eur0(diff) + ' au-dessus du rythme' : eur0(-diff) + ' en dessous du rythme') + '.';
    }
  } else if (today < 3) txt = 'Début de mois : la projection arrive dans quelques jours.';
  else txt = 'Total du mois : <b>' + eur0(spent) + '</b>' + (budget ? ' pour un budget de ' + eur0(budget) + '.' : '.');
  $('dProj').innerHTML = txt;
}

function barChart(boxId, tipId, items, opts) {
  const H = opts.h || 170, pl = 38, pb = 22, pt = 10, iw = W - pl - 6, ih = H - pb - pt;
  const max = Math.max(10, opts.ref || 0, ...items.map(i => i.v)) * 1.05, step = axisStep(max), top = Math.ceil(max / step) * step;
  const y = (v) => pt + ih - v / top * ih, cw = iw / items.length, bw = Math.min(26, cw - 8);
  const xc = (i) => pl + cw * i + cw / 2;
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + opts.label + '">';
  for (let v = 0; v <= top; v += step) s += '<line class="grid" x1="' + pl + '" x2="' + (W - 6) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (pl - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
  items.forEach((it, i) => {
    const h = Math.max(0, it.v / top * ih), x0 = xc(i) - bw / 2, y1 = pt + ih - h, r = Math.min(4, h, bw / 2);
    s += '<g data-i="' + i + '" class="col"><rect class="hl" x="' + (pl + cw * i + 2) + '" y="' + pt + '" width="' + (cw - 4) + '" height="' + ih + '" rx="8" fill="transparent"/>';
    if (h > .5) s += '<path style="fill:var(--s-read)" opacity="' + (it.dim ? .45 : 1) + '" d="M' + x0 + ',' + (pt + ih) + 'V' + (y1 + r) + 'Q' + x0 + ',' + y1 + ' ' + (x0 + r) + ',' + y1 + 'H' + (x0 + bw - r) + 'Q' + (x0 + bw) + ',' + y1 + ' ' + (x0 + bw) + ',' + (y1 + r) + 'V' + (pt + ih) + 'Z"/>';
    s += '<text x="' + xc(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + it.label + '</text></g>';
  });
  if (opts.ref) s += '<line class="quota" x1="' + pl + '" x2="' + (W - 6) + '" y1="' + y(opts.ref) + '" y2="' + y(opts.ref) + '"/>';
  s += '</svg>';
  const box = $(boxId), tip = $(tipId); box.innerHTML = s; box.appendChild(tip);
  attachTip(box, tip, box.querySelector('svg'), items.length, xc, opts.tip);
}

function renderDash() {
  if (!dash) return;
  renderPace();

  // 6 mois
  const months = dash.months.map((m, i, a) => ({ label: shortMonth(m.m), v: +m.total, m, dim: i === a.length - 1 && money && money.is_current }));
  barChart('d6m', 'd6mTip', months, {
    label: 'Dépenses des 6 derniers mois', ref: dash.budget ? +dash.budget : null,
    tip: (i) => {
      const m = months[i].m, cats = Object.entries(m.cats || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return '<div class="d">' + monthName(m.m) + '</div><div class="r">Total<b>' + eur(m.total) + '</b></div>' +
        cats.map(([c, v]) => '<div class="r">' + catOf(c)[0] + ' ' + catOf(c)[1] + '<b>' + eur(v) + '</b></div>').join('');
    }
  });
  const full = dash.months.slice(0, -1).filter(m => +m.total > 0);
  if (full.length) {
    const avg = full.reduce((a, m) => a + +m.total, 0) / full.length;
    // catégorie qui a le plus augmenté ce mois par rapport à la moyenne
    const last = dash.months[dash.months.length - 1], cats = {};
    full.forEach(m => Object.entries(m.cats || {}).forEach(([c, v]) => cats[c] = (cats[c] || 0) + v / full.length));
    let up = null; Object.entries(last.cats || {}).forEach(([c, v]) => { const d = v - (cats[c] || 0); if (!up || d > up[1]) up = [c, d]; });
    $('d6mTxt').innerHTML = 'Moyenne des mois précédents : <b>' + eur0(avg) + '</b>.' +
      (up && up[1] > 10 ? ' Ce mois-ci, c\'est <b>' + catOf(up[0])[1] + '</b> qui grimpe le plus (+' + eur0(up[1]) + ' vs moyenne).' : '') +
      (money && money.is_current ? ' <span style="opacity:.7">(mois en cours en clair)</span>' : '');
  } else $('d6mTxt').textContent = 'L\'historique se remplira au fil des mois.';

  renderTop();

  // Habitudes : jours
  const wk = Array.from({ length: 7 }, (_, i) => { const r = (dash.weekday || []).find(w => w.w === i + 1); return { label: WD[i].charAt(0).toUpperCase(), v: r ? +r.v : 0, n: r ? r.n : 0, full: WD[i] }; });
  barChart('dWeek', 'dWeekTip', wk, { h: 140, label: 'Dépenses par jour de la semaine', tip: (i) => '<div class="d">' + wk[i].full + '</div><div class="r">' + wk[i].n + ' paiement' + (wk[i].n > 1 ? 's' : '') + '<b>' + eur(wk[i].v) + '</b></div>' });

  // Habitudes : moments
  const mom = dash.moments || [], tot = mom.reduce((a, m) => a + +m.v, 0) || 1;
  $('dMoments').innerHTML = MOMENTS.map(([k, n, h]) => {
    const r = mom.find(m => m.k === k), v = r ? +r.v : 0, pct = Math.round(v / tot * 100);
    return '<div class="momrow"><div><b style="font-size:13.5px">' + n + '</b><div class="note" style="font-size:11.5px">' + h + '</div></div>' +
      '<div class="bar"><i style="width:' + pct + '%"></i></div><div class="p">' + pct + ' %</div></div>';
  }).join('');
  const soir = mom.find(m => m.k === 'soir'), wkMax = wk.reduce((a, b) => b.v > a.v ? b : a, wk[0]);
  let ht = '';
  if (soir && +soir.v > 0) ht += 'Le soir (après 19 h), tu fais <b>' + Math.round(+soir.v / tot * 100) + ' %</b> de tes dépenses' + (soir.top ? ', surtout en <b>' + catOf(soir.top)[1].toLowerCase() + '</b>' : '') + '. ';
  if (wkMax.v > 0) ht += 'Ton jour le plus dépensier : le <b>' + wkMax.full + '</b>.';
  $('dHabitTxt').innerHTML = ht || 'Pas encore assez de données.';
}

function renderTop() {
  const list = (topPeriod === 'month' ? dash.top_month : dash.top_3m) || [], max = Math.max(1, ...list.map(t => +t.total));
  $('dTop').innerHTML = list.length ? list.map(t => {
    const [e] = catOf(t.category);
    return '<div class="catrow" style="cursor:default"><div class="e">' + e + '</div><div><div class="n">' + esc(t.name) + '<small>' + t.n + '×</small></div>' +
      '<div class="bar"><i style="width:' + (+t.total / max * 100) + '%"></i></div></div><div class="v">' + eur(t.total) + '</div></div>';
  }).join('') : '<p class="note" style="margin:0">Pas encore de dépenses sur cette période.</p>';
}

// ---------------------------------------------------------------- Plan de budget
function planNumbers() {
  const income = parseNum($('bIncome').value) || 0, savings = parseNum($('bSavings').value) || 0;
  const fixed = (plan.fixed || []).reduce((a, f) => a + +f.amount, 0), subs = +plan.subs_monthly || 0;
  const env = {}; document.querySelectorAll('#bEnv input').forEach(i => { const v = parseNum(i.value); if (v) env[i.dataset.cat] = v; });
  const envTotal = Object.values(env).reduce((a, b) => a + b, 0);
  return { income, savings, fixed, subs, left: income - fixed - subs - savings, env, envTotal };
}

function renderPlan() {
  if (!plan) return;
  if (document.activeElement?.id !== 'bIncome') $('bIncome').value = plan.income ? fmtIn(plan.income) : '';
  if (document.activeElement?.id !== 'bSavings') $('bSavings').value = plan.savings ? fmtIn(plan.savings) : '';
  $('bSubs').textContent = eur2(plan.subs_monthly || 0);
  $('bFixed').innerHTML = (plan.fixed || []).map(f =>
    '<div class="listrow" data-fx="' + f.id + '"><div class="e">📌</div><div><div class="t">' + esc(f.name) + '</div><div class="d">' + (f.day ? 'le ' + f.day + ' du mois' : 'chaque mois') + '</div></div><div class="v">' + eur2(f.amount) + '</div></div>').join('');
  $('bFixed').querySelectorAll('[data-fx]').forEach(r => r.addEventListener('click', () => fixedSheet(plan.fixed.find(f => String(f.id) === r.dataset.fx))));
  const goals = (money && money.goals) || [];
  $('bSavingsHint').innerHTML = goals.length ? 'Objectif en cours : <b>' + esc(goals[0].name) + '</b> (' + eur(goals[0].saved) + ' / ' + eur(goals[0].target) + ').' : 'Astuce : crée un objectif d\'épargne dans l\'onglet Mois pour suivre ce que tu mets de côté.';
  const envs = plan.envelopes || {}, avg = plan.avg3 || {}, spent = plan.spent || {};
  $('bEnv').innerHTML = Object.entries(CATS).map(([k, [e, n]]) => {
    const hint = [avg[k] ? 'moy. ' + eur(avg[k]) : null, spent[k] ? 'ce mois ' + eur(spent[k]) : null].filter(Boolean).join(' · ');
    return '<div class="envrow"><div class="e">' + e + '</div><div><div class="n">' + n + '</div><div class="h">' + (hint || '—') + '</div></div>' +
      '<input inputmode="decimal" data-cat="' + k + '" placeholder="0" value="' + (envs[k] ? fmtIn(envs[k]) : '') + '"></div>';
  }).join('');
  $('bEnv').querySelectorAll('input').forEach(i => i.addEventListener('input', renderPlanTotals));
  renderPlanTotals();
}

function renderPlanTotals() {
  const p = planNumbers();
  $('bLeft').textContent = p.income ? eur(p.left) : '—';
  $('bLeftTxt').innerHTML = p.income
    ? eur(p.income) + ' de revenus − ' + eur(p.fixed + p.subs) + ' de charges fixes − ' + eur(p.savings) + ' d\'épargne'
    : 'Indique tes revenus pour calculer ce qu\'il te reste chaque mois.';
  let t = 'Enveloppes : <b>' + eur(p.envTotal) + '</b> / mois';
  if (p.income) {
    const free = p.left - p.envTotal;
    t += free >= 0 ? ' · <span>' + eur(free) + ' non répartis</span> (marge ou épargne en plus)' : ' · <span style="color:var(--danger)">' + eur(-free) + ' de plus que ton reste à vivre</span>';
  }
  $('bEnvSum').innerHTML = t;
}

function fillFromAverages() {
  const avg = plan.avg3 || {}, months = plan.months_of_data || 0;
  const defaults = { courses: 200, resto: 120, transport: 75, jeux: 30, sorties: 60, achats: 60, abonnements: Math.ceil(plan.subs_monthly || 0), sante: 20, maison: 30, autre: 30 };
  document.querySelectorAll('#bEnv input').forEach(i => {
    const k = i.dataset.cat;
    // moyenne arrondie aux 10 € supérieurs ; valeurs par défaut s'il n'y a pas encore d'historique
    const v = months >= 1 && avg[k] ? Math.ceil(avg[k] / 10) * 10 : (months >= 1 ? 0 : defaults[k]);
    i.value = v ? String(v) : '';
  });
  renderPlanTotals();
  $('bSaved').textContent = months >= 1 ? 'Proposé d\'après ta moyenne sur ' + months + ' mois (arrondi). Ajuste à ton goût.' : 'Pas encore d\'historique : valeurs de départ indicatives, ajuste-les.';
}

async function savePlan() {
  const p = planNumbers();
  if (isNaN(p.income) || isNaN(p.savings)) return alert('Montant invalide');
  try {
    $('bSave').disabled = true;
    await rpc('kairos_plan_save', { p_income: p.income, p_savings: p.savings, p_envelopes: p.env });
    $('bSaved').textContent = 'Budget enregistré ✓ ' + (p.envTotal ? eur(p.envTotal) + ' / mois en enveloppes, alertes à 80 % et 100 %.' : '');
    await loadPlan(); loadMoney();
  } catch (e) { alert(e.message); } finally { $('bSave').disabled = false; }
}

function fixedSheet(f) {
  openSheet(f ? 'Charge fixe' : 'Nouvelle charge fixe',
    '<label class="field"><span>Nom</span><input name="name" required value="' + esc(f ? f.name : '') + '" placeholder="Loyer, forfait, assurance…"></label>' +
    '<label class="field"><span>Montant par mois (€)</span><input name="amount" inputmode="decimal" required value="' + (f ? fmtIn(f.amount) : '') + '"></label>' +
    '<label class="field"><span>Jour du prélèvement (facultatif)</span><input name="day" inputmode="numeric" value="' + (f && f.day ? f.day : '') + '" placeholder="5"></label>',
    async (fd) => {
      const day = parseInt(fd.get('day'), 10);
      await rpc('kairos_fixed_save', { p_id: f ? f.id : null, p_name: fd.get('name'), p_amount: num(fd.get('amount')), p_day: day >= 1 && day <= 31 ? day : null });
      await loadPlan(); renderPlan();
    },
    f ? async () => { await rpc('kairos_fixed_delete', { p_id: f.id }); await loadPlan(); renderPlan(); } : null);
}

// ---------------------------------------------------------------- Branchements
(function wireDash() {
  document.querySelectorAll('#mViews button').forEach(b => b.addEventListener('click', () => setMoneyView(b.dataset.v)));
  document.querySelectorAll('#dTopSeg button').forEach(b => b.addEventListener('click', () => {
    topPeriod = b.dataset.p; document.querySelectorAll('#dTopSeg button').forEach(x => x.classList.toggle('on', x === b)); renderTop();
  }));
  $('bIncome').addEventListener('input', renderPlanTotals);
  $('bSavings').addEventListener('input', renderPlanTotals);
  $('bAddFixed').addEventListener('click', () => fixedSheet(null));
  $('bFillAvg').addEventListener('click', fillFromAverages);
  $('bSave').addEventListener('click', savePlan);
})();
