import { enregistrerJeu } from "./cadre.js";

export const COLONNES_P4 = 7;
export const LIGNES_P4 = 6;

/* Les quatre cases alignées qui gagnent (horizontale, verticale ou diagonale), ou null. cases : 42 cases, ligne par ligne, la ligne 0 en haut. */
export function ligneGagnanteP4(cases) {
  for (let l = 0; l < LIGNES_P4; l++) {
    for (let c = 0; c < COLONNES_P4; c++) {
      const v = cases[l * COLONNES_P4 + c];
      if (!v) continue;
      for (const [dl, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const ligne = [l * COLONNES_P4 + c];
        for (let k = 1; k < 4; k++) {
          const ll = l + dl * k;
          const cc = c + dc * k;
          if (ll < 0 || ll >= LIGNES_P4 || cc < 0 || cc >= COLONNES_P4 || cases[ll * COLONNES_P4 + cc] !== v) break;
          ligne.push(ll * COLONNES_P4 + cc);
        }
        if (ligne.length === 4) return ligne;
      }
    }
  }
  return null;
}

export function gagnantP4(cases) {
  const ligne = ligneGagnanteP4(cases);
  if (ligne) return cases[ligne[0]];
  return cases.every(Boolean) ? "nul" : null;
}

/* Case où tombe un jeton dans la colonne c : la plus basse libre, ou -1 si la colonne est pleine. */
export function caseDeChute(cases, c) {
  for (let l = LIGNES_P4 - 1; l >= 0; l--) if (!cases[l * COLONNES_P4 + c]) return l * COLONNES_P4 + c;
  return -1;
}

function appliquerCoup(g, ev) {
  if (ev.s !== undefined && ev.s !== g.coups) return;  // parties privées : le coup doit porter le bon numéro
  const marque = g.tour;
  const joueur = marque === "x" ? g.x : g.o;
  if (g.etat !== "en_cours" || !joueur || joueur.id !== ev.de) return;
  if (!Number.isInteger(ev.i) || ev.i < 0 || ev.i >= COLONNES_P4) return;
  const idx = caseDeChute(g.cases, ev.i);
  if (idx < 0) return;  // colonne pleine
  g.cases[idx] = marque;
  g.coups += 1;
  g.dernier = idx;
  const r = gagnantP4(g.cases);
  if (r) {
    g.etat = "fini";
    g.gagnant = r;  // "x", "o" ou "nul"
    if (r !== "nul") g.ligne = ligneGagnanteP4(g.cases);
  } else {
    g.tour = marque === "x" ? "o" : "x";
  }
}

enregistrerJeu({
  id: "p4",
  nom: "Puissance 4",
  icone: "🔴",
  etatInitial: () => ({ cases: Array(COLONNES_P4 * LIGNES_P4).fill(""), tour: "x", coups: 0 }),
  actions: ["coup"],
  appliquer: appliquerCoup,
  ordrePrive: (e) => (e.a === "coup" ? 10 + 2 * e.s : 9 + 2 * e.s),
  champsPrives: (g, a) => (a === "coup" || a === "abandon" ? { s: g.coups } : {}),
});
