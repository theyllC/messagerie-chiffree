/* Logique du salon sans interface : on rejoue les événements (messages, réactions, votes, coups de jeu) dans l'ordre du relais.
   Le relais donne à chaque événement un numéro n unique et croissant : tous les clients rejouent la même suite,
   donc tous obtiennent le même état. Aucun serveur de jeu : les règles sont appliquées par chaque client. */

import { empreinte, texteEngagement as texteEngagementGenerique } from "./engagement.js";
import { appliquerJeu, ordrePrive } from "./jeux/index.js";

/* Les règles des jeux vivent dans jeux/ (cadre commun + un fichier par jeu) et la brique d'engagement dans engagement.js.
   Elles sont ré-exportées ici pour que le reste de l'application et les tests gardent le même point d'entrée. */
export { COUPS_PFC, DELAI_FORFAIT, MANCHES_GAGNANTES, MANCHES_MAX, departForfait, gagnantMorpion } from "./jeux/index.js";

/* Engagement du pierre-feuille-ciseaux : empreinte SHA-256 de « partie | manche | côté | coup | sel » (voir engagement.js). */
export const texteEngagement = (partie, manche, cote, coup, sel) => texteEngagementGenerique([partie, manche, cote, coup], sel);
export const engagement = (partie, manche, cote, coup, sel) => empreinte([partie, manche, cote, coup], sel);

export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🔥", "👀"];
export const DUREES = [
  { label: "Normal", ttl: 0 },
  { label: "10 s", ttl: 10 },
  { label: "1 min", ttl: 60 },
  { label: "1 h", ttl: 3600 },
  { label: "24 h", ttl: 86400 },
];

export const MAX_EPINGLES = 5;  // messages épinglés en même temps : le plus ancien se détache quand on en épingle un sixième
export const DELAIS_OUVERTURE = [
  { label: "Tout de suite", delai: 0 },
  { label: "Dans 1 min", delai: 60 },
  { label: "Dans 1 h", delai: 3600 },
  { label: "Demain (24 h)", delai: 86400 },
  { label: "Dans 3 jours", delai: 259200 },
];

/* Mentions : « @pseudo » dans un texte. On cherche les pseudos connus, les plus longs d'abord (« Anne-Marie » avant « Anne »),
   et un pseudo doit finir sur une frontière (pas de lettre ou de chiffre derrière). Rend [{ t, mention }] pour l'affichage. */
export function decouperMentions(texte, pseudos) {
  const noms = [...new Set((pseudos || []).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!noms.length || !texte.includes("@")) return [{ t: texte, mention: false }];
  const morceaux = [];
  let debut = 0;
  let i = 0;
  const bordure = (c) => c === undefined || !/[\p{L}\p{N}_]/u.test(c);
  while (i < texte.length) {
    if (texte[i] === "@" && (i === 0 || bordure(texte[i - 1]))) {
      const nom = noms.find((x) => texte.slice(i + 1, i + 1 + x.length).toLowerCase() === x.toLowerCase() && bordure(texte[i + 1 + x.length]));
      if (nom) {
        if (i > debut) morceaux.push({ t: texte.slice(debut, i), mention: false });
        morceaux.push({ t: texte.slice(i, i + 1 + nom.length), mention: true });
        i += 1 + nom.length;
        debut = i;
        continue;
      }
    }
    i += 1;
  }
  if (debut < texte.length) morceaux.push({ t: texte.slice(debut), mention: false });
  return morceaux;
}

export const estMentionne = (m, moi) => Boolean(moi && Array.isArray(m.mentions) && m.mentions.includes(moi));

/* events : liste d'éléments du salon tels que rendus par /api/relais/salon (cumulés). supprimes : Set de numéros effacés.
   Rend { fil, reactions, sondages, jeux, epingles } :
   - fil : les éléments à afficher en bulles (messages, sondages, défis) ; les réactions, votes et coups n'ont pas de bulle ;
   - reactions : Map n -> Map emoji -> Set d'identifiants de membres ;
   - sondages : Map n -> { q, o, votes: Map id -> option, total: [compte par option] } ;
   - jeux : Map n -> partie ;
   - epingles : numéros des messages épinglés (au plus MAX_EPINGLES), du plus ancien au plus récent. */
export function deriver(events, supprimes = new Set()) {
  const tries = [...events].sort((a, b) => a.n - b.n);
  const fil = [];
  const reactions = new Map();
  const sondages = new Map();
  const jeux = new Map();
  const epinglables = new Set();  // numéros des messages et sondages encore visibles
  const epingles = new Map();     // numéro -> vrai, dans l'ordre où on les a épinglés
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
      case "pin":
        // Seuls un admin ou le créateur (rôle donné par le relais, pas par l'auteur) épinglent ; la cible doit être un message ou un sondage visible.
        if ((ev.role === "admin" || ev.role === "createur") && epinglables.has(ev.c)) {
          epingles.delete(ev.c);
          if (ev.on) epingles.set(ev.c, true);
        }
        break;
      default:
        if (!ev.k || ev.k === "msg") epinglables.add(ev.n);
        fil.push(ev);  // message texte (ou message illisible)
    }
    if (ev.k === "poll") epinglables.add(ev.n);
  }
  // Un message supprimé ou expiré se détache tout seul ; on garde les MAX_EPINGLES plus récents.
  const vivants = new Set(fil.filter((m) => !m.supprime).map((m) => m.n));
  const listeEpingles = [...epingles.keys()].filter((n) => vivants.has(n)).slice(-MAX_EPINGLES);
  for (const s of sondages.values()) {
    s.total = s.o.map(() => 0);
    for (const i of s.votes.values()) s.total[i] += 1;
  }
  return { fil, reactions, sondages, jeux, epingles: listeEpingles };
}

/* Partie privée entre deux contacts (onglet Conversations) : les événements viennent de /api/conversation (liste « jeux »).
   Pas de relais pour numéroter : l'ordre vient de la partie elle-même (acceptation, puis coups numérotés s = 0, 1, 2…),
   donc l'ordre d'arrivée des messages (file d'attente, reconnexion) ne change pas le résultat. */
export function deriverPrive(jeux) {
  // Ordre d'une partie privée : défi, acceptation, puis les actions dans l'ordre propre au jeu (voir jeux/cadre.js).
  const cle = ordrePrive;
  const normalises = jeux.map((e, rang) => ({ rang, k: cle(e), ev: { ...e, de: e.sens === "envoye" ? "moi" : "lui", pseudo: "", ...(e.a === "defi" ? { n: e.g } : { c: e.g }) } }));
  normalises.sort((a, b) => a.k - b.k || a.rang - b.rang);
  const parties = new Map();
  for (const { ev } of normalises) appliquerJeu(parties, ev);
  return [...parties.values()].reverse();  // les défis sont rangés par ordre d'arrivée : la plus récente d'abord
}
