import { verifierEngagement } from "../engagement.js";
import { DELAI_FORFAIT, adversaire, enregistrerJeu, joueurDe, terminer } from "./cadre.js";

/* Bataille navale avec flotte engagée.
   Grille 8 x 8 (64 cases, numérotées ligne par ligne), cinq navires : a (4 cases), b (3), c (3), d (2), e (2) = 14 cases.
   Une flotte s'écrit en 64 caractères : « . » pour l'eau, la lettre du navire sur chacune de ses cases.

   Déroulement (la crypto est le jeu : personne ne peut changer sa flotte en cours de partie, ni mentir sans être démasqué) :
   1. placement : chacun publie l'empreinte SHA-256 de « partie | côté | flotte | sel » (voir engagement.js) ; la flotte reste dans son navigateur ;
   2. tirs : à tour de rôle, on tire sur une case ; le défenseur répond « touché (lettre du navire) » ou « à l'eau », calculé depuis sa flotte secrète ;
   3. quand toutes les cases d'une flotte sont annoncées touchées : vérification : les deux révèlent flotte et sel. Chaque révélation doit
      correspondre à l'empreinte, être une flotte valide et être cohérente avec TOUTES les réponses données. Sinon, son auteur perd.
   Des réponses impossibles (trop de ratés, un navire « touché » à des cases qui ne tiennent pas dans sa taille) sont démasquées sans attendre. */
export const TAILLE_BN = 8;
export const CASES_BN = TAILLE_BN * TAILLE_BN;
export const NAVIRES_BN = { a: 4, b: 3, c: 3, d: 2, e: 2 };
export const CASES_NAVIRES = 14;

const estNavire = (l) => typeof l === "string" && Object.hasOwn(NAVIRES_BN, l);
const positions = (f, l) => [...f].reduce((acc, c, i) => (c === l ? [...acc, i] : acc), []);

/* Des cases d'un seul tenant en ligne droite ? (positions triées) */
function enLigne(pos, taille) {
  if (pos.length !== taille) return false;
  const lignes = pos.map((i) => Math.floor(i / TAILLE_BN));
  const colonnes = pos.map((i) => i % TAILLE_BN);
  if (lignes.every((l) => l === lignes[0])) return pos[taille - 1] - pos[0] === taille - 1;
  if (colonnes.every((c) => c === colonnes[0])) return lignes[taille - 1] - lignes[0] === taille - 1;
  return false;
}

/* Une flotte valide : 64 caractères parmi « . a b c d e », chaque navire entier, en ligne droite. */
export function flotteValide(f) {
  if (typeof f !== "string" || !/^[.a-e]{64}$/.test(f)) return false;
  return Object.entries(NAVIRES_BN).every(([l, taille]) => enLigne(positions(f, l), taille));
}

function entierAleatoire(n) {  // 0 .. n-1, sans biais
  const limite = Math.floor(0x100000000 / n) * n;
  const t = new Uint32Array(1);
  do crypto.getRandomValues(t); while (t[0] >= limite);
  return t[0] % n;
}

/* Une flotte tirée au hasard (générateur cryptographique du navigateur). Les navires peuvent se toucher, jamais se chevaucher. */
export function flotteAleatoire() {
  for (;;) {
    const f = Array(CASES_BN).fill(".");
    let place = true;
    for (const [l, taille] of Object.entries(NAVIRES_BN)) {
      let ok = false;
      for (let essai = 0; essai < 200 && !ok; essai++) {
        const horizontal = entierAleatoire(2) === 0;
        const ligne = entierAleatoire(horizontal ? TAILLE_BN : TAILLE_BN - taille + 1);
        const colonne = entierAleatoire(horizontal ? TAILLE_BN - taille + 1 : TAILLE_BN);
        const cases = Array.from({ length: taille }, (_, k) => (ligne + (horizontal ? 0 : k)) * TAILLE_BN + colonne + (horizontal ? k : 0));
        if (cases.every((i) => f[i] === ".")) {
          for (const i of cases) f[i] = l;
          ok = true;
        }
      }
      if (!ok) { place = false; break; }
    }
    if (place) return f.join("");
  }
}

/* Les réponses (touché / à l'eau) sont-elles toutes celles que donnerait cette flotte ? reponses : [{ i, r, m }]. */
export function coherente(flotte, reponses) {
  return reponses.every(({ i, r, m }) => (flotte[i] === "." ? r === 0 : r === 1 && m === flotte[i]));
}

/* Des réponses qu'AUCUNE flotte valide ne pourrait donner : trop de cases « à l'eau » (il n'y en a que 50), ou un navire annoncé touché plus
   souvent que sa taille, ou à des cases qui ne tiennent pas dans une ligne de sa taille. Démasque un menteur sans attendre la vérification. */
export function reponsesImpossibles(reponses) {
  if (reponses.filter((t) => t.r === 0).length > CASES_BN - CASES_NAVIRES) return true;
  const parNavire = {};
  for (const t of reponses) {
    if (t.r !== 1) continue;
    if (!parNavire[t.m]) parNavire[t.m] = [];
    parNavire[t.m].push(t.i);
  }
  for (const [l, cases] of Object.entries(parNavire)) {
    const taille = NAVIRES_BN[l];
    if (!taille || cases.length > taille) return true;
    const lignes = cases.map((i) => Math.floor(i / TAILLE_BN));
    const colonnes = cases.map((i) => i % TAILLE_BN);
    const meme = (v) => v.every((x) => x === v[0]);
    const etendue = (v) => Math.max(...v) - Math.min(...v);
    if (!((meme(lignes) && etendue(colonnes) < taille) || (meme(colonnes) && etendue(lignes) < taille))) return true;
  }
  return false;
}

