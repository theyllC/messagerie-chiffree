// Tests de la bataille navale (engagement de flotte, tirs, détection des mensonges, forfait, parties privées).
// Lancer : node frontend/tests/batailleNavale.test.mjs
import assert from "node:assert/strict";
import { empreinte } from "../src/engagement.js";
import { deriver, deriverPrive } from "../src/salonEvenements.js";
import { CASES_NAVIRES, DELAI_FORFAIT, coherente, departForfaitBn, flotteAleatoire, flotteValide, naviresCoules, reponsesImpossibles } from "../src/jeux/index.js";

let ok = 0;
const t = (nom, f) => { f(); ok++; console.log("OK  ", nom); };

const construire = (navires) => { const f = Array(64).fill("."); for (const [l, cases] of Object.entries(navires)) for (const i of cases) f[i] = l; return f.join(""); };
const FLOTTE_X = construire({ a: [0, 1, 2, 3], b: [16, 17, 18], c: [7, 15, 23], d: [44, 45], e: [51, 59] });
const FLOTTE_O = construire({ a: [60, 61, 62, 63], b: [24, 32, 40], c: [10, 11, 12], d: [38, 46], e: [29, 30] });
const AUTRE_O = construire({ a: [0, 8, 16, 24], b: [4, 5, 6], c: [34, 42, 50], d: [56, 57], e: [31, 39] });  // une autre flotte valide
const SEL_X = "11".repeat(16);
const SEL_O = "22".repeat(16);
const cases = (f) => [...f].flatMap((c, i) => (c === "." ? [] : [i]));
const eau = (f) => [...f].flatMap((c, i) => (c === "." ? [i] : []));
const rep = (f, i) => (f[i] === "." ? { r: 0 } : { r: 1, m: f[i] });

// ---- construction d'une partie du salon (x = « a », o = « b », partie n° 1 ; les événements portent l'heure t du relais)
function salon() {
  let n = 1;
  const evs = [{ n: 1, de: "a", k: "jeu", j: "bn", a: "defi" }];
  const s = {
    evs,
    push(de, a, extra = {}, heure) { n += 1; evs.push({ n, de, k: "jeu", j: "bn", a, c: 1, ...(heure === undefined ? {} : { t: heure }), ...extra }); return s; },
    engager(de, cote, flotte, sel, heure) { return s.push(de, "engage", { h: empreinte([1, cote, flotte], sel) }, heure); },
    tirer(tireur, i, flotteDefenseur, heure) { s.push(tireur, "tir", { i }, heure); return s.push(tireur === "a" ? "b" : "a", "reponse", { i, ...rep(flotteDefenseur, i) }, heure); },
    revele(de, cote, flotte, sel, heure) { return s.push(de, "revele", { f: flotte, x: sel }, heure); },
    partie: () => deriver(evs).jeux.get(1),
  };
  s.push("b", "accepte");
  return s;
}
// Partie honnête jusqu'à la vérification : x coule toute la flotte de o (14 tirs), o rate 13 fois.
function jusqueRevelation(s) {
  s.engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  const cibles = cases(FLOTTE_O);
  const rates = eau(FLOTTE_X);
  for (let k = 0; k < CASES_NAVIRES; k++) {
    s.tirer("a", cibles[k], FLOTTE_O);
    if (k < CASES_NAVIRES - 1) s.tirer("b", rates[k], FLOTTE_X);
  }
  return s;
}

