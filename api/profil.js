/**
 * /api/profil — profils, historique des diagnostics et suivi jour par jour.
 *
 *   POST    { token?, email, prenom, reponses, scores, profilPeau, suivi[], consentement }
 *             sans token  → crée le profil et renvoie { token }        (201)
 *             avec token  → met à jour, ajoute un diagnostic si besoin (204)
 *             e-mail déjà pris et pas de token → { existe: true }      (409)
 *   POST    { connexion: true, email }
 *             → 204 dans tous les cas ; si un profil existe ET que Brevo
 *               est configuré, envoie le lien de reconnexion par e-mail.
 *               La réponse ne révèle jamais si l'adresse est connue.
 *   GET     ?token=…      → profil + dernier diagnostic + suivi + scores précédents
 *   DELETE  ?token=…      → efface le profil et tout ce qui en dépend
 *
 * Variables d'environnement (Vercel → Settings → Environment Variables) :
 *   SUPABASE_URL                 https://xxxxxxxx.supabase.co
 *   SUPABASE_SERVICE_KEY         clé « service_role » de Supabase
 *                                (SUPABASE_SERVICE_ROLE_KEY et SUPABASE_SECRET_KEY acceptés)
 *   BREVO_API_KEY                clé API Brevo — requise pour la reconnexion par e-mail
 *   BREVO_EXPEDITEUR             adresse d'expéditeur validée dans Brevo
 *   BREVO_LIST_ID                facultatif (liste contacts)
 *   SITE_URL                     facultatif (défaut : https://skin-advisor-two.vercel.app)
 *
 * La clé service_role contourne la RLS : elle ne doit JAMAIS apparaître
 * dans index.html ni dans aucun fichier envoyé au navigateur.
 * Aucune dépendance npm : on parle à l'API REST de Supabase.
 */

const URL_SUPABASE =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_PROJECT_URL || "";

const CLE_SERVICE =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY || "";

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const UUID_OK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const texte = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/* Limite de débit, au mieux de ce que permet une fonction sans base dédiée :
   le compteur vit en mémoire et repart à zéro quand l'instance est recyclée.
   Assez pour casser un script naïf ; le pare-feu Vercel prendra le relais
   au passage au plan Pro. */
const CREATIONS = new Map();
function tropDeCreations(ip) {
  const maintenant = Date.now();
  const liste = (CREATIONS.get(ip) || []).filter(t => maintenant - t < 3600000);
  if (liste.length >= 10) return true;
  liste.push(maintenant);
  CREATIONS.set(ip, liste);
  if (CREATIONS.size > 5000) CREATIONS.clear();
  return false;
}

/* Même principe pour les demandes de lien de connexion : 6 par heure et
   par IP, et 3 par heure vers une même adresse — personne ne doit pouvoir
   inonder la boîte mail de quelqu'un d'autre. */
const CONNEXIONS = new Map();
function tropDeConnexions(cle, max) {
  const maintenant = Date.now();
  const liste = (CONNEXIONS.get(cle) || []).filter(t => maintenant - t < 3600000);
  if (liste.length >= max) return true;
  liste.push(maintenant);
  CONNEXIONS.set(cle, liste);
  if (CONNEXIONS.size > 5000) CONNEXIONS.clear();
  return false;
}

/* Appel générique à PostgREST. Renvoie le JSON, ou lève. */
async function sb(chemin, options = {}) {
  const rep = await fetch(URL_SUPABASE + "/rest/v1/" + chemin, {
    ...options,
    headers: {
      apikey: CLE_SERVICE,
      authorization: "Bearer " + CLE_SERVICE,
      "content-type": "application/json",
      ...options.headers
    }
  });
  if (!rep.ok) {
    const detail = await rep.text();
    const e = new Error("Supabase " + rep.status + " " + detail);
    e.statut = rep.status;
    throw e;
  }
  if (rep.status === 204) return null;
  const brut = await rep.text();
  return brut ? JSON.parse(brut) : null;
}

/* L'IP ne sert qu'à prouver le consentement. Purgée au bout d'un an
   par la fonction purger_ip_anciennes(). */
function ipDe(req) {
  const t = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "";
  return String(t).split(",")[0].trim().slice(0, 45) || null;
}

async function versBrevo(email, prenom, profilPeau) {
  if (!process.env.BREVO_API_KEY) return;
  try {
    const rep = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        email,
        attributes: { PRENOM: prenom || "", PROFIL_PEAU: profilPeau || "" },
        listIds: process.env.BREVO_LIST_ID ? [Number(process.env.BREVO_LIST_ID)] : undefined,
        updateEnabled: true
      })
    });
    if (!rep.ok && rep.status !== 400) console.error("[profil] Brevo", rep.status, await rep.text());
  } catch (e) {
    console.error("[profil] Brevo", e);
  }
}

/* Lien de reconnexion : envoyé par Brevo (e-mail transactionnel).
   Sans BREVO_API_KEY, on journalise et on se tait — la réponse HTTP
   reste 204 pour ne rien révéler. */
