/**
 * /api/profil — profils, historique des diagnostics et suivi jour par jour.
 * Variables d'environnement : SUPABASE_URL, SUPABASE_SERVICE_KEY.
 * La clé service_role ne doit JAMAIS apparaître dans index.html.
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

function reponsesPropres(v) {
  const r = { ...(v && typeof v === "object" ? v : {}) };
  delete r.nom;
  delete r.email;
  return r;
}

async function ajouterDiagnosticSiNouveau(profilId, reponses, scores, profilPeau) {
  const derniers = await sb(
    "diagnostics?profil_id=eq." + profilId + "&select=scores&order=cree_le.desc&limit=1"
  );
  const avant = derniers && derniers[0] ? JSON.stringify(derniers[0].scores) : null;
  if (avant === JSON.stringify(scores)) return false;
  await sb("diagnostics", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ profil_id: profilId, reponses, scores, profil_peau: profilPeau })
  });
  return true;
}

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
    if (req.method === "POST") {
      const c = req.body || {};
      const email = texte(c.email, 120).toLowerCase();
      const token = texte(c.token, 40);
      const prenom = texte(c.prenom, 60) || null;
      const profilPeau = texte(c.profilPeau, 20) || null;
      const reponses = reponsesPropres(c.reponses);
      const scores = c.scores && typeof c.scores === "object" ? c.scores : {};

      if (!EMAIL_OK.test(email)) return res.status(400).json({ erreur: "Adresse e-mail invalide" });
      if (c.consentement !== true) return res.status(400).json({ erreur: "Consentement requis" });
      if (token && !UUID_OK.test(token)) return res.status(400).json({ erreur: "Jeton invalide" });

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
        avant: diags[1]
          ? { scores: diags[1].scores || {}, date: Date.parse(diags[1].cree_le) }
          : null,
        suivi: suivi || []
      });
    }

    if (req.method === "DELETE") {
      const token = texte(req.query && req.query.token, 40);
      if (!UUID_OK.test(token)) return res.status(400).json({ erreur: "Jeton invalide" });
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