// ------------------------------------------------------------------ flottes
t("flotteValide : accepte les flottes de test, refuse les formes impossibles", () => {
  for (const f of [FLOTTE_X, FLOTTE_O, AUTRE_O]) assert.equal(flotteValide(f), true);
  assert.equal(flotteValide(FLOTTE_X.replace("aaaa", "aaa.")), false);               // navire trop court
  assert.equal(flotteValide(construire({ a: [0, 1, 2, 3], b: [16, 17, 18], c: [7, 15, 23], d: [44, 46], e: [51, 59] })), false);  // d : cases non contiguës
  assert.equal(flotteValide(construire({ a: [0, 1, 2, 11], b: [16, 17, 18], c: [7, 15, 23], d: [44, 45], e: [51, 59] })), false); // a : coudé
  assert.equal(flotteValide(construire({ a: [6, 7, 8, 9], b: [16, 17, 18], c: [23, 31, 39], d: [44, 45], e: [51, 59] })), false);  // a : à cheval sur deux lignes
  assert.equal(flotteValide(FLOTTE_X.slice(0, 63)), false);
  assert.equal(flotteValide(FLOTTE_X.replace("e", "z")), false);
  assert.equal(flotteValide(null), false);
  assert.equal(flotteValide(42), false);
  assert.equal(flotteValide("."), false);
});
t("flotteAleatoire : toujours valide, avec 14 cases de navire, et pas toujours la même", () => {
  const vues = new Set();
  for (let k = 0; k < 400; k++) {
    const f = flotteAleatoire();
    assert.equal(flotteValide(f), true);
    assert.equal(cases(f).length, CASES_NAVIRES);
    vues.add(f);
  }
  assert.ok(vues.size > 350);
});
t("coherente : les réponses d'une flotte honnête sont cohérentes, un seul mensonge suffit à l'être moins", () => {
  const reponses = [0, 1, 4, 60, 7].map((i) => ({ i, ...rep(FLOTTE_X, i) }));
  assert.equal(coherente(FLOTTE_X, reponses), true);
  assert.equal(coherente(FLOTTE_X, [...reponses, { i: 4, r: 1, m: "a" }]), false);   // touché annoncé sur de l'eau
  assert.equal(coherente(FLOTTE_X, [{ i: 0, r: 0 }]), false);                         // à l'eau annoncé sur un navire
  assert.equal(coherente(FLOTTE_X, [{ i: 0, r: 1, m: "b" }]), false);                 // mauvais navire
});
t("reponsesImpossibles : trop de ratés, navire dispersé ou trop souvent touché", () => {
  assert.equal(reponsesImpossibles(Array.from({ length: 51 }, (_, i) => ({ i, r: 0 }))), true);
  assert.equal(reponsesImpossibles(Array.from({ length: 50 }, (_, i) => ({ i, r: 0 }))), false);
  assert.equal(reponsesImpossibles([{ i: 0, r: 1, m: "a" }, { i: 63, r: 1, m: "a" }]), true);
  assert.equal(reponsesImpossibles([{ i: 0, r: 1, m: "d" }, { i: 3, r: 1, m: "d" }]), true);   // d : 2 cases, écart de 3
  assert.equal(reponsesImpossibles([{ i: 0, r: 1, m: "d" }, { i: 1, r: 1, m: "d" }, { i: 2, r: 1, m: "d" }]), true);  // trois touchés pour un navire de 2
  assert.equal(reponsesImpossibles([{ i: 0, r: 1, m: "a" }, { i: 1, r: 1, m: "a" }, { i: 9, r: 0 }]), false);
  assert.equal(reponsesImpossibles([{ i: 0, r: 1, m: "z" }]), true);
});

// ------------------------------------------------------------------ partie honnête
t("partie honnête : engagements, tirs, vérification, victoire par flotte coulée", () => {
  const s = jusqueRevelation(salon());
  let g = s.partie();
  assert.equal(g.phase, "revelation");
  assert.equal(g.perdant, "o");
  assert.equal(g.etat, "en_cours");
  assert.deepEqual(naviresCoules(g, "o").sort(), ["a", "b", "c", "d", "e"]);
  assert.equal(g.tirs.length, 14 + 13);
  s.revele("b", "o", FLOTTE_O, SEL_O);
  g = s.partie();
  assert.equal(g.etat, "en_cours");  // il manque la flotte du vainqueur : lui aussi doit prouver qu'il n'a pas menti
  s.revele("a", "x", FLOTTE_X, SEL_X);
  g = s.partie();
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "x");
  assert.equal(g.motif, "coule");
  assert.equal(g.reveles.x, FLOTTE_X);
  assert.equal(g.reveles.o, FLOTTE_O);
});
t("partie honnête : l'ordre des deux révélations ne change rien", () => {
  const s = jusqueRevelation(salon());
  s.revele("a", "x", FLOTTE_X, SEL_X).revele("b", "o", FLOTTE_O, SEL_O);
  assert.equal(s.partie().gagnant, "x");
  assert.equal(s.partie().motif, "coule");
});
t("les tirs alternent : après chaque réponse, c'est au défenseur de tirer", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  assert.equal(s.partie().tour, "x");
  s.tirer("a", 60, FLOTTE_O);
  assert.equal(s.partie().tour, "o");
  s.tirer("b", 0, FLOTTE_X);
  assert.equal(s.partie().tour, "x");
});

