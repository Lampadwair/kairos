// Kairos — module « Nuits » : sommeil Garmin (via Santé), coucher progressif, lien avec les soirées.
'use strict';
let nights = null, nSaveTimer = null;

const m18 = (m) => { if (m == null) return '—'; const t = ((Math.round(m) + 18 * 60) % 1440 + 1440) % 1440; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
const durTxt = (m) => { m = Math.round(Math.abs(m || 0)); return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0'); };
const dOf = (iso) => { const [y, mo, d] = iso.split('-').map(Number); return new Date(y, mo - 1, d); };
const isoOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addDays = (iso, n) => { const d = dOf(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const nightDay = (iso) => dOf(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const clock = (m) => m == null ? 'Libre' : String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String((((m % 1440) + 1440) % 1440) % 60).padStart(2, '0');
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const avg = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = avg(a); return Math.sqrt(avg(a.map(v => (v - m) ** 2))); };

async function loadNights() {
  try {
    const fresh = await rpc('kairos_nights_dash', { p_days: 30 });
    if (nSaveTimer) return; // réglage en cours d'envoi
    nights = fresh; store.set('kairos.nights', nights);
    renderNights(); renderNightSettings();
  } catch (e) { if (!nights) { nights = store.get('kairos.nights'); if (nights) { renderNights(); renderNightSettings(); } } }
}

let nView = 'today';
function setNightView(v) {
  nView = v;
  document.querySelectorAll('#nViews button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('nvToday').classList.toggle('hidden', v !== 'today');
  $('nvTrends').classList.toggle('hidden', v !== 'trends');
}

function renderNights() {
  const d = nights; if (!d) return;
  const st = d.settings, list = d.nights || [], ev = d.tonight.night;
  const by = {}; list.forEach(n => by[n.night] = n);

  if (st.last_sleep_sync) {
    const t = new Date(st.last_sleep_sync), today = new Date().toDateString() === t.toDateString();
    $('nSync').textContent = 'Synchro ' + (today ? t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : 'le ' + t.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }));
  } else $('nSync').textContent = '';
  $('nEmpty').classList.toggle('hidden', list.length > 0);
  $('nLastWrap').classList.toggle('hidden', list.length === 0);
  if (!list.length && nView === 'trends') setNightView('today');
  $('nViews').classList.toggle('hidden', list.length === 0);

  renderTonight(d);
  if (!list.length) return;

  // Dernière nuit
  const last = list[list.length - 1];
  const fresh = last.night >= addDays(ev, -1);
  $('nLastLbl').textContent = (fresh ? '' : '⚠️ Pas de données plus récentes · ') + 'Nuit du ' +
    dOf(last.night).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) + ' au ' +
    dOf(addDays(last.night, 1)).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  $('nLastDur').textContent = durTxt(last.asleep);
  let verdict = '';
  if (last.target_m != null) {
    const diff = last.bed_m - last.target_m;
    verdict = diff <= 0 ? ' · cible ' + m18(last.target_m) + ' tenue ✓' : diff <= 15 ? ' · cible ' + m18(last.target_m) + ' : presque ✓' : ' · cible ' + m18(last.target_m) + ' : +' + durTxt(diff);
  }
  $('nLastTxt').textContent = 'Endormi ' + last.bed + ' → réveil ' + last.wake + verdict;
  const stg = [['deep', 'Profond', 'st-deep'], ['core', 'Léger', 'st-core'], ['rem', 'Paradoxal', 'st-rem'], ['awake', 'Éveillé', 'st-awake']];
  if ((last.deep + last.core + last.rem) > 0) {
    $('nStages').classList.remove('hidden');
    $('nStages').innerHTML = stg.filter(([k]) => last[k] > 0).map(([k, , c]) => '<i class="' + c + '" style="flex:' + last[k] + '"></i>').join('');
    $('nStLegend').innerHTML = stg.filter(([k]) => last[k] > 0).map(([k, n, c]) => '<span><i class="dot ' + c + '"></i>' + n + ' <b>' + durTxt(last[k]) + '</b></span>').join('');
  } else {
    $('nStages').classList.add('hidden');
    $('nStLegend').innerHTML = '<span>Phases non transmises par Santé pour cette nuit.</span>';
  }

  // Tendances : 7 dernières nuits
  const in7 = list.filter(n => n.night >= addDays(ev, -7) && n.night < ev);
  const prev7 = list.filter(n => n.night >= addDays(ev, -14) && n.night < addDays(ev, -7));
  const debt = in7.reduce((s, n) => s + (st.sleep_goal_min - n.asleep), 0);
  $('nDebt').textContent = in7.length ? durTxt(avg(in7.map(n => n.asleep))) : '—';
  $('nDebtS').textContent = !in7.length ? 'Pas de nuit cette semaine'
    : 'Objectif ' + durTxt(st.sleep_goal_min) + (debt > 15 ? ' · manque ' + durTxt(debt) + ' sur ' + in7.length + ' nuit' + (in7.length > 1 ? 's' : '') : ' · objectif tenu ✓');
  const bedAvg = avg(in7.map(n => n.bed_m)), bedPrev = prev7.length >= 3 ? avg(prev7.map(n => n.bed_m)) : null;
  $('nBedAvg').textContent = bedAvg == null ? '—' : m18(bedAvg);
  $('nBedAvgS').textContent = bedAvg == null ? '' : bedPrev == null ? 'Comparaison dès 2 semaines de données'
    : Math.abs(bedAvg - bedPrev) < 5 ? 'Comme la semaine d\'avant' : durTxt(bedAvg - bedPrev) + (bedAvg < bedPrev ? ' plus tôt' : ' plus tard') + ' que la semaine d\'avant';
  const withT = in7.filter(n => n.target_m != null), hit = withT.filter(n => n.bed_m <= n.target_m + 15).length;
  $('nHit').textContent = withT.length ? hit + ' / ' + withT.length : '—';
  $('nHitS').textContent = withT.length ? 'Soirs dans la cible (marge 15 min)' : (st.bed_target_m18 == null ? 'Cible pas encore fixée' : 'Pas encore de soir avec cible');
  const wk = list.filter(n => n.night >= addDays(ev, -14) && n.applies), wakes = wk.map(n => n.wake_m), wsd = sd(wakes);
  $('nWake').textContent = wakes.length ? m18(avg(wakes)) : '—';
  $('nWakeS').textContent = !wakes.length ? 'Pas encore de jour de semaine' : wsd == null ? 'Moyenne (1 jour)' : 'Moyenne · varie de ±' + Math.round(wsd) + ' min';

  renderNightChart(ev, by, st, list);
  renderInsights(list, st, wsd, wakes);
}

function renderTonight(d) {
  const st = d.settings, days = d.days || [], t0 = days[0];
  const wd = dOf(d.tonight.night).toLocaleDateString('fr-FR', { weekday: 'long' });
  // Cible du soir
  if (st.bed_target_m18 == null) { $('nTonight').textContent = '—'; $('nTonightLbl').textContent = 'Cible de coucher'; }
  else if (d.tonight.applies) { $('nTonight').textContent = m18(st.bed_target_m18); $('nTonightLbl').textContent = 'Cible de coucher'; }
  else { $('nTonight').textContent = 'Libre'; $('nTonightLbl').textContent = 'Ce ' + wd; }
  // Réveil de demain
  if (t0) {
    $('nWakeTomorrow').textContent = clock(t0.wake);
    $('nWakeLbl').textContent = 'Réveil ' + dOf(addDays(t0.night, 1)).toLocaleDateString('fr-FR', { weekday: 'long' });
    $('nWakeChip').textContent = t0.wake == null ? 'pas de réveil' : t0.override ? 'modifié' : 'par défaut';
  }
  const sub = [];
  if (st.bed_target_m18 == null) sub.push('La cible de coucher sera fixée dès 3 nuits reçues, à partir de tes habitudes.');
  else if (d.tonight.applies) {
    if (st.bed_remind) sub.push('Rappels à ' + m18(st.bed_target_m18 - st.bed_remind_before) + ' et ' + m18(st.bed_target_m18));
    sub.push(st.bed_target_m18 <= st.bed_final_m18 ? 'objectif ' + m18(st.bed_final_m18) + ' atteint 🎉' : 'objectif à terme ' + m18(st.bed_final_m18));
  } else sub.push('Pas de réveil prévu demain : pas de cible ce soir.');
  $('nTonightTxt').textContent = cap(sub.join(' · '));

  const items = [];
  if (t0 && t0.wake != null) {
    const goal = st.sleep_goal_min, asleepBy = t0.wake - goal, inBed = asleepBy - 15;
    items.push('Pour <b>' + durTxt(goal) + '</b> de sommeil : au lit vers <b>' + clock(inBed) + '</b> (endormi à ' + clock(asleepBy) + ').');
    if (st.bed_target_m18 != null && d.tonight.applies) {
      const possible = ((t0.wake - (st.bed_target_m18 + 1080)) % 1440 + 1440) % 1440, gap = possible - goal;
      items.push('En suivant ta cible : environ <b>' + durTxt(possible) + '</b> de sommeil' + (gap >= -15 ? ' ✓' : '') + '.');
      if (gap < -60) items.push('Il manquerait ' + durTxt(-gap) + '. La cible avance doucement, mais te coucher plus tôt ce soir reste le mieux : chaque quart d\'heure compte.');
    }
  } else if (t0) {
    items.push('Soirée libre. Pour ne pas décaler ta semaine, lève-toi quand même à moins d\'1 h de ton heure habituelle (' + clock(st.wake_week_m) + ').');
  }
  $('nPlan').innerHTML = items.map(x => '<li>' + x + '</li>').join('');
  $('nPlan').classList.toggle('hidden', !items.length);

  $('nDays').innerHTML = days.map((x, i) => {
    const w = dOf(addDays(x.night, 1));
    return '<button type="button" data-i="' + i + '" class="' + (x.wake == null ? 'free ' : '') + (x.override ? 'mod ' : '') + (i === 0 ? 'next' : '') + '">' +
      '<span class="w">' + w.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '') + '</span><span class="d">' + w.getDate() + '</span>' +
      '<span class="t">' + (x.wake == null ? 'libre' : clock(x.wake)) + '</span></button>';
  }).join('');
  $('nDays').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { const x = days[+b.dataset.i]; wakeSheet(addDays(x.night, 1), x); }));
}