async function envoyerLienConnexion(email, prenom, token) {
  if (!process.env.BREVO_API_KEY) {
    console.error("[profil] BREVO_API_KEY absente — lien de connexion non envoyé");
    return;
  }
  const site = (process.env.SITE_URL || "https://skin-advisor-two.vercel.app").replace(/\/+$/, "");
  const lien = site + "/?p=" + token;
  const nom = String(prenom || "").replace(/[<>&"]/g, "").trim();
  const rep = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      sender: {
        name: "SkinAdvisor",
        email: process.env.BREVO_EXPEDITEUR || "no-reply@skinadvisor.example"
      },
      to: [{ email }],
      subject: "Votre lien de connexion SkinAdvisor",
      htmlContent:
        "<p>Bonjour" + (nom ? " " + nom : "") + ",</p>" +
        "<p>Voici votre lien pour retrouver votre routine et votre suivi sur cet appareil :</p>" +
        '<p><a href="' + lien + '">Reprendre mon suivi</a></p>' +
        "<p style=\"color:#6B573F;font-size:13px\">Ce lien est personnel : ne le partagez pas. " +
        "Si vous n'êtes pas à l'origine de cette demande, ignorez simplement ce message.</p>" +
        "<p>— SkinAdvisor</p>"
    })
  });
  if (!rep.ok) console.error("[profil] Brevo connexion", rep.status, await rep.text());
}

/* Le nom de famille et l'e-mail n'ont rien à faire dans le JSON des réponses :
   une donnée, une colonne. */
function reponsesPropres(v) {
  const r = { ...(v && typeof v === "object" ? v : {}) };
  delete r.nom;
  delete r.email;
  return r;
}

/* Postgres ne conserve pas l'ordre des clés d'un jsonb : comparer deux
   JSON.stringify donnerait toujours « différent », et l'historique se
   remplirait à chaque synchronisation. On compare donc clé par clé. */
function memesScores(a, b) {
  const A = a && typeof a === "object" ? a : {};
  const B = b && typeof b === "object" ? b : {};
  const ka = Object.keys(A).sort(), kb = Object.keys(B).sort();
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && Number(A[k]) === Number(B[k]));
}

/* Un nouveau diagnostic n'est enregistré que si les scores ont bougé :
   sinon chaque synchronisation gonflerait l'historique pour rien. */
async function ajouterDiagnosticSiNouveau(profilId, reponses, scores, profilPeau) {
  const derniers = await sb(
    "diagnostics?profil_id=eq." + profilId + "&select=scores&order=cree_le.desc&limit=1"
  );
  if (derniers && derniers[0] && memesScores(derniers[0].scores, scores)) return false;
  await sb("diagnostics", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ profil_id: profilId, reponses, scores, profil_peau: profilPeau })
  });
  return true;
}

