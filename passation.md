# Kairos : document de passation

*État au 16 novembre 2026, version 1.6.0.*

Kairos est une web app installable sur iPhone (PWA). Elle est reliée à des raccourcis iOS et à Supabase, et compte trois modules :

- **Soirée** : Insta face à la lecture de manhwas (Manga Pin), avec un quota, une série et des rappels pendant le scroll ;
- **Argent** : paiements Apple Pay, abonnements, objectifs, budget et analyse ;
- **Nuits** : sommeil de la Garmin récupéré via Santé, coucher progressif, levers et rappels du soir.

---

## 1. Architecture en bref

```
iPhone ─ Raccourcis/automatisations ──POST /rest/v1/rpc/kairos_*──┐
       └ PWA (GitHub Pages) ──Auth GoTrue + RPC──────────────────┤
                                                                 ▼
                                    Supabase « elan » (Postgres, RLS)
                                      ├─ tables kairos_*  (aucun accès direct)
                                      ├─ fonctions SECURITY DEFINER (seule porte d'entrée)
                                      ├─ pg_cron « kairos-rappels » (chaque minute)
                                      └─ Edge Function kairos-push (Web Push)
                                                                 │
                                         Notifications ◄─────────┘ (iPhone + montre)
```

- **Front :** HTML, CSS et JS sans framework ni supabase-js. Les appels REST à GoTrue et à PostgREST sont écrits à la main.
- **Hébergement :** GitHub Pages, à l'adresse https://lampadwair.github.io/kairos/ (dépôt **public**).
- **Back :** projet Supabase **elan** (ref `qhbrypojnamuhclaneem`), **partagé avec Hepha**. Tous les objets Kairos sont préfixés `kairos_`.
- **Compte :** les inscriptions sont fermées. L'utilisateur se connecte avec son compte Hepha.

## 2. Fichiers (`Documents\kairos`)

| Fichier | Rôle |
|---|---|
| `index.html` | Toutes les vues et tout le CSS : connexion, onglets Ce soir / Argent / Nuits / Réglages, écran « pause scroll », fenêtre d'édition |
| `config.js` | URL Supabase, clé *publishable*, nom du raccourci de lecture (`Kairos Lire`) |
| `app.js` | Session et auth, RPC, onglet Ce soir, réglages Soirée, notifications push, navigation des Réglages (`sPage`, `renderSettingsHome`). Contient `APP_VER` |
| `money.js` | Onglet Argent : mois, catégories, abonnements, objectifs, transactions, fenêtres d'édition (`openSheet`) |
| `dash.js` | Argent → Analyse et Budget : graphiques de rythme, 6 mois, top commerçants, plan de budget. Contient `attachTip` et `W` (réutilisés par Nuits) |
| `nights.js` | Onglet Nuits : vues Aujourd'hui et Tendances, levers (`wakeSheet`), réglages Nuits |
| `sw.js` | Service worker : cache versionné (`kairos-v10`), push, clic sur notification (`?stop=1`, `?tab=argent`, `?tab=nuits`) |
| `version.json` | Version publiée, utilisée par la détection de mise à jour |
| `publier.bat` | `git add`, `commit` et `push` vers GitHub Pages (double-clic) |
| `LISEZMOI.md` | Guide d'installation pour l'utilisateur |
| `supabase/schema.sql` | Base : profils, événements Insta/lecture, `kairos_log`, sessions, série, tableau de bord |
| `supabase/rappels.sql` | Push : abonnements, secrets, rappels de scroll, clés VAPID, tâche cron |
| `supabase/argent.sql` | Transactions, catégories, abonnements, objectifs, `kairos_pay`, alertes de renouvellement |
| `supabase/budget.sql` | Revenus, charges fixes, enveloppes, analyse (`kairos_money_dash`, `kairos_plan`) |
| `supabase/nuits.sql` | Nuits, levers, cible progressive, `kairos_sleep`, rappels du soir, tableau de bord Nuits |
| `supabase/functions/kairos-push/index.ts` | Edge Function d'envoi des notifications Web Push |