// ------------------------------------------------------------------ règles et triche
t("engagement : un seul par joueur, et pas de tir avant que les deux soient engagés", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X);
  const premier = s.partie().engages.x;
  s.engager("a", "x", AUTRE_O, SEL_X);  // tente de changer de flotte
  assert.equal(s.partie().engages.x, premier);
  s.push("a", "tir", { i: 5 });
  assert.equal(s.partie().nbTirs, 0);
  assert.equal(s.partie().phase, "placement");
  s.engager("b", "o", FLOTTE_O, SEL_O);
  assert.equal(s.partie().phase, "tir");
  s.engager("b", "o", AUTRE_O, SEL_O);  // engagement tardif
  assert.equal(s.partie().engages.o, empreinte([1, "o", FLOTTE_O], SEL_O));
});
t("engagement : un tiers ne peut ni s'engager ni tirer", () => {
  const s = salon().engager("z", "x", FLOTTE_X, SEL_X);
  assert.equal(s.partie().engages.x, null);
  s.engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O).push("z", "tir", { i: 3 });
  assert.equal(s.partie().nbTirs, 0);
});
t("tirs : chacun son tour, pas de second tir en attente, pas deux fois la même case, case valide", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  s.push("b", "tir", { i: 0 });                       // o tire avant x
  assert.equal(s.partie().nbTirs, 0);
  for (const i of [64, -1, 1.5, "3", null, undefined]) s.push("a", "tir", { i });  // cases invalides
  assert.equal(s.partie().nbTirs, 0);
  s.push("a", "tir", { i: 10 }).push("a", "tir", { i: 11 });  // second tir alors que le premier attend sa réponse
  assert.equal(s.partie().nbTirs, 1);
  assert.equal(s.partie().attente.i, 10);
  s.push("b", "reponse", { i: 10, r: 0 });
  assert.equal(s.partie().tour, "o");
  s.push("a", "tir", { i: 12 });                      // x rejoue alors que c'est à o
  assert.equal(s.partie().nbTirs, 1);
  s.tirer("b", 1, FLOTTE_X);
  assert.equal(s.partie().tour, "x");
  s.push("a", "tir", { i: 10 });                      // la case 10 a déjà été visée par x
  assert.equal(s.partie().nbTirs, 2);
  assert.equal(s.partie().attente, null);
  s.push("a", "tir", { i: 12 });                      // une case jamais visée : acceptée
  assert.equal(s.partie().nbTirs, 3);
  assert.equal(s.partie().attente.i, 12);
});
t("réponses : seul le défenseur répond, sur la bonne case, avec un résultat bien formé", () => {
  const faux = [{ i: 5 }, { i: 5, r: 2 }, { i: 5, r: 1 }, { i: 5, r: 1, m: "z" }, { i: 5, r: 1, m: "constructor" }, { i: 5, r: 1, m: "__proto__" }, { i: 6, r: 0 }, { r: 0 }, { i: 5, r: "0" }];
  for (const extra of faux) {
    const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
    s.push("a", "tir", { i: 5 });
    s.push("b", "reponse", extra);
    assert.equal(s.partie().tirs.length, 0, JSON.stringify(extra));
    assert.ok(s.partie().attente, JSON.stringify(extra));
  }
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  s.push("a", "tir", { i: 5 });
  s.push("a", "reponse", { i: 5, r: 0 });  // le tireur ne répond pas à son propre tir
  assert.equal(s.partie().tirs.length, 0);
  s.push("z", "reponse", { i: 5, r: 0 });  // ni un tiers
  assert.equal(s.partie().tirs.length, 0);
});
t("mensonge démasqué en cours de partie : navire annoncé touché à des cases éloignées", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  s.push("a", "tir", { i: 0 }).push("b", "reponse", { i: 0, r: 1, m: "a" });
  s.push("b", "tir", { i: 20 }).push("a", "reponse", { i: 20, r: 0 });
  s.push("a", "tir", { i: 63 }).push("b", "reponse", { i: 63, r: 1, m: "a" });
  const g = s.partie();
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "x");
  assert.equal(g.motif, "triche");
  assert.equal(g.fraudeur, "o");
});
t("mensonge « à l'eau » démasqué : on ne peut pas annoncer plus de 50 ratés, la partie ne reste pas bloquée", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  const eauX = eau(FLOTTE_X);
  for (let k = 0; k < 51; k++) {
    s.push("a", "tir", { i: k }).push("b", "reponse", { i: k, r: 0 });  // o prétend que tout est à l'eau, même ses 14 cases de navire
    if (s.partie().etat !== "en_cours") { assert.equal(k, 50, "démasqué pile au 51e « à l'eau »"); break; }
    s.tirer("b", eauX[k], FLOTTE_X);                                     // o tire sur des cases d'eau de x : x répond honnêtement « à l'eau »
  }
  const g = s.partie();
  assert.equal(g.etat, "fini");
  assert.equal(g.motif, "triche");
  assert.equal(g.fraudeur, "o");
  assert.equal(g.gagnant, "x");
});
t("vérification : un mauvais sel, une autre flotte ou un engagement copié donnent perdant le tricheur", () => {
  const cas = [
    ["mauvais sel", (s) => s.revele("b", "o", FLOTTE_O, "33".repeat(16)), "o"],
    ["autre flotte valide, même sel", (s) => s.revele("b", "o", AUTRE_O, SEL_O), "o"],
    ["flotte invalide", (s) => s.revele("b", "o", ".".repeat(64), SEL_O), "o"],
    ["le vainqueur apparent triche aussi", (s) => s.revele("b", "o", FLOTTE_O, SEL_O).revele("a", "x", FLOTTE_X, "44".repeat(16)), "x"],
  ];
  for (const [nom, action, fraudeur] of cas) {
    const s = jusqueRevelation(salon());
    action(s);
    const g = s.partie();
    assert.equal(g.etat, "fini", nom);
    assert.equal(g.motif, "triche", nom);
    assert.equal(g.fraudeur, fraudeur, nom);
    assert.equal(g.gagnant, fraudeur === "o" ? "x" : "o", nom);
  }
});
t("vérification : une flotte différente de celle utilisée pour répondre est démasquée", () => {
  // o s'engage sur FLOTTE_O mais répond aux tirs comme si sa flotte était AUTRE_O : sa révélation ne colle pas à ses réponses
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  const cibles = cases(AUTRE_O);
  const rates = eau(FLOTTE_X);
  for (let k = 0; k < CASES_NAVIRES; k++) {
    s.tirer("a", cibles[k], AUTRE_O);
    if (k < CASES_NAVIRES - 1) s.tirer("b", rates[k], FLOTTE_X);
  }
  assert.equal(s.partie().phase, "revelation");
  s.revele("b", "o", FLOTTE_O, SEL_O);
  const g = s.partie();
  assert.equal(g.etat, "fini");
  assert.equal(g.fraudeur, "o");
  assert.equal(g.gagnant, "x");
});
t("vérification : republier l'empreinte de l'adversaire comme la sienne ne sert à rien (le côté est dans l'engagement)", () => {
  // o recopie l'empreinte de x et, dans le pire cas, connaît même la flotte et le sel de x : il répond comme x, puis révèle la flotte de x.
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).push("b", "engage", { h: empreinte([1, "x", FLOTTE_X], SEL_X) });
  const cibles = cases(FLOTTE_X);
  const rates = eau(FLOTTE_X);
  for (let k = 0; k < CASES_NAVIRES; k++) {
    s.tirer("a", cibles[k], FLOTTE_X);
    if (k < CASES_NAVIRES - 1) s.tirer("b", rates[k], FLOTTE_X);
  }
  assert.equal(s.partie().phase, "revelation");   // ses réponses sont cohérentes avec la flotte de x : seul le côté le trahit
  s.revele("b", "o", FLOTTE_X, SEL_X);
  const g = s.partie();
  assert.equal(g.etat, "fini");
  assert.equal(g.fraudeur, "o");
  assert.equal(g.gagnant, "x");
  assert.equal(g.motif, "triche");
  assert.equal(empreinte([1, "x", FLOTTE_X], SEL_X) === empreinte([1, "o", FLOTTE_X], SEL_X), false);
});
t("vérification : révélation hors phase, par un tiers ou en double : ignorée", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X).engager("b", "o", FLOTTE_O, SEL_O);
  s.revele("a", "x", FLOTTE_X, SEL_X);  // avant la fin des tirs
  assert.equal(s.partie().reveles.x, null);
  jusqueRevelation(salon());
  const s2 = jusqueRevelation(salon());
  s2.revele("z", "x", FLOTTE_X, SEL_X);
  assert.equal(s2.partie().reveles.x, null);
  s2.revele("b", "o", FLOTTE_O, SEL_O).revele("b", "o", AUTRE_O, SEL_O);  // une seconde révélation ne remplace pas la première
  assert.equal(s2.partie().reveles.o, FLOTTE_O);
  assert.equal(s2.partie().etat, "en_cours");
});