function renderNightChart(ev, by, st, list) {
  // De la première nuit connue (14 max) jusqu'à hier soir
  const first = list.length ? list[0].night : addDays(ev, -7);
  let start = first > addDays(ev, -14) ? first : addDays(ev, -14);
  if (start > addDays(ev, -7)) start = addDays(ev, -7);
  const slots = []; for (let s = start; s < ev; s = addDays(s, 1)) slots.push(s);
  $('nChartH').textContent = slots.length + ' dernières nuits';
  const rows = slots.map(s => by[s]).filter(Boolean);
  const H = 220, pl = 40, pb = 30, pt = 8, iw = W - pl - 6, ih = H - pb - pt;
  const vals = rows.flatMap(n => [n.bed_m, n.wake_m, n.target_m].filter(v => v != null));
  const lo = Math.floor((Math.min(...vals, 300) - 30) / 60) * 60, hi = Math.ceil((Math.max(...vals, 780) + 30) / 60) * 60;
  const y = (m) => pt + (m - lo) / (hi - lo) * ih, cw = iw / slots.length, bw = Math.min(16, cw - 6), xc = (i) => pl + cw * i + cw / 2;
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Heures d\'endormissement et de réveil">';
  const stepH = (hi - lo) > 720 ? 180 : 120;
  for (let m = Math.ceil(lo / stepH) * stepH; m <= hi; m += stepH) s += '<line class="grid" x1="' + pl + '" x2="' + (W - 6) + '" y1="' + y(m) + '" y2="' + y(m) + '"/><text x="' + (pl - 6) + '" y="' + (y(m) + 4) + '" text-anchor="end">' + m18(m).replace(':00', ' h') + '</text>';
  slots.forEach((iso, i) => {
    const n = by[iso], dd = dOf(iso);
    s += '<g data-i="' + i + '" class="col"><rect class="hl" x="' + (pl + cw * i + 1) + '" y="' + pt + '" width="' + (cw - 2) + '" height="' + ih + '" rx="6" fill="transparent"/>';
    if (n) {
      const y0 = y(n.bed_m), y1 = y(n.wake_m);
      s += '<rect x="' + (xc(i) - bw / 2) + '" y="' + y0 + '" width="' + bw + '" height="' + Math.max(2, y1 - y0) + '" rx="' + Math.min(4, bw / 2) + '" style="fill:var(--s-scroll)"/>';
      if (n.target_m != null) s += '<line class="tgt" x1="' + (xc(i) - bw / 2 - 3) + '" x2="' + (xc(i) + bw / 2 + 3) + '" y1="' + y(n.target_m) + '" y2="' + y(n.target_m) + '"/>';
    }
    const show = slots.length <= 9 || i % 2 === (slots.length - 1) % 2;
    if (show) s += '<text x="' + xc(i) + '" y="' + (H - 16) + '" text-anchor="middle">' + dd.toLocaleDateString('fr-FR', { weekday: 'short' }).slice(0, 2) + '</text>' +
                   '<text x="' + xc(i) + '" y="' + (H - 3) + '" text-anchor="middle">' + dd.getDate() + '</text>';
    s += '</g>';
  });
  s += '</svg>';
  const box = $('nChart'), tip = $('nTip'); box.innerHTML = s; box.appendChild(tip);
  attachTip(box, tip, box.querySelector('svg'), slots.length, xc, (i) => {
    const n = by[slots[i]];
    if (!n) return '<div class="d">Nuit du ' + nightDay(slots[i]) + '</div><div class="r">Pas de données</div>';
    return '<div class="d">Nuit du ' + nightDay(slots[i]) + '</div>' +
      '<div class="r"><i class="dot scroll"></i>Sommeil<b>' + durTxt(n.asleep) + '</b></div>' +
      '<div class="r">Endormi → réveil<b>' + n.bed + ' → ' + n.wake + '</b></div>' +
      (n.target_m != null ? '<div class="r">Cible<b>' + m18(n.target_m) + '</b></div>' : '') +
      '<div class="r">Insta après 21 h<b>' + Math.round(n.insta_late) + ' min</b></div>' +
      '<div class="r">Lecture après 21 h<b>' + Math.round(n.read_late) + ' min</b></div>';
  });
  $('nTable').innerHTML = '<table><tr><th>Nuit</th><th>Endormi</th><th>Réveil</th><th>Sommeil</th><th>Cible</th></tr>' +
    slots.slice().reverse().filter(iso => by[iso]).map(iso => { const n = by[iso]; return '<tr><td>' + nightDay(iso) + '</td><td>' + n.bed + '</td><td>' + n.wake + '</td><td>' + durTxt(n.asleep) + '</td><td>' + (n.target_m != null ? m18(n.target_m) : '—') + '</td></tr>'; }).join('') + '</table>';
}

