import { verifierEngagement } from "../engagement.js";
import { DELAI_FORFAIT, adversaire, enregistrerJeu, joueurDe, terminer } from "./cadre.js";

export { DELAI_FORFAIT };

export const COUPS_PFC = { p: { nom: "Pierre", icone: "✊", bat: "c" }, f: { nom: "Feuille", icone: "✋", bat: "p" }, c: { nom: "Ciseaux", icone: "✌️", bat: "f" } };
export const MANCHES_GAGNANTES = 2;   // première à 2 manches (égalités rejouées)
export const MANCHES_MAX = 10;

/* Contexte de l'engagement d'un coup : partie, manche, côté. Le côté lie l'empreinte à son auteur : l'empreinte d'Alice republiée par Bob
   ne se révèle pas comme la sienne (sinon il rejouerait son coup et son sel pour faire « nul » à chaque fois). */
export const champsEngagementPfc = (partie, manche, cote) => [partie, manche, cote];

/* Forfait (salon seulement). Heure du relais à partir de laquelle l'adversaire de « moi » est en retard, ou null s'il ne l'est pas :
   - j'ai révélé et l'autre, engagé aussi, n'a pas révélé : le délai court depuis le dernier des deux engagements ;
   - je me suis engagé et l'autre ne s'est pas engagé : le délai court depuis mon engagement.
   Celui qui réclame doit avoir joué sa part (engagé, ou révélé quand les deux sont engagés). Sans heure de relais (parties privées, vieux
   relais), il n'y a pas de forfait possible. L'heure du forfait vient du relais, pas du client : on ne peut pas la tricher. */
export function departForfait(g, moi) {
  const ronde = g.rondes && g.rondes[g.manche];
  if (!ronde || g.etat !== "en_cours") return null;
  const moiCote = ronde[moi];
  const autreCote = ronde[adversaire(moi)];
  if (!moiCote || !autreCote || autreCote.m || !moiCote.h || typeof moiCote.te !== "number") return null;
  if (!autreCote.h) return moiCote.te;
  if (!moiCote.m || typeof autreCote.te !== "number") return null;
  return Math.max(moiCote.te, autreCote.te);
}

/* Pierre-feuille-ciseaux avec engagement. Par manche : chacun publie l'empreinte de son coup (« engage »), puis, quand les deux
   empreintes sont là, chacun révèle coup et sel (« revele »). Chaque révélation est vérifiée contre l'empreinte : on ne peut pas
   changer de coup après avoir vu celui de l'autre. Une révélation qui ne correspond pas fait perdre la partie. */
function appliquerPfc(g, ev) {
  if (g.etat !== "en_cours" || ev.r !== g.manche) return;
  const moi = joueurDe(g, ev.de);
  if (!moi) return;
  const ronde = g.rondes[g.manche] || (g.rondes[g.manche] = { x: {}, o: {} });
  const cote = ronde[moi];
  const autre = adversaire(moi);
  if (ev.a === "engage") {
    if (!cote.h) {  // un seul engagement par manche : on ne peut pas en publier un second après coup
      cote.h = ev.h;
      if (typeof ev.t === "number") cote.te = ev.t;  // heure du relais : point de départ du délai de l'adversaire
    }
    return;
  }
  if (ev.a === "forfait") {
    const depart = departForfait(g, moi);
    if (depart !== null && typeof ev.t === "number" && ev.t - depart >= DELAI_FORFAIT) terminer(g, moi, "forfait");
    return;
  }
  if (ev.a === "revele") {
    if (!cote.h || !ronde[autre].h || cote.m) return;  // pas d'engagement, ou l'autre ne s'est pas encore engagé, ou déjà révélé
    if (!verifierEngagement(cote.h, [...champsEngagementPfc(g.n, g.manche, moi), ev.m], ev.x)) {
      cote.triche = true;
      terminer(g, autre, "triche");  // la révélation ne correspond pas à l'engagement
      return;
    }
    cote.m = ev.m;
    cote.x = ev.x;
    if (!ronde[autre].m) return;
    const mx = ronde.x.m;
    const mo = ronde.o.m;
    const gagnantManche = mx === mo ? "nul" : COUPS_PFC[mx].bat === mo ? "x" : "o";
    ronde.gagnant = gagnantManche;
    g.manches.push({ manche: g.manche, x: mx, o: mo, gagnant: gagnantManche });
    if (gagnantManche !== "nul") g.points[gagnantManche] += 1;
    if (g.points.x >= MANCHES_GAGNANTES || g.points.o >= MANCHES_GAGNANTES) terminer(g, g.points.x > g.points.o ? "x" : "o");
    else if (g.manche + 1 >= MANCHES_MAX) terminer(g, "nul");
    else g.manche += 1;
  }
}

enregistrerJeu({
  id: "pfc",
  nom: "Pierre-feuille-ciseaux",
  icone: "✊",
  etatInitial: () => ({ manche: 0, points: { x: 0, o: 0 }, manches: [], rondes: {} }),
  actions: ["engage", "revele", "forfait"],
  appliquer: appliquerPfc,
  ordrePrive: (e) => (e.a === "engage" ? 10 + 10 * e.r : e.a === "revele" ? 15 + 10 * e.r : 10000),  // engagements avant révélations, manche par manche
  forfait: true,
});