**Ordre d'installation SQL :** `schema` → `rappels` → `argent` → `budget` → `nuits`. Chaque fichier peut être relancé sans risque. Supabase signale une « opération destructive » parce que certaines fonctions sont supprimées puis recréées : c'est normal.

**À chaque publication du front**, incrémenter ensemble `APP_VER` (dans `app.js`), `version.json` et `VERSION` (dans `sw.js`), puis lancer `publier.bat`.

## 3. Supabase : ce qu'il faut savoir

- **Sécurité :**
  - RLS est activé et tous les droits sont retirés sur les tables `kairos_*`.
  - Tout passe par des RPC `SECURITY DEFINER` :
    - celles de l'app vérifient `auth.uid()` ;
    - celles des raccourcis vérifient le jeton personnel `p_token` (`kairos_profiles.token`) ;
    - celles du cron vérifient le secret `kairos_secrets.cron`.
- **Secrets :** le secret cron et les clés VAPID sont **générés par le serveur** et stockés dans `kairos_secrets`. Ils ne figurent nulle part dans le code. Ne jamais les recopier dans un fichier.
- **Tâche planifiée :** `pg_cron` lance `kairos-rappels` chaque minute. Elle appelle `kairos-push` via `net.http_post`, mais seulement si `kairos_any_due()`, `kairos_any_sub_due()`, `kairos_any_bed_due()` ou `kairos_any_anchor_due()` est vrai.
- **Edge Function `kairos-push` :** l'option « Verify JWT » est désactivée et l'en-tête `x-kairos-cron` est obligatoire. Un appel avec le corps `{"test":true}` envoie une notification de test à tous les appareils.
- **safeupdate :** Supabase refuse les `DELETE` ou `UPDATE` sans `WHERE` passés par PostgREST. Dans les fonctions, utiliser des CTE avec une condition explicite.
- **Double authentification :** elle est activée sur le compte Supabase. Pour toute intervention dans le dashboard, l'utilisateur doit se reconnecter avec son code (application Authy).

### Fonctions RPC principales