/* Réponses données PAR cote (c'est-à-dire aux tirs de son adversaire). */
export const reponsesDe = (g, cote) => g.tirs.filter((t) => t.par === adversaire(cote));

/* Navires coulés sur la flotte de cote, d'après les réponses annoncées. */
export function naviresCoules(g, cote) {
  const touches = {};
  for (const t of reponsesDe(g, cote)) if (t.r === 1) touches[t.m] = (touches[t.m] || 0) + 1;
  return Object.entries(NAVIRES_BN).filter(([l, taille]) => touches[l] === taille).map(([l]) => l);
}

/* Qui doit agir (et donc peut être déclaré forfait par l'autre), ou null. */
function debiteur(g) {
  if (g.phase === "placement") return !!g.engages.x !== !!g.engages.o ? (g.engages.x ? "o" : "x") : null;
  if (g.phase === "tir") return g.attente ? adversaire(g.attente.par) : g.tour;
  if (g.phase === "revelation") return !!g.reveles.x !== !!g.reveles.o ? (g.reveles.x ? "o" : "x") : null;
  return null;
}

/* Heure du relais depuis laquelle l'adversaire de « moi » est en retard, ou null (pas en retard, ou pas d'heure : parties privées). */
export function departForfaitBn(g, moi) {
  const d = g.etat === "en_cours" ? debiteur(g) : null;
  return d && d !== moi && typeof g.derniere === "number" ? g.derniere : null;
}

function appliquerBn(g, ev) {
  const cote = joueurDe(g, ev.de);
  if (!cote) return;
  const horodater = () => { if (typeof ev.t === "number") g.derniere = ev.t; };
  if (ev.a === "engage") {
    if (g.phase !== "placement" || g.engages[cote] || typeof ev.h !== "string") return;  // un seul engagement : on ne change pas de flotte après coup
    g.engages[cote] = ev.h;
    horodater();
    if (g.engages.x && g.engages.o) {
      g.phase = "tir";
      g.tour = "x";
    }
  } else if (ev.a === "tir") {
    if (g.phase !== "tir" || g.attente || cote !== g.tour) return;
    if (!Number.isInteger(ev.i) || ev.i < 0 || ev.i >= CASES_BN) return;
    if (ev.s !== undefined && ev.s !== g.nbTirs) return;  // parties privées : le tir doit porter le bon numéro
    if (g.tirs.some((t) => t.par === cote && t.i === ev.i)) return;  // pas deux fois la même case
    g.attente = { par: cote, i: ev.i, s: g.nbTirs };
    g.nbTirs += 1;
    horodater();
  } else if (ev.a === "reponse") {
    const attente = g.attente;
    if (g.phase !== "tir" || !attente || cote !== adversaire(attente.par)) return;  // seul le défenseur répond
    if (ev.i !== attente.i || (ev.s !== undefined && ev.s !== attente.s)) return;
    if (ev.r !== 0 && ev.r !== 1) return;
    if (ev.r === 1 && !estNavire(ev.m)) return;
    const tir = { par: attente.par, i: attente.i, r: ev.r };
    if (ev.r === 1) tir.m = ev.m;
    g.tirs.push(tir);
    g.attente = null;
    horodater();
    if (ev.r === 1) g.touches[cote] += 1;
    if (reponsesImpossibles(reponsesDe(g, cote))) {  // menteur démasqué en cours de partie
      g.fraudeur = cote;
      terminer(g, attente.par, "triche");
    } else if (g.touches[cote] === CASES_NAVIRES) {
      g.phase = "revelation";  // toutes les cases touchées : vérification des deux flottes
      g.perdant = cote;
    } else {
      g.tour = cote;
    }
  } else if (ev.a === "revele") {
    if (g.phase !== "revelation" || g.reveles[cote]) return;
    const honnete = flotteValide(ev.f) && verifierEngagement(g.engages[cote], [g.n, cote, ev.f], ev.x) && coherente(ev.f, reponsesDe(g, cote));
    if (!honnete) {
      g.fraudeur = cote;
      terminer(g, adversaire(cote), "triche");
      return;
    }
    g.reveles[cote] = ev.f;
    horodater();
    if (g.reveles.x && g.reveles.o) terminer(g, adversaire(g.perdant), "coule");
  } else if (ev.a === "forfait") {
    const d = debiteur(g);
    if (d && d !== cote && typeof ev.t === "number" && typeof g.derniere === "number" && ev.t - g.derniere >= DELAI_FORFAIT) terminer(g, cote, "forfait");
  }
}

enregistrerJeu({
  id: "bn",
  nom: "Bataille navale",
  icone: "🚢",
  salon: false,  // trop d'événements pour le salon (voir JEUX_PRIVES) : le forfait daté par le relais est prêt pour le jour où il pourra y jouer
  etatInitial: () => ({
    phase: "placement", tour: "x", engages: { x: null, o: null }, attente: null, tirs: [], nbTirs: 0,
    touches: { x: 0, o: 0 }, reveles: { x: null, o: null }, perdant: null,
  }),
  actions: ["engage", "tir", "reponse", "revele", "forfait"],
  appliquer: appliquerBn,
  // Parties privées : l'engagement d'abord, puis tir et réponse numérotés (le tir s précède sa réponse), l'abandon entre deux tirs, la révélation en dernier.
  ordrePrive: (e) => (e.a === "engage" ? 10 : e.a === "tir" ? 20 + 2 * e.s : e.a === "reponse" ? 21 + 2 * e.s : e.a === "abandon" ? 19.5 + 2 * e.s : e.a === "revele" ? 1000 : 10000),
  champsPrives: (g, a) => (a === "tir" || a === "abandon" ? { s: g.nbTirs } : a === "reponse" && g.attente ? { s: g.attente.s } : {}),
});
