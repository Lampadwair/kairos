# Kairos : mise en route

Kairos est une web app installable sur iPhone. Elle compte tes minutes **Insta** et **lecture** (Manga Pin) grâce aux automatisations de l'app Raccourcis. Elle applique ton **quota Insta** (une notification douce, ou une redirection vers Manga Pin) et tient ta **série de lecture**.

Premier module : **Soirée choisie**. Les modules **Argent** et **Nuits** viendront ensuite dans la même app.

Compte 20 à 30 minutes, une seule fois.

> **Ton installation (14/11/2026)** : la base est dans le projet Supabase **elan** (partagé avec Hepha). Les inscriptions y sont fermées, donc tu te connectes avec ton compte Hepha. L'app est en ligne sur https://lampadwair.github.io/kairos/. Les étapes 1 et 2 ci-dessous sont déjà faites : il reste l'étape 3 (iPhone) et l'étape 4 (Raccourcis).

---

## 1. Base de données Supabase

Tu as deux options :

- **Nouveau projet** `kairos` sur https://supabase.com (région Europe). Attention : l'offre gratuite limite le nombre de projets actifs. Si tu as déjà Bidou et Hepha, prends plutôt l'autre option.
- **Projet existant** (Hepha, par exemple). Tout ce que crée Kairos commence par `kairos_`, donc rien ne se mélange avec le reste. Les comptes, eux, sont partagés : tu te connectes à Kairos avec le même e-mail.

Ensuite :

1. Ouvre **SQL Editor**, colle tout le contenu de `supabase/schema.sql`, puis **Run**. Le script crée les tables et les fonctions, avec des règles qui font que chacun ne voit que ses propres données. Tu peux le relancer sans risque.
2. **Authentication → URL Configuration** : ajoute `https://lampadwair.github.io/kairos/` dans les **Redirect URLs**. Si c'est un nouveau projet, mets aussi cette adresse en **Site URL**.
3. Laisse **Confirm email** activé (**Authentication → Sign In / Providers → Email**).
4. Copie l'**URL du projet** (`https://xxxx.supabase.co`) et la clé **Publishable** (`sb_publishable_…`, dans **Project Settings → API Keys**), puis colle-les dans `config.js`.

## 2. Mise en ligne avec GitHub Pages

1. Sur GitHub, crée un dépôt **public** nommé `kairos`. Il ne contiendra que le code, jamais tes données.
2. Double-clique sur `publier.bat`. Le script initialise le dépôt et pousse le code.
3. Sur GitHub, va dans **Settings → Pages → Deploy from a branch**, choisis `main` et `/ (root)`, puis **Save**.
4. Une à deux minutes plus tard, l'app est en ligne sur `https://lampadwair.github.io/kairos/`.

## 3. Installation sur l'iPhone

1. Ouvre l'adresse dans **Safari**, touche **Partager**, puis **Sur l'écran d'accueil**.
2. Ouvre Kairos depuis l'icône et crée ton compte (ou connecte-toi). Confirme ton e-mail si on te le demande.

## 4. Raccourcis iPhone (le cœur du système)

Le guide détaillé est **dans l'app**, onglet **Réglages → Raccourcis iPhone**. Il a des boutons « Copier » pour l'URL, la clé et ton jeton : suis-le directement sur l'iPhone. En résumé :

| À créer | Rôle |
|---|---|
| Raccourci **Kairos** | Reçoit `insta open`, `insta close`, `lecture open` ou `lecture close`, l'envoie à Supabase, puis affiche le message renvoyé et ouvre Manga Pin si le quota est dépassé en mode Ferme |
| 4 automatisations **App** | Instagram ouverte / fermée, Manga Pin ouverte / fermée. Chacune lance **Kairos** avec le bon texte, en mode « Exécuter immédiatement » |
| Raccourci **Kairos Lire** (facultatif) | Ouvre Manga Pin. C'est lui que lance le bouton « Lire maintenant » |

Ce que renvoie le serveur à chaque signal :

| Situation | `action` | Ce que fait le raccourci |
|---|---|---|
| Insta ouvert, 75 % du quota passés | `warn` | Notification « Encore X min » |
| Insta ouvert, quota dépassé, mode Doux | `nudge` | Notification « Un chapitre plutôt ? » |
| Insta ouvert, quota dépassé, mode Ferme | `redirect` | Notification et ouverture de Manga Pin |
| Manga Pin fermé, objectif lecture atteint (une fois par journée) | `celebrate` | Notification avec ta série 🔥 |
| Le reste | `none` | Rien |

**Bon à savoir**

