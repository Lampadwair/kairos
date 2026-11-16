// Kairos : envoi des rappels « pause scroll » (Web Push).
// Appelée chaque minute par la tâche planifiée (pg_cron), seulement s'il y a un rappel à envoyer.
// Aucun secret à recopier : la tâche planifiée envoie l'en-tête x-kairos-cron (secret tiré par la base),
// et les clés VAPID sont générées au premier appel puis gardées dans la table kairos_secrets.
// Réglage de la fonction : désactiver « Verify JWT ».
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://qhbrypojnamuhclaneem.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_R-5hYR-0GJ9aor-15lHpEg_wTPEDJFS"; // clé publique, comme dans config.js
const APP_URL = "https://lampadwair.github.io/kairos/";


async function rpc(fn: string, body: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function message(m: number) {
  const variants = [
    `Ça fait ${m} min que tu scrolles. Un chapitre à la place ? 📖`,
    `${m} min sur Insta… Ton manhwa t'attend 📖`,
    `Petite pause scroll ? Tu en es à ${m} min.`,
    `${m} min de défilement. On passe à quelque chose que tu as choisi ?`,
  ];
  return variants[Math.floor(m / 5) % variants.length];
}

Deno.serve(async (req) => {
  const secret = req.headers.get("x-kairos-cron") ?? "";
  if (secret.length < 24) return new Response("forbidden", { status: 403 });
  let rows: { r_user: string; r_minutes: number; r_endpoint: string; r_p256dh: string; r_auth: string }[] = [];
  try {
    let cfg = await rpc("kairos_push_config", { p_secret: secret });
    if (!cfg?.pub) { // premier lancement : on crée les clés des notifications
      const k = webpush.generateVAPIDKeys();
      await rpc("kairos_set_vapid", { p_secret: secret, p_pub: k.publicKey, p_priv: k.privateKey });
      cfg = await rpc("kairos_push_config", { p_secret: secret });
    }
    webpush.setVapidDetails(APP_URL, cfg.pub, cfg.priv);
    // Notification de test (appel manuel avec {"test": true})
    const body = await req.json().catch(() => ({}));
    if (body && body.test === true) {
      const targets: { r_endpoint: string; r_p256dh: string; r_auth: string }[] = (await rpc("kairos_push_targets", { p_secret: secret })) ?? [];
      const out = await Promise.all(targets.map(async (t) => {
        try {
          await webpush.sendNotification({ endpoint: t.r_endpoint, keys: { p256dh: t.r_p256dh, auth: t.r_auth } },
            JSON.stringify({ title: "Kairos", body: "Test : les notifications Kairos arrivent bien ✓", url: "./" }), { TTL: 600, urgency: "high" });
          return "ok";
        } catch (e) { return `erreur ${(e as { statusCode?: number }).statusCode ?? ""} ${(e as Error).message}`.slice(0, 200); }
      }));
      return Response.json({ test: true, results: out });
    }
    rows = (await rpc("kairos_due_reminders", { p_secret: secret })) ?? [];
  } catch (e) {
    return new Response(String((e as Error).message), { status: 403 });
  }
  // Alertes de renouvellement d'abonnement (module Argent)
  let subRows: { r_name: string; r_amount: number; r_days: number; r_endpoint: string; r_p256dh: string; r_auth: string }[] = [];
  try { subRows = (await rpc("kairos_due_sub_alerts", { p_secret: secret })) ?? []; }
  catch (e) { console.error("sub alerts", (e as Error).message); }

  // Rappels du soir et repère de lever (module Nuits)
  type Bed = { r_kind: string; r_target: string; r_bed: string; r_wake: string | null; r_sleep_min: number | null; r_adjusted: boolean; r_insta: boolean; r_before: number; r_endpoint: string; r_p256dh: string; r_auth: string };
  let bedRows: Bed[] = [];
  try { bedRows = (await rpc("kairos_due_bed", { p_secret: secret })) ?? []; }
  catch (e) { console.error("bed", (e as Error).message); }
  let anchorRows: { r_anchor: string; r_endpoint: string; r_p256dh: string; r_auth: string }[] = [];
  try { anchorRows = (await rpc("kairos_due_anchor", { p_secret: secret })) ?? []; }
  catch (e) { console.error("anchor", (e as Error).message); }

  let sent = 0, dropped = 0, failed = 0;
  const send = async (endpoint: string, p256dh: string, auth: string, payload: Record<string, unknown>, ttl: number) => {
    try {
      await webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, JSON.stringify(payload), { TTL: ttl, urgency: "high" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await rpc("kairos_drop_push", { p_endpoint: endpoint, p_secret: secret }); dropped++; }
      else { failed++; console.error("push", code, (e as Error).message); }
    }
  };
  const dur = (m: number) => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  const bedText = (r: Bed) => {
    const wake = r.r_wake && r.r_sleep_min != null ? ` Réveil ${r.r_wake} : ${dur(r.r_sleep_min)} de sommeil possible.` : "";
    const early = r.r_adjusted ? " (cible avancée : réveil plus tôt demain)" : "";
    return r.r_kind === "before"
      ? `Dans ${r.r_before} min, au lit (${r.r_bed}) pour t'endormir vers ${r.r_target}${early}.${r.r_insta ? " Un dernier chapitre plutôt qu'Insta ? 📖" : " 🌙"}${wake}`
      : `${r.r_bed} : c'est l'heure d'aller au lit${early}.${r.r_insta ? " On pose Insta ? 🌙" : " Bonne nuit 🌙"}${wake}`;
  };
  const euros = (v: number) => Number(v).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  const when = (d: number) => d <= 0 ? "aujourd'hui" : d === 1 ? "demain" : `dans ${d} jours`;
  await Promise.all([
    ...rows.map((r) => send(r.r_endpoint, r.r_p256dh, r.r_auth,
      { title: "Kairos", body: message(r.r_minutes), url: `./?stop=1&m=${r.r_minutes}` }, 240)),
    ...subRows.map((r) => send(r.r_endpoint, r.r_p256dh, r.r_auth,
      { title: "Kairos · Abonnement", body: `${r.r_name} se renouvelle ${when(r.r_days)} (${euros(r.r_amount)}).`, url: "./?tab=argent", tag: `kairos-sub-${r.r_name}` }, 43200)),
    ...bedRows.map((r) => send(r.r_endpoint, r.r_p256dh, r.r_auth,
      { title: "Kairos · Nuit", body: bedText(r), url: "./?tab=nuits", tag: "kairos-bed" }, 1200)),
    ...anchorRows.map((r) => send(r.r_endpoint, r.r_p256dh, r.r_auth,
      { title: "Kairos · Réveil", body: `${r.r_anchor} : ton repère de lever des jours libres ☀️ Debout maintenant, et lundi sera plus facile.`, url: "./?tab=nuits", tag: "kairos-anchor" }, 1800)),
  ]);
  return Response.json({ due: rows.length, subs: subRows.length, bed: bedRows.length, anchor: anchorRows.length, sent, dropped, failed });
});