function renderInsights(list, st, wsd, wakes) {
  const out = [];
  const cmp = (key, thr, label) => {
    const a = list.filter(n => n[key] >= thr), b = list.filter(n => n[key] < thr);
    if (a.length < 2 || b.length < 2) return null;
    const ba = avg(a.map(n => n.bed_m)), bb = avg(b.map(n => n.bed_m)), sa = avg(a.map(n => n.asleep)), sb = avg(b.map(n => n.asleep));
    if (Math.abs(ba - bb) < 10) return '<p class="insight">' + label + ' : pas de vraie différence sur ton heure d\'endormissement (' + m18(ba) + ' contre ' + m18(bb) + ').</p>';
    return '<p class="insight">' + label + ', tu t\'endors en moyenne à <b>' + m18(ba) + '</b>, contre <b>' + m18(bb) + '</b> les autres soirs (' +
      durTxt(Math.abs(ba - bb)) + (ba > bb ? ' plus tard' : ' plus tôt') + ', ' + durTxt(sa) + ' de sommeil contre ' + durTxt(sb) + ').</p>';
  };
  if (list.length < 5) out.push('<p class="insight">Encore ' + (5 - list.length) + ' nuit(s) et Kairos pourra croiser ton sommeil avec tes soirées (Insta, lecture).</p>');
  else {
    const i1 = cmp('insta_late', 20, 'Les soirs avec 20 min ou plus d\'Insta après 21 h');
    const i2 = cmp('read_late', 10, 'Les soirs où tu lis au moins 10 min après 21 h');
    if (i1) out.push(i1); if (i2) out.push(i2);
    if (!i1 && !i2) out.push('<p class="insight">Pas encore assez de soirs contrastés (avec et sans Insta tard, avec et sans lecture) pour comparer. Ça viendra au fil des semaines.</p>');
  }
  if (wsd != null && wakes.length >= 4) {
    out.push(wsd > 45
      ? '<p class="insight">En semaine, ton réveil varie de <b>±' + Math.round(wsd) + ' min</b> d\'un jour à l\'autre. Se lever à une heure proche chaque jour, week-end compris (à 1 h près), rend en général les réveils moins durs.</p>'
      : '<p class="insight">Réveil plutôt régulier (<b>±' + Math.round(wsd) + ' min</b>) : bon point pour des réveils moins durs.</p>');
  }
  $('nInsights').innerHTML = out.join('');
}