// ------------------------------------------------------------------ parties aléatoires complètes
const LETTRES = ["a", "b", "c", "d", "e"];
function simuler(graine, menteur, type) {
  let etat = graine;
  const alea = (n) => { etat = (etat * 1103515245 + 12345) & 0x7fffffff; return etat % n; };
  const melange = () => { const v = Array.from({ length: 64 }, (_, i) => i); for (let i = 63; i > 0; i--) { const j = alea(i + 1); [v[i], v[j]] = [v[j], v[i]]; } return v; };
  const flottes = { x: flotteAleatoire(), o: flotteAleatoire() };
  const joueur = { x: "a", o: "b" };
  const autre = (c) => (c === "x" ? "o" : "x");
  const s = salon().engager("a", "x", flottes.x, SEL_X).engager("b", "o", flottes.o, SEL_O);
  const cibles = { x: melange(), o: melange() };
  let menti = false;
  while (s.partie().phase === "tir" && s.partie().etat === "en_cours") {
    const tireur = s.partie().tour;
    const defenseur = autre(tireur);
    const i = cibles[tireur].pop();
    s.push(joueur[tireur], "tir", { i });
    let reponse = rep(flottes[defenseur], i);
    if (defenseur === menteur && !menti) {
      if (type === "rate" && reponse.r === 1) { reponse = { r: 0 }; menti = true; }
      else if (type === "touche" && reponse.r === 0) { reponse = { r: 1, m: LETTRES[alea(5)] }; menti = true; }
      else if (type === "lettre" && reponse.r === 1) { reponse = { r: 1, m: LETTRES.find((l) => l !== reponse.m) }; menti = true; }
    }
    s.push(joueur[defenseur], "reponse", { i, ...reponse });
  }
  if (s.partie().etat === "en_cours") {
    for (const c of ["x", "o"]) if (s.partie().etat === "en_cours") s.revele(joueur[c], c, flottes[c], c === "x" ? SEL_X : SEL_O);
  }
  return { g: s.partie(), menti };
}
t("200 parties aléatoires honnêtes : jamais d'accusation à tort, toujours une victoire vérifiée", () => {
  for (let graine = 1; graine <= 200; graine++) {
    const { g } = simuler(graine, null, null);
    assert.equal(g.etat, "fini", `graine ${graine}`);
    assert.equal(g.motif, "coule", `graine ${graine}`);
    assert.equal(g.fraudeur, undefined, `graine ${graine}`);
    assert.equal(naviresCoules(g, g.perdant).length, 5, `graine ${graine}`);
    assert.equal(g.reveles.x !== null && g.reveles.o !== null, true, `graine ${graine}`);
  }
});
for (const [type, description] of [["rate", "annoncer « à l'eau » sur un navire"], ["touche", "annoncer « touché » sur de l'eau"], ["lettre", "se tromper de navire"]]) {
  t(`150 parties où un joueur ment une fois (${description}) : le menteur perd toujours`, () => {
    let mensonges = 0;
    for (let graine = 1; graine <= 150; graine++) {
      const menteur = graine % 2 ? "x" : "o";
      const { g, menti } = simuler(graine * 7, menteur, type);
      if (!menti) continue;
      mensonges += 1;
      assert.equal(g.etat, "fini", `graine ${graine}`);
      assert.equal(g.motif, "triche", `graine ${graine}`);
      assert.equal(g.fraudeur, menteur, `graine ${graine}`);
      assert.equal(g.gagnant, menteur === "x" ? "o" : "x", `graine ${graine}`);
    }
    assert.ok(mensonges > 100, `seulement ${mensonges} mensonges effectivement joués`);
  });
}