| Appelée par | Fonction | Rôle |
|---|---|---|
| Raccourci Kairos | `kairos_log(p_token, p_app)` | `p_app` = « insta open », « lecture close »… Renvoie `message` et `ouvrir` (redirection vers Manga Pin) |
| Automatisation Wallet | `kairos_pay(p_token, p_amount, p_merchant)` | Enregistre la dépense et la catégorise. Renvoie `message` (alertes de budget et d'enveloppe) |
| Raccourci Kairos Nuit | `kairos_sleep(p_token, p_data, p_quiet)` | `p_data` = lignes « début\|fin\|valeur » (dates ISO 8601). `p_quiet` = pas de message s'il n'y a rien de nouveau |
| App | `kairos_dashboard`, `kairos_save_settings`, `kairos_money`, `kairos_money_dash`, `kairos_plan`, `kairos_nights_dash`, `kairos_nights_settings`, `kairos_wake_set` | Écrans et réglages |
| Cron → kairos-push | `kairos_due_reminders`, `kairos_due_sub_alerts`, `kairos_due_bed`, `kairos_due_anchor` | Notifications à envoyer (et marquage de l'envoi) |

## 4. Logique métier à connaître

- **Journée Kairos :** elle se termine à `day_end_hour` (5 h par défaut). Une soirée qui va jusqu'à 2 h compte donc pour la même journée.
- **Événements d'apps (`kairos_log`) :**
  - une fermeture qui arrive moins de 2,5 s après une ouverture est ignorée (fermeture « fantôme ») ;
  - ouvrir une app ferme l'autre si elle était encore ouverte ;
  - une ouverture manquante est reconstruite (le retour par swipe en bas de l'écran ne déclenche pas l'automatisation « Est ouverte ») ;
  - les doublons à 3 s près sont ignorés, et il y a au maximum 500 événements par 24 h.
- **Mode Ferme ou Doux :** quand le quota est dépassé, Ferme redirige vers Manga Pin et Doux envoie seulement une notification. Un avertissement arrive à 75 % du quota.
- **Rappels de scroll :** premier rappel après `remind_after_min`, puis toutes les `remind_every_min` minutes, tant que la dernière action Insta est une ouverture (45 min au maximum).
- **Nuits :**
  - Les heures du soir sont stockées en **minutes depuis 18:00** (`m18`) : 00:15 = 375, 02:15 = 495.
  - Une nuit est rattachée au **soir où elle commence** (début − 12 h).
  - **Levers :** 08:00 par défaut en semaine. Le week-end est libre (`wake_weekend_m` null). La table `kairos_wake` contient les exceptions jour par jour, et `wake_m` null signifie « jour libre ».
  - **La cible ne s'applique** que si un lever est prévu le lendemain (`kairos_night_applies`).
  - **Cible = heure d'endormissement** (comparée à celle mesurée par la montre). Le rappel « au lit » arrive à cible − **délai d'endormissement appris** (`kairos_latency`) : médiane, sur 3 semaines, de l'écart entre la dernière activité Insta/Manga Pin et l'endormissement. Bornée à 5–60 min, 15 min tant qu'il y a moins de 3 mesures.
  - **Palier progressif** (`kairos_bed_progress`) : il part de la médiane des 2 dernières semaines. Il avance de `bed_step_min` (15 min) si au moins 60 % des soirs sont tenus (marge 15 min) sur 7 jours, et le pas **double (30 min max) après 2 paliers réussis d'affilée** (`bed_streak`). Il **recule d'un pas** après une semaine à 0 soir tenu. Il s'arrête à `bed_final_m18` = lever de semaine − sommeil visé (**00:30**).
  - **Cible du soir** (`kairos_night_target`) : le palier, avancé si le réveil du lendemain est plus tôt que d'habitude, pour garder au moins 6 h 30 de sommeil.
  - **Consigne du soir** (`kairos_tonight_advice`) : ajoutée au message du matin et affichée dans la carte « Ce soir ». Selon la situation : réveil plus tôt, manque > 2 h sur 7 nuits (« au lit vers … pour récupérer »), progression du palier, soirée libre avec repère.
  - **Repère des jours libres** (`wake_anchor_m`, 10:00 par défaut) : « debout avant », sans alarme. La notification part à l'heure repère seulement s'il n'y a eu aucune activité Insta/Manga Pin depuis 5 h (`kairos_due_anchor`). Suivi dans Tendances.
  - **Conseil unique dans l'app** (`pickTip`, dans nights.js) : régularité du lever (si ±45 min ou plus en semaine), sinon Insta tard (si ça retarde l'endormissement de 20 min ou plus), sinon rien.
  - **Rappels du soir :** premier rappel `bed_remind_before` (30 min) avant l'heure « au lit », second à l'heure « au lit ». Ils indiquent le sommeil possible et signalent une cible avancée.
- **Argent :** la catégorie est devinée d'abord par les règles apprises (`kairos_merchant_rules`), sinon par mots-clés. L'alerte d'abonnement part à partir de 10 h, `notify_days` jours avant le renouvellement.

## 5. Côté iPhone (configuré par l'utilisateur)

- **Raccourci « Kairos »** + 4 automatisations d'app : Instagram et Manga Pin, chacune en « Est ouverte » et « Est fermée ». Dans chaque automatisation, désactiver **« Afficher pendant l'exécution »** et **« M'avertir lors de l'exécution »**, sinon une fermeture fantôme est envoyée et les bannières iOS s'accumulent.
- **Raccourci « Kairos Lire »** : ouvre Manga Pin. Il est lancé par le bouton « Lire maintenant ».
- **Automatisation Wallet (Crédit Agricole)** → `kairos_pay` avec Montant et Commerçant, puis `Si message` → notification.
- **Raccourci « Kairos Nuit »** :
  1. Rechercher des échantillons de santé (Sommeil, 7 derniers jours) ;
  2. Texte « Date de début ISO | Date de fin ISO | Valeur » ;
  3. Combiner avec des nouvelles lignes ;
  4. POST `kairos_sleep`.
  - Il faut activer **Réglages → Raccourcis → Avancé → Autoriser le partage de grandes quantités de données**.
- **Garmin → Santé** : Garmin Connect → Applications connectées → Apple Santé → Sommeil.
- **Notifications** : la PWA doit être ouverte depuis l'écran d'accueil. Activation dans Réglages → Notifications.

## 6. État actuel et points ouverts

- ✅ La base et la fonction `kairos-push` sont déployées (16/11). La version 1.5.1 du front est prête dans le dossier ; **vérifier qu'elle a bien été publiée** avec `publier.bat`.
- ⏳ **Synchro du sommeil :** l'automatisation « 11:00 » ne fonctionne pas, car **Santé est illisible quand l'iPhone est verrouillé**. Il est recommandé de déclencher Kairos Nuit à l'ouverture d'une app du matin (Instagram…), avec le champ Booléen `p_quiet` = Vrai et la notification placée dans un `Si`. À confirmer avec l'utilisateur.
- ⏳ **Automatisation Apple Pay :** vérifier les champs du corps de la requête et ajouter le `Si message` → notification.
- ℹ️ Le suivi Insta/lecture ne date que du 15/11. Le croisement soirées × sommeil (« Ce qui joue sur ton coucher ») a besoin d'une à deux semaines de données.
- ℹ️ Le dépôt GitHub est public. Le code ne contient aucun secret (vérifié). Si besoin, migration possible vers Cloudflare Pages depuis un dépôt privé.
- ✅ **Coach sommeil v2** déployé le 16/11 : cible ajustée au réveil, repère des jours libres, consigne du soir, palier adaptatif, conseil unique, délai d'endormissement appris.
- 🚫 **Décisions de l'utilisateur :**
  - pas de synchronisation bancaire ni de fonctions « façon Finary » ;
  - pas d'implémentation des améliorations proposées le 16/11 (réveil automatique, bilan du dimanche, liaison soirée/coucher, détection d'abonnements, module Mouvement, etc.).

