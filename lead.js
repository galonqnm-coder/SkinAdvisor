/**
 * POST /api/lead
 * Reçoit l'adresse laissée pour activer le suivi sur huit semaines.
 *
 * Variables d'environnement (Vercel → Settings → Environment Variables) :
 *   BREVO_API_KEY   clé API Brevo (facultatif — sans elle, l'adresse est seulement journalisée)
 *   BREVO_LIST_ID   identifiant de la liste Brevo (facultatif)
 *
 * Rien de sensible ne doit vivre dans le fichier du site : tout passe par ici.
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ erreur: "Méthode non autorisée" });
  }

  const { email, prenom = "", profil = "" } = req.body || {};

  if (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    return res.status(400).json({ erreur: "Adresse e-mail invalide" });
  }

  const contact = {
    email: email.trim().toLowerCase(),
    prenom: String(prenom).slice(0, 60),
    profil: String(profil).slice(0, 30),
    source: "skinadvisor",
    date: new Date().toISOString()
  };

  // Sans clé Brevo, on se contente de journaliser : le site continue de fonctionner.
  if (!process.env.BREVO_API_KEY) {
    console.log("[lead]", contact);
    return res.status(204).end();
  }

  try {
    const reponse = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        email: contact.email,
        attributes: { PRENOM: contact.prenom, PROFIL_PEAU: contact.profil },
        listIds: process.env.BREVO_LIST_ID ? [Number(process.env.BREVO_LIST_ID)] : undefined,
        updateEnabled: true
      })
    });

    // 201 = créé, 204 = mis à jour, 400 avec duplicate_parameter = déjà inscrit : tous acceptables.
    if (!reponse.ok && reponse.status !== 400) {
      const detail = await reponse.text();
      console.error("[lead] Brevo", reponse.status, detail);
      return res.status(502).json({ erreur: "Le service d'envoi n'a pas répondu" });
    }
    return res.status(204).end();
  } catch (e) {
    console.error("[lead]", e);
    return res.status(502).json({ erreur: "Le service d'envoi n'a pas répondu" });
  }
}
