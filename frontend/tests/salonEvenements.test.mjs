// Lancer : node frontend/tests/salonEvenements.test.mjs
import assert from "node:assert/strict";
import { deriver, deriverPrive, gagnantMorpion, engagement } from "../src/salonEvenements.js";

let n = 0;
const ev = (de, o) => ({ n: ++n, de, pseudo: de.toUpperCase(), ...o });
const jeu = (evs) => deriver(evs).jeux.get(evs[0].n);
let ok = 0;
const t = (nom, f) => { f(); ok++; console.log("OK  ", nom); };

t("réactions : ajout, retrait, plusieurs membres", () => {
  const m = ev("a", { k: "msg", texte: "salut" });
  const r = deriver([m, ev("b", { k: "rx", c: m.n, e: "👍", on: true }), ev("c", { k: "rx", c: m.n, e: "👍", on: true }), ev("b", { k: "rx", c: m.n, e: "👍", on: false })]).reactions;
  assert.deepEqual([...r.get(m.n).get("👍")], ["c"]);
});
t("réactions et votes n'ont pas de bulle", () => {
  const m = ev("a", { k: "msg", texte: "x" });
  assert.equal(deriver([m, ev("b", { k: "rx", c: m.n, e: "🔥", on: true })]).fil.length, 1);
});
t("sondage : un vote par membre, le dernier compte, option hors limite ignorée", () => {
  const p = ev("a", { k: "poll", q: "Pizza ?", o: ["oui", "non"] });
  const s = deriver([p, ev("b", { k: "vote", c: p.n, i: 0 }), ev("b", { k: "vote", c: p.n, i: 1 }), ev("c", { k: "vote", c: p.n, i: 0 }), ev("d", { k: "vote", c: p.n, i: 5 })]).sondages.get(p.n);
  assert.deepEqual(s.total, [1, 1]);
  assert.equal(s.votes.size, 2);
});
t("vote sur un message qui n'est pas un sondage : ignoré", () => {
  const m = ev("a", { k: "msg", texte: "x" });
  assert.equal(deriver([m, ev("b", { k: "vote", c: m.n, i: 0 })]).sondages.size, 0);
});
t("morpion : victoire de X en ligne", () => {
  const d = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const evs = [d, ev("b", { k: "jeu", j: "morpion", a: "accepte", c: d.n })];
  for (const [de, i] of [["a", 0], ["b", 3], ["a", 1], ["b", 4], ["a", 2]]) evs.push(ev(de, { k: "jeu", j: "morpion", a: "coup", c: d.n, i }));
  const g = jeu(evs);
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "x");
});
t("morpion : coup hors tour, case prise, tiers et créateur sans adversaire refusés", () => {
  const d = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const evs = [d, ev("a", { k: "jeu", j: "morpion", a: "coup", c: d.n, i: 4 })];  // avant acceptation
  assert.equal(jeu(evs).cases[4], "");
  evs.push(ev("a", { k: "jeu", j: "morpion", a: "accepte", c: d.n }));  // on ne s'accepte pas soi-même
  assert.equal(jeu(evs).etat, "attente");
  evs.push(ev("b", { k: "jeu", j: "morpion", a: "accepte", c: d.n }));
  evs.push(ev("c", { k: "jeu", j: "morpion", a: "accepte", c: d.n }));  // second accepteur ignoré
  evs.push(ev("b", { k: "jeu", j: "morpion", a: "coup", c: d.n, i: 0 }));  // O joue au tour de X
  evs.push(ev("c", { k: "jeu", j: "morpion", a: "coup", c: d.n, i: 0 }));  // tiers
  evs.push(ev("a", { k: "jeu", j: "morpion", a: "coup", c: d.n, i: 0 }));
  evs.push(ev("b", { k: "jeu", j: "morpion", a: "coup", c: d.n, i: 0 }));  // case prise
  const g = jeu(evs);
  assert.equal(g.o.id, "b");
  assert.equal(g.cases[0], "x");
  assert.equal(g.coups, 1);
  assert.equal(g.tour, "o");
});
t("morpion : match nul", () => {
  const d = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const evs = [d, ev("b", { k: "jeu", j: "morpion", a: "accepte", c: d.n })];
  // X O X / X O O / O X X
  for (const [de, i] of [["a", 0], ["b", 1], ["a", 2], ["b", 4], ["a", 3], ["b", 5], ["a", 7], ["b", 6], ["a", 8]]) evs.push(ev(de, { k: "jeu", j: "morpion", a: "coup", c: d.n, i }));
  assert.equal(jeu(evs).gagnant, "nul");
  assert.equal(gagnantMorpion(["x", "o", "x", "x", "o", "o", "o", "x", "x"]), "nul");
});
t("morpion : abandon donne la victoire à l'autre ; défi annulé sans adversaire", () => {
  const d = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const e1 = [d, ev("b", { k: "jeu", j: "morpion", a: "accepte", c: d.n }), ev("a", { k: "jeu", j: "morpion", a: "abandon", c: d.n })];
  assert.equal(jeu(e1).gagnant, "o");
  const d2 = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const e2 = [d2, ev("c", { k: "jeu", j: "morpion", a: "abandon", c: d2.n })];  // un tiers ne peut pas annuler
  assert.equal(jeu(e2).etat, "attente");
  e2.push(ev("a", { k: "jeu", j: "morpion", a: "abandon", c: d2.n }));
  assert.equal(jeu(e2).gagnant, "annule");
});
t("l'ordre de réception n'a pas d'importance : tout est rejoué par numéro", () => {
  const d = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const evs = [d, ev("b", { k: "jeu", j: "morpion", a: "accepte", c: d.n }), ev("a", { k: "jeu", j: "morpion", a: "coup", c: d.n, i: 4 })];
  assert.deepEqual(deriver([...evs].reverse()).jeux.get(d.n).cases, deriver(evs).jeux.get(d.n).cases);
});
t("message supprimé : bulle « supprimé », événements d'état ignorés", () => {
  const d = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const r = deriver([d, ev("b", { k: "jeu", j: "morpion", a: "accepte", c: d.n })], new Set([d.n]));
  assert.equal(r.fil.length, 1);
  assert.equal(r.fil[0].supprime, true);
  assert.equal(r.jeux.size, 0);
});

