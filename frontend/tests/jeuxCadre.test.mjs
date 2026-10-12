// Tests du cadre commun des jeux et de la brique d'engagement. Lancer : node frontend/tests/jeuxCadre.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cleSecret, ecrireSecret, empreinte, lireSecret, selAleatoire, texteEngagement, verifierEngagement } from "../src/engagement.js";
import { engagement, deriver, deriverPrive } from "../src/salonEvenements.js";
import { appliquerJeu, jeuDefini, listeJeux, ordrePrive } from "../src/jeux/index.js";

let ok = 0;
const t = (nom, f) => { f(); ok++; console.log("OK  ", nom); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const SEL = "0123456789abcdef0123456789abcdef";

// ------------------------------------------------------------------ brique d'engagement
t("engagement : l'empreinte est SHA-256 de « champs | sel »", () => {
  assert.equal(empreinte(["partie1", 0, "x", "p"], SEL), sha(`partie1|0|x|p|${SEL}`));
  assert.equal(texteEngagement(["a", 1], "s"), "a|1|s");
});
t("engagement : compatible avec l'ancien engagement() du pierre-feuille-ciseaux", () => {
  assert.equal(engagement("cccc0004", 2, "o", "f", SEL), empreinte(["cccc0004", 2, "o", "f"], SEL));
});
t("engagement : changer la partie, la manche, le côté, le coup ou le sel change l'empreinte", () => {
  const base = empreinte(["p1", 0, "x", "p"], SEL);
  for (const autre of [["p2", 0, "x", "p"], ["p1", 1, "x", "p"], ["p1", 0, "o", "p"], ["p1", 0, "x", "f"]]) assert.notEqual(empreinte(autre, SEL), base);
  assert.notEqual(empreinte(["p1", 0, "x", "p"], SEL.replace("0", "1")), base);
});
t("engagement : le séparateur « | » dans un champ est refusé (pas de collision de contexte)", () => {
  assert.throws(() => empreinte(["a|b", "c"], SEL));
  assert.throws(() => empreinte(["a", "b|c"], SEL));
  assert.throws(() => empreinte(["a"], "sel|piégé"));
});
t("engagement : verifierEngagement accepte le bon, refuse le reste, sans jamais lever d'erreur", () => {
  const h = empreinte(["p1", 0, "x"], SEL);
  assert.equal(verifierEngagement(h, ["p1", 0, "x"], SEL), true);
  assert.equal(verifierEngagement(h, ["p1", 0, "o"], SEL), false);
  assert.equal(verifierEngagement(h, ["p1", 0, "x"], SEL.replace("0", "1")), false);
  assert.equal(verifierEngagement(undefined, ["p1"], SEL), false);
  assert.equal(verifierEngagement(h, ["p|1"], SEL), false);
  assert.equal(verifierEngagement(h.toUpperCase(), ["p1", 0, "x"], SEL), false);
});
t("engagement : selAleatoire = 128 bits en hexadécimal, jamais deux fois le même", () => {
  const sels = new Set(Array.from({ length: 300 }, selAleatoire));
  assert.equal(sels.size, 300);
  for (const s of sels) assert.match(s, /^[0-9a-f]{32}$/);
});
t("engagement : coffre des secrets (clé historique, validation, stockage cassé)", () => {
  const magasin = new Map();
  globalThis.localStorage = { getItem: (k) => (magasin.has(k) ? magasin.get(k) : null), setItem: (k, v) => magasin.set(k, v) };
  const cle = cleSecret("pfc", "salon-moi", "partie1", 3);
  assert.equal(cle, "mc-pfc:salon-moi:partie1:3");  // même format qu'avant : les parties en cours survivent à la mise à jour
  assert.equal(lireSecret(cle), null);
  assert.equal(ecrireSecret(cle, { m: "p", x: SEL, h: "ab" }), true);
  assert.deepEqual(lireSecret(cle), { m: "p", x: SEL, h: "ab" });
  assert.equal(lireSecret(cle, (v) => v.m === "f"), null);
  magasin.set(cle, "{pas du json");
  assert.equal(lireSecret(cle), null);
  magasin.set(cle, JSON.stringify({ m: "p" }));  // sans sel ni empreinte
  assert.equal(lireSecret(cle), null);
  globalThis.localStorage = { getItem() { throw new Error("indisponible"); }, setItem() { throw new Error("plein"); } };
  assert.equal(lireSecret(cle), null);
  assert.equal(ecrireSecret(cle, { m: "p", x: SEL, h: "ab" }), false);
  delete globalThis.localStorage;
});

// ------------------------------------------------------------------ registre
t("registre : morpion et pfc sont inscrits avec toutes leurs fonctions", () => {
  const ids = listeJeux().map((j) => j.id);
  for (const id of ["morpion", "pfc", "p4", "bn"]) assert.ok(ids.includes(id), id);
  for (const j of listeJeux()) {
    for (const f of ["etatInitial", "appliquer", "ordrePrive", "champsPrives"]) assert.equal(typeof j[f], "function", `${j.id}.${f}`);
    assert.ok(Array.isArray(j.actions) && j.nom && j.icone && j.libelleSalon && j.libellePrive && j.sousTitrePrive);
    assert.equal(typeof j.salon, "boolean");
  }
});
t("registre : la bataille navale est réservée aux parties privées, les autres jeux sont aussi au salon", () => {
  assert.equal(jeuDefini("bn").salon, false);
  for (const id of ["morpion", "pfc", "p4"]) assert.equal(jeuDefini(id).salon, true);
});
t("registre : un identifiant qui n'est pas un jeu (prototype, nombre) ne désigne rien", () => {
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "echecs", 42, null, undefined, {}, []]) assert.equal(jeuDefini(id), null, String(id));
});

