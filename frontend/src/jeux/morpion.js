import { enregistrerJeu } from "./cadre.js";

const LIGNES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export function gagnantMorpion(cases) {
  for (const [a, b, c] of LIGNES) if (cases[a] && cases[a] === cases[b] && cases[a] === cases[c]) return cases[a];
  return cases.every(Boolean) ? "nul" : null;
}

function appliquerCoup(g, ev) {
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

enregistrerJeu({
  id: "morpion",
  nom: "Morpion",
  icone: "⭕",
  libelleSalon: "Défi morpion",
  libellePrive: "Défier au morpion",
  etatInitial: () => ({ cases: Array(9).fill(""), tour: "x", coups: 0 }),
  actions: ["coup"],
  appliquer: appliquerCoup,
  ordrePrive: (e) => (e.a === "coup" ? 10 + 2 * e.s : 9 + 2 * e.s),  // le coup numéro s passe après l'abandon porteur du même numéro
  champsPrives: (g, a) => (a === "coup" || a === "abandon" ? { s: g.coups } : {}),
});