// --- parties privées (ordre donné par le numéro de coup, pas par l'arrivée) ---
const p = (sens, a, extra = {}) => ({ sens, j: "morpion", g: "aaaa0001", a, ...extra });
t("privé : partie complète, victoire de X", () => {
  const evs = [p("envoye", "defi"), p("recu", "accepte")];
  [["envoye", 0], ["recu", 3], ["envoye", 1], ["recu", 4], ["envoye", 2]].forEach(([sens, i], s) => evs.push(p(sens, "coup", { i, s })));
  const [g] = deriverPrive(evs);
  assert.equal(g.gagnant, "x");
  assert.equal(g.x.id, "moi");
  assert.equal(g.o.id, "lui");
});
t("privé : l'ordre d'arrivée (file d'attente, rattrapage) ne change rien", () => {
  const evs = [p("envoye", "defi"), p("recu", "accepte")];
  [["envoye", 4], ["recu", 0], ["envoye", 8]].forEach(([sens, i], s) => evs.push(p(sens, "coup", { i, s })));
  const droit = deriverPrive(evs)[0];
  const melange = deriverPrive([evs[3], evs[1], evs[4], evs[0], evs[2]])[0];
  assert.deepEqual(melange.cases, droit.cases);
  assert.equal(melange.tour, droit.tour);
});
t("privé : un coup au mauvais numéro (rejeu, double envoi) est ignoré", () => {
  const evs = [p("envoye", "defi"), p("recu", "accepte"), p("envoye", "coup", { i: 0, s: 0 }), p("envoye", "coup", { i: 1, s: 0 }), p("recu", "coup", { i: 1, s: 5 })];
  const g = deriverPrive(evs)[0];
  assert.equal(g.coups, 1);
  assert.equal(g.cases[1], "");
});
t("privé : celui qui a défié ne peut pas relever son propre défi ; abandon en cours = victoire de l'autre", () => {
  const g1 = deriverPrive([p("envoye", "defi"), p("envoye", "accepte")])[0];
  assert.equal(g1.etat, "attente");
  const g2 = deriverPrive([p("envoye", "defi"), p("recu", "accepte"), p("recu", "abandon", { s: 0 })])[0];
  assert.equal(g2.gagnant, "x");
});
t("privé : deux parties en parallèle, la plus récente en premier", () => {
  const evs = [p("envoye", "defi"), { ...p("recu", "defi"), g: "bbbb0002" }];
  const gs = deriverPrive(evs);
  assert.equal(gs.length, 2);
  assert.equal(gs[0].n, "bbbb0002");
});

