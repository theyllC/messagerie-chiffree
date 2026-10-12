// Tests du Puissance 4. Lancer : node frontend/tests/puissance4.test.mjs
import assert from "node:assert/strict";
import { deriver, deriverPrive } from "../src/salonEvenements.js";
import { caseDeChute, gagnantP4, ligneGagnanteP4 } from "../src/jeux/index.js";

let ok = 0;
const t = (nom, f) => { f(); ok++; console.log("OK  ", nom); };

// x = « a » (joue en premier), o = « b ». coups : colonnes jouées à tour de rôle.
function partie(colonnes, joueurs = ["a", "b"]) {
  const evs = [{ n: 1, de: "a", k: "jeu", j: "p4", a: "defi" }, { n: 2, de: "b", k: "jeu", j: "p4", a: "accepte", c: 1 }];
  colonnes.forEach((i, k) => evs.push({ n: 3 + k, de: joueurs[k % 2], k: "jeu", j: "p4", a: "coup", c: 1, i }));
  return deriver(evs).jeux.get(1);
}
const NUL = [2, 2, 4, 5, 3, 4, 3, 2, 5, 1, 1, 6, 5, 4, 2, 2, 2, 5, 0, 5, 5, 0, 0, 0, 3, 1, 6, 6, 6, 3, 0, 3, 4, 1, 0, 1, 1, 6, 4, 3, 4, 6];

t("gravité : le jeton tombe tout en bas, le suivant se pose dessus", () => {
  const g = partie([3, 3, 3]);
  assert.deepEqual([g.cases[38], g.cases[31], g.cases[24]], ["x", "o", "x"]);
  assert.equal(g.dernier, 24);
  assert.equal(g.coups, 3);
});
t("alignement horizontal", () => {
  const g = partie([0, 0, 1, 1, 2, 2, 3]);
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "x");
  assert.deepEqual(g.ligne, [35, 36, 37, 38]);
});
t("alignement vertical", () => {
  const g = partie([0, 1, 0, 1, 0, 1, 0]);
  assert.equal(g.gagnant, "x");
  assert.deepEqual(g.ligne, [14, 21, 28, 35]);
});
t("diagonale montante (↗)", () => {
  // x : colonnes 0, 1, 2, 3 à des hauteurs 0, 1, 2, 3
  const g = partie([0, 1, 1, 2, 3, 2, 2, 3, 4, 3, 3]);
  assert.equal(g.gagnant, "x");
  assert.equal(g.ligne.length, 4);
});
t("diagonale descendante (↘)", () => {
  const g = partie([3, 2, 2, 1, 0, 1, 1, 0, 6, 0, 0]);
  assert.equal(g.gagnant, "x");
  assert.equal(g.ligne.length, 4);
});
t("trois alignés ne suffisent pas, et une partie en cours n'a pas de vainqueur", () => {
  const g = partie([0, 6, 1, 6, 2]);
  assert.equal(g.etat, "en_cours");
  assert.equal(g.gagnant, null);
  assert.equal(g.tour, "o");
});
t("match nul : grille pleine sans quatre alignés", () => {
  const g = partie(NUL);
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "nul");
  assert.equal(g.coups, 42);
  assert.equal(g.ligne, undefined);
});
t("colonne pleine : le coup est ignoré, le tour ne passe pas", () => {
  const g = partie([0, 0, 0, 0, 0, 0, 0]);  // 6 jetons dans la colonne 0, le 7e est refusé
  assert.equal(g.coups, 6);
  assert.equal(g.tour, "x");
  assert.equal(caseDeChute(g.cases, 0), -1);
});
t("triche : mauvais tour, mauvais joueur, colonne hors grille ou non entière", () => {
  const base = [{ n: 1, de: "a", k: "jeu", j: "p4", a: "defi" }, { n: 2, de: "b", k: "jeu", j: "p4", a: "accepte", c: 1 }];
  const essais = [
    { n: 3, de: "b", i: 0 },     // o joue avant x
    { n: 3, de: "z", i: 0 },     // un tiers
    { n: 3, de: "a", i: 7 }, { n: 3, de: "a", i: -1 }, { n: 3, de: "a", i: 1.5 }, { n: 3, de: "a", i: "2" }, { n: 3, de: "a" },
  ];
  for (const e of essais) {
    const g = deriver([...base, { k: "jeu", j: "p4", a: "coup", c: 1, ...e }]).jeux.get(1);
    assert.equal(g.coups, 0, JSON.stringify(e));
  }
});
t("après la victoire, plus aucun coup n'est pris en compte", () => {
  const g = partie([0, 0, 1, 1, 2, 2, 3, 4, 4]);
  assert.equal(g.gagnant, "x");
  assert.equal(g.coups, 7);
});
t("ligneGagnanteP4 / gagnantP4 : grille vide, pleine sans vainqueur", () => {
  assert.equal(ligneGagnanteP4(Array(42).fill("")), null);
  assert.equal(gagnantP4(Array(42).fill("")), null);
});

// ---- parties privées : coups numérotés, l'ordre d'arrivée ne compte pas
const privee = (g, colonnes) => [
  { sens: "envoye", j: "p4", g, a: "defi" }, { sens: "recu", j: "p4", g, a: "accepte" },
  ...colonnes.map((i, s) => ({ sens: s % 2 === 0 ? "envoye" : "recu", j: "p4", g, a: "coup", i, s })),
];
t("privé : partie complète, résultat identique quel que soit l'ordre d'arrivée", () => {
  const evs = privee("bbbb0001", [0, 0, 1, 1, 2, 2, 3]);
  const attendu = deriverPrive(evs)[0];
  assert.equal(attendu.gagnant, "x");
  const permutations = [[...evs].reverse(), [3, 0, 8, 1, 5, 2, 7, 4, 6].map((i) => evs[i]), [1, 0, 2, 8, 7, 6, 5, 4, 3].map((i) => evs[i])];
  for (const p of permutations) {
    const g = deriverPrive(p)[0];
    assert.equal(g.gagnant, attendu.gagnant);
    assert.deepEqual(g.cases, attendu.cases);
  }
});
t("privé : un coup avec le mauvais numéro est ignoré", () => {
  const evs = privee("bbbb0002", [3, 3]);
  evs.push({ sens: "envoye", j: "p4", g: "bbbb0002", a: "coup", i: 4, s: 5 });
  assert.equal(deriverPrive(evs)[0].coups, 2);
});
console.log(`\n${ok} tests OK`);
