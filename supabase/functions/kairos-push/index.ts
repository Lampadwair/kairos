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
    rows = (await rpc("kairos_due_reminders", { p_secret: secret })) ?? [];
  } catch (e) {
    return new Response(String((e as Error).message), { status: 403 });
  }
  let sent = 0, dropped = 0, failed = 0;
  await Promise.all(rows.map(async (r) => {
    const payload = JSON.stringify({
      title: "Kairos",
      body: message(r.r_minutes),
      url: `./?stop=1&m=${r.r_minutes}`,
    });
    try {
      await webpush.sendNotification(
        { endpoint: r.r_endpoint, keys: { p256dh: r.r_p256dh, auth: r.r_auth } },
        payload,
        { TTL: 240, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await rpc("kairos_drop_push", { p_endpoint: r.r_endpoint, p_secret: secret }); dropped++; }
      else { failed++; console.error("push", code, (e as Error).message); }
    }
  }));
  return Response.json({ due: rows.length, sent, dropped, failed });
});