## 7. Dépannage rapide

| Symptôme | Piste |
|---|---|
| Aucun rappel de scroll | `kairos_events` : fermeture 1 s après l'ouverture → l'option « Afficher pendant l'exécution » est encore active. Sinon vérifier `kairos_push_subs` et lancer un test avec `{"test":true}` |
| Réglages Nuits en erreur | Le front a été publié avant le SQL : relancer `nuits.sql` |
| « Jeton Kairos inconnu » | Le jeton a changé (Réglages → Raccourcis iPhone) : le recopier dans les raccourcis |
| Nuit absente | Garmin non synchronisée (tirer « Ma journée » vers le bas dans Garmin Connect), iPhone verrouillé, ou partage Santé désactivé |
| Notification vide | Il manque le `Si … possède n'importe quelle valeur` avant « Afficher la notification » |
| Dashboard Supabase inaccessible | Reconnexion avec double authentification |

### Requêtes utiles (SQL Editor)

```sql
-- Derniers événements d'apps
select app, kind, inferred, at at time zone 'Europe/Paris' from kairos_events order by at desc limit 20;
-- Nuits et cible
select night, bed_at at time zone 'Europe/Paris', wake_at at time zone 'Europe/Paris', asleep_min, target_m18 from kairos_nights order by night desc limit 10;
select kairos_hhmi(bed_target_m18) cible, kairos_hhmi(bed_final_m18) final, last_sleep_sync from kairos_profiles;
-- Réponses de la fonction d'envoi
select id, status_code, left(content::text, 120), created from net._http_response order by id desc limit 5;
-- Notification de test
select net.http_post(url := 'https://qhbrypojnamuhclaneem.supabase.co/functions/v1/kairos-push',
  headers := jsonb_build_object('Content-Type','application/json','x-kairos-cron',(select value from kairos_secrets where name='cron')),
  body := '{"test":true}'::jsonb);
```

### Tests locaux (environnement de développement)

- Postgres 16 avec un stub d'authentification (`auth.uid()` lu depuis `request.jwt.claim.sub`), où l'on charge les fichiers SQL hors tâche cron.
- Playwright sur `python3 -m http.server 8765`, avec des routes simulées pour `https://demo.supabase.co` et une session injectée dans `localStorage` (`kairos.session`).