// ------------------------------------------------------------------ cycle de vie commun, vérifié sur CHAQUE jeu inscrit
for (const def of listeJeux()) {
  const nouveau = () => {
    const jeux = new Map();
    appliquerJeu(jeux, { n: 10, de: "a", pseudo: "A", k: "jeu", j: def.id, a: "defi" });
    return jeux;
  };
  const evt = (de, a, extra = {}) => ({ n: 99, de, pseudo: de.toUpperCase(), k: "jeu", j: def.id, a, c: 10, ...extra });
  t(`cadre ${def.id} : le défi crée une partie en attente dont le créateur est x`, () => {
    const g = nouveau().get(10);
    assert.equal(g.etat, "attente");
    assert.equal(g.j, def.id);
    assert.deepEqual(g.x, { id: "a", pseudo: "A" });
    assert.equal(g.o, null);
  });
  t(`cadre ${def.id} : on ne relève pas son propre défi ; un seul adversaire, le premier`, () => {
    const jeux = nouveau();
    appliquerJeu(jeux, evt("a", "accepte"));
    assert.equal(jeux.get(10).etat, "attente");
    appliquerJeu(jeux, evt("b", "accepte"));
    appliquerJeu(jeux, evt("c", "accepte"));
    const g = jeux.get(10);
    assert.equal(g.etat, "en_cours");
    assert.equal(g.o.id, "b");
  });
  t(`cadre ${def.id} : abandon : seul un joueur peut abandonner ; annulation avant adversaire ; l'autre gagne`, () => {
    let jeux = nouveau();
    appliquerJeu(jeux, evt("z", "abandon"));
    assert.equal(jeux.get(10).etat, "attente");  // un tiers ne peut pas annuler le défi
    appliquerJeu(jeux, evt("b", "abandon"));
    assert.equal(jeux.get(10).etat, "attente");  // ni quelqu'un qui n'a pas relevé le défi
    appliquerJeu(jeux, evt("a", "abandon"));
    assert.equal(jeux.get(10).gagnant, "annule");
    jeux = nouveau();
    appliquerJeu(jeux, evt("b", "accepte"));
    appliquerJeu(jeux, evt("z", "abandon"));
    assert.equal(jeux.get(10).etat, "en_cours");
    appliquerJeu(jeux, evt("b", "abandon"));
    assert.equal(jeux.get(10).gagnant, "x");
    assert.equal(jeux.get(10).abandon, true);
  });
  t(`cadre ${def.id} : une partie finie ne bouge plus (ni action, ni abandon, ni acceptation)`, () => {
    const jeux = nouveau();
    appliquerJeu(jeux, evt("b", "accepte"));
    appliquerJeu(jeux, evt("a", "abandon"));
    const avant = JSON.stringify(jeux.get(10));
    for (const a of ["accepte", "abandon", ...def.actions]) appliquerJeu(jeux, evt(a === "accepte" ? "c" : "b", a, { i: 0, r: 0, h: "x".repeat(64), m: "p", x: SEL, s: 0 }));
    assert.equal(JSON.stringify(jeux.get(10)), avant);
  });
  t(`cadre ${def.id} : action inconnue, partie inexistante ou autre jeu : ignorées`, () => {
    const jeux = nouveau();
    appliquerJeu(jeux, evt("b", "accepte"));
    const avant = JSON.stringify(jeux.get(10));
    appliquerJeu(jeux, evt("a", "triche"));
    appliquerJeu(jeux, evt("a", "coup", { c: 777, i: 0 }));
    appliquerJeu(jeux, { ...evt("a", "abandon"), j: def.id === "pfc" ? "morpion" : "pfc" });
    assert.equal(JSON.stringify(jeux.get(10)), avant);
    assert.equal(jeux.size, 1);
  });
  t(`cadre ${def.id} : un défi dont l'identifiant existe déjà ne remet pas la partie à zéro`, () => {
    const jeux = nouveau();
    appliquerJeu(jeux, evt("b", "accepte"));
    appliquerJeu(jeux, { n: 10, de: "b", pseudo: "B", k: "jeu", j: def.id, a: "defi" });
    const g = jeux.get(10);
    assert.equal(g.etat, "en_cours");
    assert.equal(g.x.id, "a");
  });
}
t("cadre : un défi pour un jeu inconnu ne crée aucune partie (et ne casse rien)", () => {
  const jeux = new Map();
  for (const j of ["echecs", "__proto__", "constructor", undefined]) appliquerJeu(jeux, { n: 1, de: "a", k: "jeu", j, a: "defi" });
  assert.equal(jeux.size, 0);
  assert.doesNotThrow(() => deriver([{ n: 1, de: "a", k: "jeu", j: "echecs", a: "defi" }, { n: 2, de: "b", k: "jeu", j: "echecs", a: "accepte", c: 1 }]));
});
t("cadre : un coup de morpion envoyé à une partie de pfc (ou l'inverse) est ignoré", () => {
  const jeux = new Map();
  appliquerJeu(jeux, { n: 1, de: "a", k: "jeu", j: "pfc", a: "defi" });
  appliquerJeu(jeux, { n: 2, de: "b", k: "jeu", j: "pfc", a: "accepte", c: 1 });
  appliquerJeu(jeux, { n: 3, de: "a", k: "jeu", j: "morpion", a: "coup", c: 1, i: 0 });
  appliquerJeu(jeux, { n: 4, de: "a", k: "jeu", j: "pfc", a: "coup", c: 1, i: 0 });  // pfc n'a pas de « coup »
  assert.equal(jeux.get(1).manches.length, 0);
  assert.equal(jeux.get(1).cases, undefined);
});