// ------------------------------------------------------------------ forfait (salon : heure du relais)
t("forfait : placement, l'adversaire qui ne s'est pas engagé", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X, 1000);
  s.push("a", "forfait", {}, 1000 + DELAI_FORFAIT - 1);
  assert.equal(s.partie().etat, "en_cours");
  assert.equal(departForfaitBn(s.partie(), "x"), 1000);
  assert.equal(departForfaitBn(s.partie(), "o"), null);
  s.push("b", "forfait", {}, 5000);  // celui qui est en retard ne peut pas réclamer
  assert.equal(s.partie().etat, "en_cours");
  s.push("a", "forfait", {}, 1000 + DELAI_FORFAIT);
  assert.equal(s.partie().gagnant, "x");
  assert.equal(s.partie().motif, "forfait");
});
t("forfait : un tir qui attend sa réponse, ou un tireur qui ne tire pas", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X, 100).engager("b", "o", FLOTTE_O, SEL_O, 110);
  s.push("a", "forfait", {}, 500);  // c'est à x de tirer : x ne peut pas réclamer le forfait de o
  assert.equal(s.partie().etat, "en_cours");
  s.push("b", "forfait", {}, 110 + DELAI_FORFAIT);  // o peut : x n'a pas tiré
  assert.equal(s.partie().gagnant, "o");
  const s2 = salon().engager("a", "x", FLOTTE_X, SEL_X, 100).engager("b", "o", FLOTTE_O, SEL_O, 110);
  s2.push("a", "tir", { i: 5 }, 120);
  s2.push("a", "forfait", {}, 120 + DELAI_FORFAIT);  // o n'a pas répondu à temps
  assert.equal(s2.partie().gagnant, "x");
});
t("forfait : pendant la vérification, seul celui qui a révélé peut réclamer", () => {
  const s = jusqueRevelation(salon());
  s.push("a", "forfait", {}, 99999);   // personne n'a révélé : ni l'un ni l'autre n'est « en retard » seul
  assert.equal(s.partie().etat, "en_cours");
  s.revele("b", "o", FLOTTE_O, SEL_O, 2000);
  s.push("a", "forfait", {}, 2000 + DELAI_FORFAIT - 1);
  assert.equal(s.partie().etat, "en_cours");
  s.push("b", "forfait", {}, 2000 + DELAI_FORFAIT);
  assert.equal(s.partie().gagnant, "o");
  assert.equal(s.partie().motif, "forfait");
});
t("forfait : sans heure de relais (parties privées), jamais de forfait", () => {
  const s = salon().engager("a", "x", FLOTTE_X, SEL_X);
  s.push("a", "forfait");
  assert.equal(s.partie().etat, "en_cours");
});

