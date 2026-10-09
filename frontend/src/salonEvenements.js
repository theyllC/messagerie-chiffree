/* Logique du salon sans interface : on rejoue les événements (messages, réactions, votes, coups de jeu) dans l'ordre du relais.
   Le relais donne à chaque événement un numéro n unique et croissant : tous les clients rejouent la même suite,
   donc tous obtiennent le même état. Aucun serveur de jeu : les règles sont appliquées par chaque client. */

import { sha256Hex } from "./sha256.js";

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🔥", "👀"];
export const DUREES = [
  { label: "Normal", ttl: 0 },
  { label: "10 s", ttl: 10 },
  { label: "1 min", ttl: 60 },
  { label: "1 h", ttl: 3600 },
  { label: "24 h", ttl: 86400 },
];

const LIGNES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export function gagnantMorpion(cases) {
  for (const [a, b, c] of LIGNES) if (cases[a] && cases[a] === cases[b] && cases[a] === cases[c]) return cases[a];
  return cases.every(Boolean) ? "nul" : null;
}

export const COUPS_PFC = { p: { nom: "Pierre", icone: "✊", bat: "c" }, f: { nom: "Feuille", icone: "✋", bat: "p" }, c: { nom: "Ciseaux", icone: "✌️", bat: "f" } };
export const MANCHES_GAGNANTES = 2;   // première à 2 manches (égalités rejouées)
export const MANCHES_MAX = 10;
export const DELAI_FORFAIT = 60;  // secondes : au-delà, l'adversaire qui n'a pas joué peut être déclaré forfait (salon seulement)

/* Engagement : empreinte SHA-256 de « partie | manche | côté | coup | sel ». Le sel (128 bits aléatoires) empêche de retrouver le coup en essayant
   les 3 possibilités ; la partie et la manche empêchent de réutiliser un engagement dans un autre contexte ; le côté (« x » ou « o ») lie
   l'empreinte à son auteur : l'empreinte d'Alice republiée par Bob ne se révèle pas comme la sienne (sinon il rejouerait son coup et son sel
   pour faire « nul » à chaque fois). */
export const texteEngagement = (partie, manche, cote, coup, sel) => `${partie}|${manche}|${cote}|${coup}|${sel}`;
export const engagement = (partie, manche, cote, coup, sel) => sha256Hex(texteEngagement(partie, manche, cote, coup, sel));

function nouvellePartie(ev) {
  const base = { n: ev.n, j: ev.j, etat: "attente", x: { id: ev.de, pseudo: ev.pseudo }, o: null, gagnant: null };
  if (ev.j === "pfc") return { ...base, manche: 0, points: { x: 0, o: 0 }, manches: [], rondes: {} };
  return { ...base, cases: Array(9).fill(""), tour: "x", coups: 0 };
}

function joueurDe(g, id) {
  return g.x.id === id ? "x" : g.o && g.o.id === id ? "o" : null;
}

function appliquerCoupMorpion(g, ev) {
  if (ev.s !== undefined && ev.s !== g.coups) return;  // parties privées : le coup doit porter le bon numéro (pas de numéro de relais pour les ordonner)
  const marque = g.tour;
  const joueur = marque === "x" ? g.x : g.o;
  if (g.etat !== "en_cours" || !joueur || joueur.id !== ev.de || g.cases[ev.i]) return;
  g.cases[ev.i] = marque;
  g.coups += 1;
  g.dernier = ev.i;
  const r = gagnantMorpion(g.cases);
  if (r) {
    g.etat = "fini";
    g.gagnant = r;  // "x", "o" ou "nul"
  } else {
    g.tour = marque === "x" ? "o" : "x";
  }
}

function terminer(g, gagnant, motif) {
  g.etat = "fini";
  g.gagnant = gagnant;
  if (motif) g.motif = motif;
}

/* Forfait (salon seulement). Heure du relais à partir de laquelle l'adversaire de « moi » est en retard, ou null s'il ne l'est pas :
   - j'ai révélé et l'autre, engagé aussi, n'a pas révélé : le délai court depuis le dernier des deux engagements ;
   - je me suis engagé et l'autre ne s'est pas engagé : le délai court depuis mon engagement.
   Celui qui réclame doit avoir joué sa part (engagé, ou révélé quand les deux sont engagés). Sans heure de relais (parties privées, vieux
   relais), il n'y a pas de forfait possible. L'heure du forfait vient du relais, pas du client : on ne peut pas la tricher. */
