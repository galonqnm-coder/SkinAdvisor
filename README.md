# SkinAdvisor — mise en ligne sur GitHub + Vercel

## Structure du dépôt

```
/
├── index.html               ← le site (skinadvisor-site.html renommé)
├── sw.js                    ← mode hors ligne
├── manifest.webmanifest     ← installation sur écran d'accueil
├── vercel.json              ← en-têtes de cache et de sécurité
├── .gitignore
├── api/
│   └── lead.js              ← première fonction back-end (capture d'e-mail)
└── photos/                  ← facultatif : vos photos produits
```

## Mise en ligne, étape par étape

1. **Renommez** `skinadvisor-site.html` en `index.html`.
2. **Créez le dépôt GitHub** et poussez ces fichiers.
3. Sur **vercel.com** → *Add New Project* → importez le dépôt.
   - Framework Preset : **Other**
   - Build Command : *(vide)*
   - Output Directory : *(vide, la racine)*
4. **Déployez.** Le site est en ligne en HTTPS, ce qui active le mode hors ligne et l'installation sur mobile.
5. **Domaine** : *Settings → Domains*. Vercel gère le certificat automatiquement.

## Brancher la capture d'e-mail

Dans `index.html`, bloc `CONFIG` en tête de fichier :

```js
email: { actif: true, endpoint: "/api/lead" }
```

Puis, dans Vercel → *Settings → Environment Variables*, ajoutez `BREVO_API_KEY` (et `BREVO_LIST_ID` si vous utilisez une liste). Sans ces variables, la fonction accepte quand même les adresses et les journalise : rien ne casse.

## Métadonnées de partage

Dans `<head>`, complétez les deux lignes commentées avec votre domaine réel :

```html
<meta property="og:url" content="https://votre-domaine.fr/">
<meta property="og:image" content="https://votre-domaine.fr/partage.jpg">
```

L'image doit faire 1200 × 630 px et être déposée à la racine.

## Attention au plan Vercel

Le plan **Hobby est réservé à un usage personnel non commercial**. Dès que le site vend ou renvoie vers des liens rémunérés, il faut passer au plan **Pro** (20 $ par mois et par utilisateur).

## La suite du back-end

- `api/commande.js` — création d'une session de paiement Stripe
- `api/relance.js` + Vercel Cron — rappels aux semaines 2, 4 et 8
- Stockage des profils : Vercel Postgres ou Supabase, quand les comptes clients arriveront