// --- pierre-feuille-ciseaux avec engagement ---
const SEL = (i) => String(i).padStart(32, "0");
const pfc = (de, a, extra = {}) => ev(de, { k: "jeu", j: "pfc", a, ...extra });
/* Une manche honnête : les deux s'engagent, puis les deux révèlent. Renvoie les 4 événements. */
function manche(d, r, cx, co, selx = SEL(1), selo = SEL(2)) {
  return [
    pfc("a", "engage", { c: d.n, r, h: engagement(d.n, r, "x", cx, selx) }),
    pfc("b", "engage", { c: d.n, r, h: engagement(d.n, r, "o", co, selo) }),
    pfc("a", "revele", { c: d.n, r, m: cx, x: selx }),
    pfc("b", "revele", { c: d.n, r, m: co, x: selo }),
  ];
}
const ouvrir = () => { const d = pfc("a", "defi"); return [d, pfc("b", "accepte", { c: d.n })]; };
const partie = (evs) => deriver(evs).jeux.get(evs[0].n);

t("pfc : manche honnête, pierre bat ciseaux", () => {
  const [d, acc] = ouvrir();
  const g = partie([d, acc, ...manche(d, 0, "p", "c")]);
  assert.equal(g.points.x, 1);
  assert.equal(g.manches[0].gagnant, "x");
  assert.equal(g.manche, 1);
});
t("pfc : toutes les combinaisons de coups", () => {
  const bat = { p: "c", f: "p", c: "f" };
  for (const cx of "pfc") for (const co of "pfc") {
    const [d, acc] = ouvrir();
    const m = partie([d, acc, ...manche(d, 0, cx, co)]).manches[0].gagnant;
    assert.equal(m, cx === co ? "nul" : bat[cx] === co ? "x" : "o", `${cx} contre ${co}`);
  }
});
t("pfc : égalité rejouée, puis victoire en 2 manches gagnantes", () => {
  const [d, acc] = ouvrir();
  const evs = [d, acc, ...manche(d, 0, "p", "p"), ...manche(d, 1, "f", "p"), ...manche(d, 2, "c", "f")];
  const g = partie(evs);
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "x");
  assert.deepEqual(g.points, { x: 2, o: 0 });
  assert.equal(g.manches.length, 3);
});
t("pfc : TRICHE — changer de coup après avoir vu l'autre = révélation refusée, la partie est perdue", () => {
  const [d, acc] = ouvrir();
  const hx = engagement(d.n, 0, "x", "p", SEL(1));
  const evs = [d, acc, pfc("a", "engage", { c: d.n, r: 0, h: hx }), pfc("b", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "o", "c", SEL(2)) }),
    pfc("a", "revele", { c: d.n, r: 0, m: "f", x: SEL(1) })];  // A s'était engagé sur pierre, révèle feuille
  const g = partie(evs);
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "o");
  assert.equal(g.motif, "triche");
});
t("pfc : TRICHE — mauvais sel, même coup", () => {
  const [d, acc] = ouvrir();
  const evs = [d, acc, pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)) }), pfc("b", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "o", "c", SEL(2)) }),
    pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(9) })];
  assert.equal(partie(evs).motif, "triche");
});
t("pfc : TRICHE — Bob republie l'empreinte d'Alice puis rejoue son coup et son sel : il ne peut plus faire « nul » et il perd", () => {
  const [d, acc] = ouvrir();
  const hA = engagement(d.n, 0, "x", "p", SEL(1));
  const evs = [d, acc, pfc("a", "engage", { c: d.n, r: 0, h: hA }), pfc("b", "engage", { c: d.n, r: 0, h: hA }),  // copie de l'empreinte
    pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(1) }), pfc("b", "revele", { c: d.n, r: 0, m: "p", x: SEL(1) })];  // Bob rejoue le coup et le sel d'Alice
  const g = partie(evs);
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "x");
  assert.equal(g.motif, "triche");
  assert.equal(g.manches.length, 0);  // la manche n'est jamais comptée « nul »
});
t("pfc : la copie ne profite pas à Bob, quel que soit l'ordre des révélations", () => {
  const [d, acc] = ouvrir();
  const hA = engagement(d.n, 0, "x", "p", SEL(1));
  const evs = [d, acc, pfc("a", "engage", { c: d.n, r: 0, h: hA }), pfc("b", "engage", { c: d.n, r: 0, h: hA }),
    pfc("b", "revele", { c: d.n, r: 0, m: "p", x: SEL(1) })];  // Bob révèle avant Alice
  const g = partie(evs);
  assert.equal(g.gagnant, "x");
  assert.equal(g.motif, "triche");
});
t("pfc : un second engagement dans la même manche est ignoré (on ne peut pas se raviser)", () => {
  const [d, acc] = ouvrir();
  const evs = [d, acc, pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)) }), pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "f", SEL(3)) }),
    pfc("b", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "o", "c", SEL(2)) }), pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(1) }), pfc("b", "revele", { c: d.n, r: 0, m: "c", x: SEL(2) })];
  const g = partie(evs);
  assert.equal(g.etat, "en_cours");
  assert.equal(g.manches[0].x, "p");
});
t("pfc : une révélation avant l'engagement de l'autre est ignorée", () => {
  const [d, acc] = ouvrir();
  const evs = [d, acc, pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)) }), pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(1) })];
  const g = partie(evs);
  assert.equal(g.rondes[0].x.m, undefined);
  assert.equal(g.manches.length, 0);
});
t("pfc : un engagement ne se réutilise pas dans une autre manche ni une autre partie", () => {
  const [d, acc] = ouvrir();
  const h0 = engagement(d.n, 0, "x", "p", SEL(1));
  assert.notEqual(h0, engagement(d.n, 1, "x", "p", SEL(1)));
  assert.notEqual(h0, engagement(d.n + 1, 0, "x", "p", SEL(1)));
  assert.notEqual(h0, engagement(d.n, 0, "o", "p", SEL(1)));  // ni chez l'autre joueur
});
t("pfc : un tiers ne peut ni s'engager ni révéler ; événement d'une mauvaise manche ignoré", () => {
  const [d, acc] = ouvrir();
  const evs = [d, acc, pfc("c", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)) }), pfc("a", "engage", { c: d.n, r: 1, h: engagement(d.n, 1, "x", "p", SEL(1)) })];
  const g = partie(evs);
  assert.deepEqual(g.rondes, {});
});
// --- forfait (salon seulement : l'heure vient du relais, champ « t ») ---
function debutForfait(d, tA = 100, tB = 101) {
  return [d, ...[pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)), t: tA }), pfc("b", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "o", "c", SEL(2)), t: tB })]];
}
t("forfait : l'adversaire ne révèle pas, forfait réclamé après 60 s depuis le dernier engagement → victoire", () => {
  const [d, acc] = ouvrir();
  const [, ea, eb] = debutForfait(d);
  const g = partie([d, acc, ea, eb, pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(1), t: 102 }), pfc("a", "forfait", { c: d.n, r: 0, t: 161 })]);
  assert.equal(g.etat, "fini");
  assert.equal(g.gagnant, "x");
  assert.equal(g.motif, "forfait");
});
t("forfait : trop tôt (59 s) → ignoré, la partie continue", () => {
  const [d, acc] = ouvrir();
  const [, ea, eb] = debutForfait(d);
  const g = partie([d, acc, ea, eb, pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(1), t: 102 }), pfc("a", "forfait", { c: d.n, r: 0, t: 160 })]);
  assert.equal(g.etat, "en_cours");
});
t("forfait : le délai court depuis le DERNIER engagement, pas depuis le premier", () => {
  const [d, acc] = ouvrir();
  const [, ea, eb] = debutForfait(d, 100, 150);  // Bob s'engage tard
  const evs = [d, acc, ea, eb, pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(1), t: 151 })];
  assert.equal(partie([...evs, pfc("a", "forfait", { c: d.n, r: 0, t: 180 })]).etat, "en_cours");  // 180 − 150 = 30 s
  assert.equal(partie([...evs, pfc("a", "forfait", { c: d.n, r: 0, t: 210 })]).motif, "forfait");  // 210 − 150 = 60 s
});
t("forfait : refusé si l'adversaire a révélé (la manche se joue normalement)", () => {
  const [d, acc] = ouvrir();
  const [, ea, eb] = debutForfait(d);
  const g = partie([d, acc, ea, eb, pfc("a", "revele", { c: d.n, r: 0, m: "p", x: SEL(1), t: 102 }), pfc("b", "revele", { c: d.n, r: 0, m: "c", x: SEL(2), t: 150 }),
    pfc("a", "forfait", { c: d.n, r: 0, t: 400 })]);
  assert.equal(g.manches.length, 1);
  assert.notEqual(g.motif, "forfait");
});
t("forfait : refusé si le demandeur n'a pas lui-même révélé (les deux engagés)", () => {
  const [d, acc] = ouvrir();
  const [, ea, eb] = debutForfait(d);
  const g = partie([d, acc, ea, eb, pfc("a", "forfait", { c: d.n, r: 0, t: 500 })]);
  assert.equal(g.etat, "en_cours");
});
t("forfait : l'adversaire ne s'engage jamais → forfait 60 s après mon engagement", () => {
  const [d, acc] = ouvrir();
  const ea = pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)), t: 100 });
  assert.equal(partie([d, acc, ea, pfc("a", "forfait", { c: d.n, r: 0, t: 159 })]).etat, "en_cours");
  const g = partie([d, acc, ea, pfc("a", "forfait", { c: d.n, r: 0, t: 160 })]);
  assert.equal(g.gagnant, "x");
  assert.equal(g.motif, "forfait");
});
t("forfait : on ne peut pas réclamer un forfait sans s'être engagé soi-même", () => {
  const [d, acc] = ouvrir();
  const eb = pfc("b", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "o", "c", SEL(2)), t: 100 });
  assert.equal(partie([d, acc, eb, pfc("a", "forfait", { c: d.n, r: 0, t: 999 })]).etat, "en_cours");
});
t("forfait : sans heure du relais (parties privées, vieux relais) → ignoré", () => {
  const [d, acc] = ouvrir();
  const ea = pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)) });  // pas de t
  assert.equal(partie([d, acc, ea, pfc("a", "forfait", { c: d.n, r: 0, t: 9999 })]).etat, "en_cours");
  const ea2 = pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)), t: 100 });
  assert.equal(partie([d, acc, ea2, pfc("a", "forfait", { c: d.n, r: 0 })]).etat, "en_cours");  // forfait sans t
  assert.equal(partie([d, acc, ea2, pfc("a", "forfait", { c: d.n, r: 0, t: "999" })]).etat, "en_cours");  // t qui n'est pas un nombre
});
t("forfait : un tiers, ou une mauvaise manche, ne compte pas", () => {
  const [d, acc] = ouvrir();
  const ea = pfc("a", "engage", { c: d.n, r: 0, h: engagement(d.n, 0, "x", "p", SEL(1)), t: 100 });
  assert.equal(partie([d, acc, ea, pfc("c", "forfait", { c: d.n, r: 0, t: 999 })]).etat, "en_cours");
  assert.equal(partie([d, acc, ea, pfc("a", "forfait", { c: d.n, r: 1, t: 999 })]).etat, "en_cours");
});
t("forfait : ne s'applique pas au morpion", () => {
  const d = ev("a", { k: "jeu", j: "morpion", a: "defi" });
  const evs = [d, ev("b", { k: "jeu", j: "morpion", a: "accepte", c: d.n }), ev("a", { k: "jeu", j: "morpion", a: "forfait", c: d.n, r: 0, t: 999 })];
  assert.equal(deriver(evs).jeux.get(d.n).etat, "en_cours");
});
t("forfait : le moteur des parties privées l'ignore (aucun relais pour dater)", () => {
  const P = (sens, a, extra = {}) => ({ sens, j: "pfc", g: "cccc0005", a, ...extra });
  const evs = [P("envoye", "defi"), P("recu", "accepte"), P("envoye", "engage", { r: 0, h: engagement("cccc0005", 0, "x", "p", SEL(1)) }),
    P("envoye", "forfait", { r: 0, t: 99999 })];
  assert.equal(deriverPrive(evs)[0].etat, "en_cours");
});
t("pfc privé : manche complète, ordre d'arrivée mélangé (engagements/révélations entrelacés)", () => {
  const P = (sens, a, extra = {}) => ({ sens, j: "pfc", g: "cccc0003", a, ...extra });
  const h = (cote, co, sel) => engagement("cccc0003", 0, cote, co, sel);
  const evs = [P("envoye", "defi"), P("recu", "accepte"), P("envoye", "engage", { r: 0, h: h("x", "p", SEL(1)) }), P("recu", "engage", { r: 0, h: h("o", "c", SEL(2)) }),
    P("envoye", "revele", { r: 0, m: "p", x: SEL(1) }), P("recu", "revele", { r: 0, m: "c", x: SEL(2) })];
  const g1 = deriverPrive(evs)[0];
  const g2 = deriverPrive([evs[5], evs[3], evs[0], evs[4], evs[2], evs[1]])[0];
  assert.equal(g1.points.x, 1);
  assert.deepEqual(g2.points, g1.points);
});
t("pfc privé : révélation falsifiée détectée", () => {
  const P = (sens, a, extra = {}) => ({ sens, j: "pfc", g: "cccc0004", a, ...extra });
  const evs = [P("envoye", "defi"), P("recu", "accepte"), P("envoye", "engage", { r: 0, h: engagement("cccc0004", 0, "x", "p", SEL(1)) }),
    P("recu", "engage", { r: 0, h: engagement("cccc0004", 0, "o", "c", SEL(2)) }), P("recu", "revele", { r: 0, m: "f", x: SEL(2) })];
  const g = deriverPrive(evs)[0];
  assert.equal(g.motif, "triche");
  assert.equal(g.gagnant, "x");
});
console.log(`\n${ok} tests OK`);