/* Le suivi arrive en entier à chaque synchronisation : on remplace. */
async function enregistrerSuivi(profilId, suivi) {
  if (!Array.isArray(suivi) || !suivi.length) return;
  const lignes = suivi
    .filter(s => Number.isInteger(s.jour) && s.jour >= 1 && s.jour <= 56)
    .slice(0, 56)
    .map(s => ({
      profil_id: profilId,
      jour: s.jour,
      fait: s.fait === true,
      etat: texte(s.etat, 20) || null,
      note: texte(s.note, 600) || null
    }));
  if (!lignes.length) return;
  await sb("suivi_etapes?on_conflict=profil_id,jour", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(lignes)
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!URL_SUPABASE || !CLE_SERVICE) {
    console.error("[profil] SUPABASE_URL ou SUPABASE_SERVICE_KEY manquante");
    return res.status(503).json({ erreur: "Le service d'enregistrement n'est pas configuré" });
  }

  try {
    /* ------------------------------------------------ POST */
    if (req.method === "POST") {
      const c = req.body || {};

      /* --- Reconnexion par e-mail : réponse neutre, toujours 204.
         Que l'adresse existe ou non, la réponse est identique — seul
         le titulaire de la boîte mail saura si un compte existe. */
      if (c.connexion === true) {
        const adresse = texte(c.email, 120).toLowerCase();
        if (!EMAIL_OK.test(adresse)) return res.status(400).json({ erreur: "Adresse e-mail invalide" });
        if (texte(c.web, 200)) return res.status(204).end(); // pot de miel
        const ip = ipDe(req) || "inconnue";
        if (tropDeConnexions("ip:" + ip, 6) || tropDeConnexions("mail:" + adresse, 3)) {
          return res.status(429).json({ erreur: "Trop de tentatives — réessayez dans une heure" });
        }
        try {
          const trouves = await sb(
            "profils?email=eq." + encodeURIComponent(adresse) + "&select=token,prenom"
          );
          if (trouves && trouves.length) {
            await envoyerLienConnexion(adresse, trouves[0].prenom, trouves[0].token);
          }
        } catch (e) {
          console.error("[profil] connexion", e.message || e);
        }
        return res.status(204).end();
      }

      const email = texte(c.email, 120).toLowerCase();
      const token = texte(c.token, 40);
      const prenom = texte(c.prenom, 60) || null;
      const profilPeau = texte(c.profilPeau, 20) || null;
      const reponses = reponsesPropres(c.reponses);
      const scores = c.scores && typeof c.scores === "object" ? c.scores : {};

      if (!EMAIL_OK.test(email)) return res.status(400).json({ erreur: "Adresse e-mail invalide" });
      if (c.consentement !== true) return res.status(400).json({ erreur: "Consentement requis" });
      if (token && !UUID_OK.test(token)) return res.status(400).json({ erreur: "Jeton invalide" });

      // Champ piège : un humain ne le voit pas, un robot le remplit.
      // On répond comme si tout allait bien, sans rien écrire nulle part.
      if (texte(c.web, 200)) {
        return token ? res.status(204).end()
                     : res.status(201).json({ token: crypto.randomUUID() });
      }

      // Garde-fou sur la taille des réponses : personne n'a un questionnaire de 20 Ko.
      if (JSON.stringify(reponses).length > 20000) {
        return res.status(400).json({ erreur: "Réponses trop volumineuses" });
      }

      // --- Profil déjà connu de cet appareil
      if (token) {
        const trouve = await sb("profils?token=eq." + token + "&select=id,email");
        if (trouve && trouve.length) {
          const id = trouve[0].id;
          await sb("profils?id=eq." + id, {
            method: "PATCH",
            headers: { prefer: "return=minimal" },
            body: JSON.stringify({ prenom })
          });
          await ajouterDiagnosticSiNouveau(id, reponses, scores, profilPeau);
          await enregistrerSuivi(id, c.suivi);
          return res.status(204).end();
        }
        // Jeton inconnu (profil effacé) : on repart sur une création.
      }

      // --- Première activation depuis cet appareil
      if (tropDeCreations(ipDe(req) || "inconnue")) {
        return res.status(429).json({ erreur: "Trop de tentatives — réessayez dans une heure" });
      }

      const dejaLa = await sb("profils?email=eq." + encodeURIComponent(email) + "&select=id");
      if (dejaLa && dejaLa.length) {
        // On ne renvoie surtout PAS le jeton du profil existant : il suffirait
        // de taper l'adresse de quelqu'un pour accéder à son suivi.
        return res.status(409).json({ existe: true });
      }

      const cree = await sb("profils", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({
          email,
          prenom,
          consentement: true,
          consentement_date: new Date().toISOString(),
          consentement_ip: ipDe(req)
        })
      });
      const profil = cree && cree[0];
      if (!profil) return res.status(502).json({ erreur: "L'enregistrement a échoué" });

      await ajouterDiagnosticSiNouveau(profil.id, reponses, scores, profilPeau);
      await enregistrerSuivi(profil.id, c.suivi);
      await versBrevo(email, prenom, profilPeau);

      return res.status(201).json({ token: profil.token });
    }

    /* ------------------------------------------------- GET */
    if (req.method === "GET") {
      const token = texte(req.query && req.query.token, 40);
      if (!UUID_OK.test(token)) return res.status(400).json({ erreur: "Jeton invalide" });

      const profils = await sb("profils?token=eq." + token + "&select=id,email,prenom");
      if (!profils || !profils.length) return res.status(404).json({ erreur: "Profil introuvable" });
      const p = profils[0];

      const diags = await sb(
        "diagnostics?profil_id=eq." + p.id +
        "&select=reponses,scores,profil_peau,cree_le&order=cree_le.desc&limit=2"
      );
      if (!diags || !diags.length) return res.status(404).json({ erreur: "Aucun diagnostic" });

      const suivi = await sb(
        "suivi_etapes?profil_id=eq." + p.id + "&select=jour,fait,etat,note&order=jour.asc"
      );

      return res.status(200).json({
        email: p.email,
        prenom: p.prenom || "",
        reponses: diags[0].reponses || {},
        scores: diags[0].scores || {},
        profilPeau: diags[0].profil_peau || "",
        demarreLe: Date.parse(diags[0].cree_le),
        // Diagnostic précédent : c'est lui qui alimente le bilan avant/après.
        avant: diags[1]
          ? { scores: diags[1].scores || {}, date: Date.parse(diags[1].cree_le) }
          : null,
        suivi: suivi || []
      });
    }

    /* ---------------------------------------------- DELETE */
    if (req.method === "DELETE") {
      const token = texte(req.query && req.query.token, 40);
      if (!UUID_OK.test(token)) return res.status(400).json({ erreur: "Jeton invalide" });
      // Les diagnostics et le suivi partent en cascade (on delete cascade).
      await sb("profils?token=eq." + token, {
        method: "DELETE",
        headers: { prefer: "return=minimal" }
      });
      return res.status(204).end();
    }
  } catch (e) {
    console.error("[profil]", e.message || e);
    return res.status(502).json({ erreur: "Le service d'enregistrement n'a pas répondu" });
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ erreur: "Méthode non autorisée" });
}