function wakeSheet(day, x) {
  const st = nights.settings, wkend = [6, 7].includes(dOf(day).getDay() || 7);
  const def = wkend ? st.wake_weekend_m : st.wake_week_m;
  const cur = x.wake != null ? x.wake : (def != null ? def : 540);
  openSheet('Lever du ' + dOf(day).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
    '<label class="field"><span>Heure de lever</span><input name="t" type="time" step="300" value="' + clock(cur) + '"></label>' +
    '<label class="chk"><input type="checkbox" name="free"' + (x.wake == null ? ' checked' : '') + '> Jour libre (pas de réveil, pas de cible la veille)</label>' +
    (x.override ? '<label class="chk"><input type="checkbox" name="reset"> Revenir au réglage par défaut (' + clock(def) + ')</label>' : ''),
    async (fd) => {
      if (fd.get('reset')) await rpc('kairos_wake_set', { p_day: day, p_wake: null, p_reset: true });
      else if (fd.get('free')) await rpc('kairos_wake_set', { p_day: day, p_wake: null });
      else {
        const [hh, mm] = String(fd.get('t') || '').split(':').map(Number);
        if (!isFinite(hh) || !isFinite(mm)) throw new Error('Heure invalide');
        await rpc('kairos_wake_set', { p_day: day, p_wake: hh * 60 + mm });
      }
      await loadNights();
    });
}