// ------------------------------------------------------------------ parties privées : ordre et champs de transport
const privee = (g, evs) => evs.map(([sens, a, extra]) => ({ sens, j: "morpion", g, a, ...extra }));
const partieMorpion = (g) => privee(g, [["envoye", "defi"], ["recu", "accepte"], ["envoye", "coup", { i: 0, s: 0 }], ["recu", "coup", { i: 3, s: 1 }],
  ["envoye", "coup", { i: 1, s: 2 }], ["recu", "coup", { i: 4, s: 3 }], ["envoye", "coup", { i: 2, s: 4 }]]);
t("privé : morpion complet, l'ordre d'arrivée des messages ne change pas le résultat", () => {
  const evs = partieMorpion("aaaa0001");
  const attendu = deriverPrive(evs)[0];
  assert.equal(attendu.etat, "fini");
  assert.equal(attendu.gagnant, "x");
  for (const ordre of [[6, 5, 4, 3, 2, 1, 0], [3, 0, 6, 1, 5, 2, 4], [1, 0, 4, 2, 6, 3, 5]]) {
    const g = deriverPrive(ordre.map((i) => evs[i]))[0];
    assert.equal(g.gagnant, attendu.gagnant);
    assert.deepEqual(g.cases, attendu.cases);
  }
});
t("privé : abandon placé après le bon coup, même si le message arrive en premier", () => {
  const evs = privee("aaaa0002", [["envoye", "defi"], ["recu", "accepte"], ["envoye", "coup", { i: 0, s: 0 }], ["recu", "abandon", { s: 1 }]]);
  for (const ordre of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
    const g = deriverPrive(ordre.map((i) => evs[i]))[0];
    assert.equal(g.gagnant, "x");
    assert.equal(g.abandon, true);
    assert.equal(g.cases[0], "x");
  }
});
t("privé : un défi renvoyé avec le même identifiant ne remet pas la partie à zéro", () => {
  const evs = [...partieMorpion("aaaa0003").slice(0, 4), { sens: "recu", j: "morpion", g: "aaaa0003", a: "defi" }];
  const g = deriverPrive(evs)[0];
  assert.equal(g.etat, "en_cours");
  assert.equal(g.x.id, "moi");
  assert.equal(g.coups, 2);
});
t("privé : ordrePrive place défi, acceptation, puis les actions du jeu ; jeu inconnu en dernier", () => {
  assert.equal(ordrePrive({ a: "defi", j: "morpion" }), 0);
  assert.equal(ordrePrive({ a: "accepte", j: "pfc" }), 1);
  assert.ok(ordrePrive({ a: "engage", j: "pfc", r: 0 }) < ordrePrive({ a: "revele", j: "pfc", r: 0 }));
  assert.ok(ordrePrive({ a: "revele", j: "pfc", r: 0 }) < ordrePrive({ a: "engage", j: "pfc", r: 1 }));
  assert.equal(ordrePrive({ a: "coup", j: "echecs" }), 10000);
});
t("privé : champsPrives (numéro du coup au morpion, rien pour pfc)", () => {
  const m = jeuDefini("morpion"), p = jeuDefini("pfc");
  assert.deepEqual(m.champsPrives({ coups: 3 }, "coup"), { s: 3 });
  assert.deepEqual(m.champsPrives({ coups: 3 }, "abandon"), { s: 3 });
  assert.deepEqual(m.champsPrives({ coups: 3 }, "accepte"), {});
  for (const a of ["engage", "revele", "accepte", "abandon"]) assert.deepEqual(p.champsPrives({ coups: 3 }, a), {});
});