export function departForfait(g, moi) {
  const ronde = g.rondes && g.rondes[g.manche];
  if (!ronde || g.etat !== "en_cours") return null;
  const moiCote = ronde[moi];
  const autreCote = ronde[moi === "x" ? "o" : "x"];
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
  const autre = moi === "x" ? "o" : "x";
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
    if (engagement(g.n, g.manche, moi, ev.m, ev.x) !== cote.h) {
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

/* Applique un événement « jeu » à la partie correspondante (jeux : Map identifiant de la partie -> partie). Ignore silencieusement tout
   événement illégal : mauvais joueur, mauvais tour, case prise, partie finie, engagement déjà posé… C'est ce qui rend la triche inutile :
   tous les clients rejettent les mêmes événements. */
function appliquerJeu(jeux, ev) {
  if (ev.a === "defi") {
    jeux.set(ev.n, nouvellePartie(ev));
    return;
  }
  const g = jeux.get(ev.c);
  if (!g || g.j !== ev.j || g.etat === "fini") return;
  if (ev.a === "accepte") {
    if (g.etat === "attente" && ev.de !== g.x.id) {
      g.o = { id: ev.de, pseudo: ev.pseudo };
      g.etat = "en_cours";
    }
  } else if (ev.a === "coup" && g.j === "morpion") {
    appliquerCoupMorpion(g, ev);
  } else if ((ev.a === "engage" || ev.a === "revele" || ev.a === "forfait") && g.j === "pfc") {
    appliquerPfc(g, ev);
  } else if (ev.a === "abandon") {
    const estX = ev.de === g.x.id;
    const estO = g.o && ev.de === g.o.id;
    if (!estX && !estO) return;
    g.etat = "fini";
    g.gagnant = g.o ? (estX ? "o" : "x") : "annule";
    g.abandon = true;
  }
}

/* events : liste d'éléments du salon tels que rendus par /api/relais/salon (cumulés). supprimes : Set de numéros effacés.
   Rend { fil, reactions, sondages, jeux } :
   - fil : les éléments à afficher en bulles (messages, sondages, défis) ; les réactions, votes et coups n'ont pas de bulle ;
   - reactions : Map n -> Map emoji -> Set d'identifiants de membres ;
   - sondages : Map n -> { q, o, votes: Map id -> option, total: [compte par option] } ;
   - jeux : Map n -> partie. */
export function deriver(events, supprimes = new Set()) {
  const tries = [...events].sort((a, b) => a.n - b.n);
  const fil = [];
  const reactions = new Map();
  const sondages = new Map();
  const jeux = new Map();
  for (const ev of tries) {
    if (ev.supprime || supprimes.has(ev.n)) {
      if (!ev.k || ev.k === "msg" || ev.k === "poll" || (ev.k === "jeu" && ev.a === "defi")) fil.push({ ...ev, supprime: true });
      continue;
    }
    switch (ev.k) {
      case "rx": {
        const parEmoji = reactions.get(ev.c) || new Map();
        const qui = parEmoji.get(ev.e) || new Set();
        if (ev.on) qui.add(ev.de); else qui.delete(ev.de);
        parEmoji.set(ev.e, qui);
        reactions.set(ev.c, parEmoji);
        break;
      }
      case "poll":
        sondages.set(ev.n, { q: ev.q, o: ev.o, votes: new Map() });
        fil.push(ev);
        break;
      case "vote": {
        const s = sondages.get(ev.c);
        if (s && ev.i < s.o.length) s.votes.set(ev.de, ev.i);  // un seul vote par membre : le dernier compte
        break;
      }
      case "jeu":
        appliquerJeu(jeux, ev);
        if (ev.a === "defi") fil.push(ev);
        break;
      default:
        fil.push(ev);  // message texte (ou message illisible)
    }
  }
  for (const s of sondages.values()) {
    s.total = s.o.map(() => 0);
    for (const i of s.votes.values()) s.total[i] += 1;
  }
  return { fil, reactions, sondages, jeux };
}

/* Partie privée entre deux contacts (onglet Conversations) : les événements viennent de /api/conversation (liste « jeux »).
   Pas de relais pour numéroter : l'ordre vient de la partie elle-même (acceptation, puis coups numérotés s = 0, 1, 2…),
   donc l'ordre d'arrivée des messages (file d'attente, reconnexion) ne change pas le résultat. */
export function deriverPrive(jeux) {
  // Ordre d'une partie privée : défi, acceptation, puis (morpion) coups numérotés s ou (pfc) manches r : engagements avant révélations.
  const cle = (e) => {
    if (e.a === "defi") return 0;
    if (e.a === "accepte") return 1;
    if (e.j === "pfc") return e.a === "engage" ? 10 + 10 * e.r : e.a === "revele" ? 15 + 10 * e.r : 10000;
    return e.a === "coup" ? 10 + 2 * e.s : 9 + 2 * e.s;
  };
  const normalises = jeux.map((e, rang) => ({ rang, k: cle(e), ev: { ...e, de: e.sens === "envoye" ? "moi" : "lui", pseudo: "", ...(e.a === "defi" ? { n: e.g } : { c: e.g }) } }));
  normalises.sort((a, b) => a.k - b.k || a.rang - b.rang);
  const parties = new Map();
  for (const { ev } of normalises) appliquerJeu(parties, ev);
  return [...parties.values()].reverse();  // les défis sont rangés par ordre d'arrivée : la plus récente d'abord
}