// ------------------------------------------------------------------ parties privées (pas de relais : tirs et réponses numérotés)
function privee(g) {
  const evs = [{ sens: "envoye", j: "bn", g, a: "defi" }, { sens: "recu", j: "bn", g, a: "accepte" }];
  const p = {
    evs,
    engager(sens, cote, flotte, sel) { evs.push({ sens, j: "bn", g, a: "engage", h: empreinte([g, cote, flotte], sel) }); return p; },
    tirer(sens, s, i, flotteDefenseur) {
      evs.push({ sens, j: "bn", g, a: "tir", i, s });
      evs.push({ sens: sens === "envoye" ? "recu" : "envoye", j: "bn", g, a: "reponse", i, s, ...rep(flotteDefenseur, i) });
      return p;
    },
    revele(sens, flotte, sel) { evs.push({ sens, j: "bn", g, a: "revele", f: flotte, x: sel }); return p; },
  };
  return p;
}
function partiePriveeComplete(g) {
  const p = privee(g).engager("envoye", "x", FLOTTE_X, SEL_X).engager("recu", "o", FLOTTE_O, SEL_O);
  const cibles = cases(FLOTTE_O);
  const rates = eau(FLOTTE_X);
  let s = 0;
  for (let k = 0; k < CASES_NAVIRES; k++) {
    p.tirer("envoye", s++, cibles[k], FLOTTE_O);
    if (k < CASES_NAVIRES - 1) p.tirer("recu", s++, rates[k], FLOTTE_X);
  }
  return p.revele("recu", FLOTTE_O, SEL_O).revele("envoye", FLOTTE_X, SEL_X);
}
t("privé : partie complète, même résultat quel que soit l'ordre d'arrivée des messages", () => {
  const evs = partiePriveeComplete("cccc0001").evs;
  const attendu = deriverPrive(evs)[0];
  assert.equal(attendu.etat, "fini");
  assert.equal(attendu.gagnant, "x");
  assert.equal(attendu.motif, "coule");
  let graine = 99;
  const alea = (n) => { graine = (graine * 1103515245 + 12345) & 0x7fffffff; return graine % n; };
  const permutations = [[...evs].reverse()];
  for (let k = 0; k < 40; k++) {
    const copie = [...evs];
    for (let i = copie.length - 1; i > 0; i--) { const j = alea(i + 1); [copie[i], copie[j]] = [copie[j], copie[i]]; }
    permutations.push(copie);
  }
  for (const p of permutations) {
    const g = deriverPrive(p)[0];
    assert.equal(g.etat, "fini");
    assert.equal(g.gagnant, "x");
    assert.equal(g.motif, "coule");
    assert.equal(g.tirs.length, attendu.tirs.length);
  }
});
t("privé : un tir ou une réponse avec le mauvais numéro est ignoré", () => {
  const p = privee("cccc0002").engager("envoye", "x", FLOTTE_X, SEL_X).engager("recu", "o", FLOTTE_O, SEL_O);
  p.evs.push({ sens: "envoye", j: "bn", g: "cccc0002", a: "tir", i: 5, s: 7 });       // numéro faux
  assert.equal(deriverPrive(p.evs)[0].nbTirs, 0);
  p.evs.push({ sens: "envoye", j: "bn", g: "cccc0002", a: "tir", i: 5, s: 0 });
  p.evs.push({ sens: "recu", j: "bn", g: "cccc0002", a: "reponse", i: 5, s: 3, r: 0 });  // réponse au mauvais numéro
  const g = deriverPrive(p.evs)[0];
  assert.equal(g.tirs.length, 0);
  assert.ok(g.attente);
});
t("privé : un abandon est placé entre deux tirs, même s'il arrive en premier", () => {
  const p = privee("cccc0003").engager("envoye", "x", FLOTTE_X, SEL_X).engager("recu", "o", FLOTTE_O, SEL_O).tirer("envoye", 0, 60, FLOTTE_O);
  p.evs.push({ sens: "recu", j: "bn", g: "cccc0003", a: "abandon", s: 1 });
  for (const evs of [p.evs, [...p.evs].reverse()]) {
    const g = deriverPrive(evs)[0];
    assert.equal(g.etat, "fini");
    assert.equal(g.gagnant, "x");
    assert.equal(g.abandon, true);
    assert.equal(g.tirs.length, 1);
  }
});
console.log(`\n${ok} tests OK`);