// ------------------------------------------------------------------ tentatives de triche sur le cadre
t("triche : revendiquer le côté de l'autre (republier son empreinte) ne passe pas, en privé comme au salon", () => {
  // Alice (x) et Bob (o) s'engagent. Bob republie l'empreinte d'Alice comme sienne puis révèle le même coup et le même sel.
  const g = 7;
  const hAlice = engagement(g, 0, "x", "p", SEL);
  const evs = [
    { n: g, de: "a", k: "jeu", j: "pfc", a: "defi" }, { n: 8, de: "b", k: "jeu", j: "pfc", a: "accepte", c: g },
    { n: 9, de: "a", k: "jeu", j: "pfc", a: "engage", c: g, r: 0, h: hAlice }, { n: 10, de: "b", k: "jeu", j: "pfc", a: "engage", c: g, r: 0, h: hAlice },
    { n: 11, de: "a", k: "jeu", j: "pfc", a: "revele", c: g, r: 0, m: "p", x: SEL }, { n: 12, de: "b", k: "jeu", j: "pfc", a: "revele", c: g, r: 0, m: "p", x: SEL },
  ];
  const partie = deriver(evs).jeux.get(g);
  assert.equal(partie.etat, "fini");
  assert.equal(partie.motif, "triche");
  assert.equal(partie.gagnant, "x");
});
console.log(`\n${ok} tests OK`);