- La « journée » Kairos se termine à **5 h** (réglable). Ta soirée jusqu'à 2 h compte donc bien dans la même journée.
- Une session dont la fermeture n'a pas été vue (téléphone verrouillé directement dans l'app, par exemple) est plafonnée à 45 minutes. Si une autre ouverture arrive entre-temps, elle est plafonnée à 10 minutes.
- Le raccourci agit **à l'ouverture** d'Insta : il ne coupe pas une session en cours. Pour un blocage strict, ajoute en plus une limite dans **Réglages iPhone → Temps d'écran → Limites d'app**.
- Si tu changes de jeton dans l'app, recolle-le dans le raccourci Kairos.

## 5. Ta Vivoactive 6, dès ce soir

Pas besoin de code pour ces réglages :

1. **Réveil Smart Wake** : sur la montre, **Horloges → Alarmes → nouvelle alarme**, puis active **Smart Wake**. La montre vibre pendant une phase de sommeil léger, jusqu'à 30 minutes avant l'heure choisie. C'est plus doux que la sonnerie de l'iPhone.
2. **Rapport du matin** : il résume ton sommeil, ta récupération et ton agenda au réveil. Tu peux personnaliser les infos affichées dans les réglages de la montre ou dans Garmin Connect.
3. **Notifications** : dans Garmin Connect, ouvre les réglages de ta Vivoactive 6 et active les **notifications intelligentes**. Sur iPhone, la montre relaie les apps dont les notifications sont autorisées dans iOS : coupe celles qui ne doivent pas vibrer et garde l'essentiel (Discord, Messages, Calendrier…).
4. **Préparer le module Nuits** : dans **Santé → profil → Apps et services → Garmin Connect**, active **Sommeil**. Kairos pourra alors croiser tes soirées avec tes nuits.
5. **Pour Hepha** : la montre a des profils d'activité HIIT et renforcement. Tu peux y lancer tes Tabata au poignet.

## Rappels pendant le scroll (notifications)

Quand Insta reste ouvert longtemps (10 min par défaut), Kairos t'envoie une notification, puis une nouvelle toutes les 5 min. La toucher ouvre un écran avec trois choix : « Lire un chapitre », « Encore 5 min » ou « Plus de rappels ce soir ».

- **Activer** : ouvre Kairos depuis son icône sur l'écran d'accueil, puis **Réglages → Rappels pendant le scroll → Activer les notifications**. iOS l'exige : depuis Safari, ça ne marche pas.
- **Côté serveur** (déjà en place) : `supabase/rappels.sql` crée les tables et une tâche planifiée qui tourne chaque minute. La fonction `supabase/functions/kairos-push` envoie les notifications.
- **Aucun secret à gérer** : la base tire elle-même son secret, et la fonction crée les clés de notification au premier lancement. Le tout est rangé dans la table `kairos_secrets`, invisible depuis l'extérieur.

## Module Argent

- **Paiements Apple Pay automatiques :** une automatisation **Wallet** (« Transaction » sur les anciens iOS) envoie le montant et le commerçant à `kairos_pay`. Le guide pas à pas est dans l'app, sous **Réglages → Argent**.
- **Catégories :** elles sont devinées d'après le nom du commerçant. Quand tu en corriges une en cochant « Toujours classer… », Kairos s'en souvient pour ce commerçant.
- **Paiements par carte physique ou en ligne :** ajoute-les à la main avec « + Ajouter une dépense ».
- **Abonnements :** tu reçois une notification avant chaque renouvellement (3 jours avant par défaut, à partir de 10 h). Il faut que les notifications Kairos soient activées.
- **Budget (vue Budget) :** tu pars de tes revenus, tu retires tes charges fixes (abonnements compris) et l'épargne visée, et tu obtiens ton reste à vivre. Tu le répartis ensuite en enveloppes par catégorie, avec une proposition calculée sur tes 3 derniers mois. Tu reçois une alerte quand une enveloppe atteint 80 % puis 100 %.
- **Analyse (vue Analyse) :** rythme du mois face au budget avec projection de fin de mois, 6 derniers mois, top commerçants, habitudes (jours, moments, dépenses du soir).
- **Côté serveur :** tout est créé par `supabase/argent.sql` puis `supabase/budget.sql`, tous deux déjà exécutés.

## Sécurité

- **Public, et c'est normal** : le code, l'URL Supabase et la clé « publishable ».
- **Ce qui protège tes données** : les règles de `schema.sql`. Personne ne peut lire les tables directement. Les fonctions ne renvoient que les données de la personne connectée.
- **Le jeton des raccourcis** ne permet qu'une chose : ajouter des signaux ouvert/fermé à ton compte. Il ne permet ni de lire ni d'effacer tes données. Tu peux en changer à tout moment dans l'app. Le serveur ignore les doublons et plafonne à 500 signaux par 24 h.
- **Ne publie jamais** le mot de passe de la base ni la clé `service_role` / « secret ».
- Active la **double authentification** sur GitHub et sur Supabase.

## Mettre à jour

Quand tu modifies l'app, change le numéro de version à trois endroits (`APP_VER` dans `app.js`, `VERSION` dans `sw.js` et `version.json`), puis double-clique sur `publier.bat`.
