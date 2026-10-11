/* Zone des parties d'une conversation privée : quelles parties afficher.
   Les parties sont reconstituées depuis tout l'historique du fil : sans tri, chaque partie jamais jouée resterait affichée pour toujours.
   Règles : une partie en attente ou en cours est toujours visible (on y joue, ou on peut l'abandonner). Quand il n'y en a aucune, la dernière
   partie terminée reste visible pour voir le résultat ; sinon, et pour toutes les autres, les parties terminées sont rangées dans
   « Anciennes parties ». Fermer la dernière partie terminée ne fait pas remonter les précédentes. Une partie fermée ne revient plus. */

export const MAX_FERMEES = 200;  // parties fermées retenues par contact (les plus anciennes sont oubliées)

export const estActive = (g) => g.etat === "attente" || g.etat === "en_cours";

/* parties : la liste de deriverPrive (la plus récente d'abord) ; fermees : identifiants fermés (tableau ou Set) ;
   toutVoir : afficher aussi les anciennes parties terminées.
   Rend { liste (ordre conservé), actives, finies (terminées non fermées), cachees (terminées non affichées) }. */
export function partiesVisibles(parties, fermees = [], toutVoir = false) {
  const fermeesSet = fermees instanceof Set ? fermees : new Set(fermees);
  const finies = parties.filter((g) => !estActive(g) && !fermeesSet.has(g.n));
  const actives = parties.filter(estActive).length;
  const derniere = parties.find((g) => !estActive(g));  // la plus récente des parties terminées, fermée ou non
  const dernierResultat = !actives && derniere && !fermeesSet.has(derniere.n) ? [derniere] : [];
  const montrees = new Set(toutVoir ? finies : dernierResultat);
  return {
    liste: parties.filter((g) => estActive(g) || montrees.has(g)),
    actives,
    finies: finies.length,
    cachees: finies.length - montrees.size,
  };
}

/* Ajoute des identifiants à la liste des parties fermées (sans doublon, bornée à MAX_FERMEES). Une partie en cours ne se ferme pas :
   elle se termine par « Abandonner » ou « Annuler le défi ». */
export function ajouterFermees(fermees, ids, parties = []) {
  const actives = new Set(parties.filter(estActive).map((g) => g.n));
  const suite = [...fermees];
  for (const id of ids) if (typeof id === "string" && !actives.has(id) && !suite.includes(id)) suite.push(id);
  return suite.slice(-MAX_FERMEES);
}
