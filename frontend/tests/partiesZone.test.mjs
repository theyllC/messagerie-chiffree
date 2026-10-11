// Tests de la zone des parties d'une conversation privée. Lancer : node frontend/tests/partiesZone.test.mjs
import assert from "node:assert/strict";
import { MAX_FERMEES, ajouterFermees, estActive, partiesVisibles } from "../src/partiesZone.js";

let ok = 0;
const t = (nom, f) => { f(); ok++; console.log("OK  ", nom); };
const g = (n, etat) => ({ n, etat, j: "morpion" });
const ids = (r) => r.liste.map((p) => p.n);

t("une partie en attente ou en cours est toujours visible", () => {
  const r = partiesVisibles([g("a", "attente"), g("b", "en_cours")]);
  assert.deepEqual(ids(r), ["a", "b"]);
  assert.equal(r.actives, 2);
});
t("sans partie en cours, seule la dernière partie terminée reste visible", () => {
  const r = partiesVisibles([g("1", "fini"), g("2", "fini"), g("3", "fini")]);
  assert.deepEqual(ids(r), ["1"]);
  assert.equal(r.cachees, 2);
  assert.equal(r.finies, 3);
});
t("avec une partie en cours, les parties terminées vont dans « anciennes parties »", () => {
  const r = partiesVisibles([g("x", "en_cours"), g("1", "fini"), g("2", "fini")]);
  assert.deepEqual(ids(r), ["x"]);
  assert.equal(r.cachees, 2);
});
t("« anciennes parties » : toutVoir les montre toutes, dans l'ordre d'origine", () => {
  const parties = [g("1", "fini"), g("x", "en_cours"), g("2", "fini")];
  const r = partiesVisibles(parties, [], true);
  assert.deepEqual(ids(r), ["1", "x", "2"]);
  assert.equal(r.cachees, 0);
});
t("fermer la dernière partie terminée ne fait pas remonter la précédente", () => {
  const r = partiesVisibles([g("1", "fini"), g("2", "fini")], ["1"]);
  assert.deepEqual(ids(r), []);
  assert.equal(r.cachees, 1);  // la 2 reste accessible dans « anciennes parties »
  assert.deepEqual(ids(partiesVisibles([g("1", "fini"), g("2", "fini")], ["1"], true)), ["2"]);
  assert.deepEqual(ids(partiesVisibles([g("1", "fini")], new Set(["1"]))), []);  // Set accepté aussi
});
t("tout fermé et rien en cours : plus rien à afficher", () => {
  const r = partiesVisibles([g("1", "fini"), g("2", "fini")], ["1", "2"]);
  assert.deepEqual(ids(r), []);
  assert.equal(r.cachees, 0);
});
t("une partie en cours reste visible même si son identifiant figure dans les fermées", () => {
  assert.deepEqual(ids(partiesVisibles([g("1", "en_cours")], ["1"])), ["1"]);
});
t("liste vide", () => {
  const r = partiesVisibles([]);
  assert.deepEqual([r.liste.length, r.actives, r.finies, r.cachees], [0, 0, 0, 0]);
});
t("ajouterFermees : sans doublon, sans partie en cours, ignore ce qui n'est pas un identifiant", () => {
  const parties = [g("a", "en_cours"), g("b", "fini"), g("c", "fini")];
  assert.deepEqual(ajouterFermees(["b"], ["b", "c", "a", 5, null], parties), ["b", "c"]);
});
t("ajouterFermees : bornée, on garde les plus récentes", () => {
  const beaucoup = Array.from({ length: MAX_FERMEES + 50 }, (_, i) => `id${i}`);
  const r = ajouterFermees([], beaucoup);
  assert.equal(r.length, MAX_FERMEES);
  assert.equal(r[r.length - 1], `id${MAX_FERMEES + 49}`);
  assert.ok(!r.includes("id0"));
});
t("estActive", () => {
  assert.deepEqual(["attente", "en_cours", "fini"].map((etat) => estActive({ etat })), [true, true, false]);
});
console.log(`\n${ok} tests OK`);