// ---------------------------------------------------------------- Réglages
const nFmt = { dur: durTxt, hhmi: m18, min: (v) => v + ' min', clock: clock, free: clock };
function renderNightSettings() {
  if (!nights) return;
  const st = nights.settings;
  document.querySelectorAll('.stepper[data-nkey]').forEach(el => { el.querySelector('output').textContent = nFmt[el.dataset.fmt](st[el.dataset.nkey]); });
  document.querySelectorAll('#nRemindSeg button').forEach(b => b.classList.toggle('on', (b.dataset.on === '1') === !!st.bed_remind));
  const fin = ((st.wake_week_m - st.sleep_goal_min - 15) % 1440 + 1440) % 1440;
  $('nFinal').textContent = clock(fin);
  if (typeof renderSettingsHome === 'function') renderSettingsHome();
  $('nFinalDesc').textContent = 'Lever ' + clock(st.wake_week_m) + ' − ' + durTxt(st.sleep_goal_min) + ' de sommeil − 15 min pour t\'endormir';
}
async function saveNightSettings(recal) {
  const st = nights.settings;
  const r = await rpc('kairos_nights_settings', {
    p_goal: st.sleep_goal_min, p_step: st.bed_step_min, p_remind: !!st.bed_remind, p_before: st.bed_remind_before,
    p_wake_week: st.wake_week_m, p_wake_weekend: st.wake_weekend_m, p_recalibrate: !!recal });
  const sv = $('nSaved'); sv.classList.add('show'); setTimeout(() => sv.classList.remove('show'), 1400);
  return r;
}
function queueNightSave() {
  renderNightSettings();
  clearTimeout(nSaveTimer);
  nSaveTimer = setTimeout(async () => { try { await saveNightSettings(false); } catch (e) { alert(e.message); } nSaveTimer = null; loadNights(); }, 700);
}

(function wireNights() {
  document.querySelectorAll('#nViews button').forEach(b => b.addEventListener('click', () => setNightView(b.dataset.v)));
  $('cSleepUrl').textContent = URL_BASE + '/rest/v1/rpc/kairos_sleep';
  document.querySelectorAll('.stepper[data-nkey]').forEach(el => {
    const [minus, , plus] = el.children, k = el.dataset.nkey, mn = +el.dataset.min, mx = +el.dataset.max, sp = +el.dataset.step;
    const bump = (dir) => {
      if (!nights) return;
      const cur = nights.settings[k];
      if (el.dataset.fmt === 'free') { // null = libre, sous le minimum
        if (cur == null) { if (dir > 0) nights.settings[k] = 540; else return; }
        else { const v = cur + dir * sp; nights.settings[k] = v < mn ? null : Math.min(mx, v); }
      } else nights.settings[k] = Math.min(mx, Math.max(mn, cur + dir * sp));
      queueNightSave();
    };
    minus.addEventListener('click', () => bump(-1)); plus.addEventListener('click', () => bump(1));
  });
  document.querySelectorAll('#nRemindSeg button').forEach(b => b.addEventListener('click', () => { if (nights) { nights.settings.bed_remind = b.dataset.on === '1'; queueNightSave(); } }));
  $('nRecal').addEventListener('click', async () => {
    if (!nights || !confirm('Repartir de ta moyenne de coucher des 2 dernières semaines ?')) return;
    try { const r = await saveNightSettings(true); alert(r && r.message ? r.message : 'Il faut au moins 3 nuits récentes : la cible sera fixée dès qu\'elles seront là.'); loadNights(); }
    catch (e) { alert(e.message); }
  });
})();
// app.js démarre avant ce fichier : si l'app s'est ouverte sur l'onglet Nuits (notification), on charge maintenant.
if (session && currentTab === 'nights') loadNights();
