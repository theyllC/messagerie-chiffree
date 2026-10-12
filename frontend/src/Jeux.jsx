import { useEffect, useRef, useState } from "react";
import { cleSecret, ecrireSecret, empreinte, lireSecret, selAleatoire } from "./engagement.js";
import {
  CASES_BN, COLONNES_P4, COUPS_PFC, DELAI_FORFAIT, LIGNES_P4, MANCHES_GAGNANTES, NAVIRES_BN, TAILLE_BN,
  caseDeChute, champsEngagementPfc, departForfait, departForfaitBn, flotteAleatoire, flotteValide, naviresCoules, reponsesDe,
} from "./jeux/index.js";

/* Cartes de jeu partagées : salon de la salle et conversations privées. Elles ne connaissent pas le transport :
   elles affichent une partie (voir jeux/ et salonEvenements.js) et rendent les actions choisies via onAction.
   Toutes reposent sur le même cadre (CadreJeu) : en-tête, titre d'état, et boutons Relever / Annuler / Abandonner / Nouveau défi.
   Pour ajouter un jeu : écrire sa carte avec CadreJeu, puis l'inscrire dans CARTES en bas de ce fichier. */

/* Titre d'état commun. enCours : texte propre au jeu quand la partie est en cours ; finSpeciale(jeu, noms) : fin propre au jeu
   (forfait, triche…) ou rien pour la fin standard « X gagne ». */
export function titrePartie(jeu, noms, enCours, finSpeciale) {
  if (jeu.etat === "attente") return `${noms.x} cherche un adversaire…`;
  if (jeu.etat === "en_cours") return enCours;
  if (jeu.gagnant === "nul") return "Match nul";
  if (jeu.gagnant === "annule") return "Défi annulé";
  return (finSpeciale && finSpeciale(jeu, noms)) || `${noms[jeu.gagnant]} gagne${jeu.abandon ? " (abandon)" : " !"}`;
}

/* Cadre commun d'une carte de partie.
   noms : { x, o } ; marques : { x, o } (symboles affichés après les noms, facultatif) ; entete : ligne sous le titre (score…) ;
   actionsJeu : boutons propres au jeu, placés avant « Abandonner ». */
export function CadreJeu({ jeu, moi, pret, noms, onAction, classe, icone, nom, marques, titre, entete, actionsJeu, children }) {
  const monMarque = jeu.x.id === moi ? "x" : jeu.o && jeu.o.id === moi ? "o" : null;
  const suffixe = (c) => (marques ? ` (${marques[c]})` : "");
  return (
    <div className={classe}>
      <strong>{icone} {nom} · {noms.x}{suffixe("x")}{noms.o ? ` contre ${noms.o}${suffixe("o")}` : ""}</strong>
      {entete}
      <p className="morpion-titre" role="status">{titre}</p>
      {children}
      <div className="morpion-actions">
        {jeu.etat === "attente" && jeu.x.id !== moi && <button type="button" className="bouton petit" disabled={!pret} onClick={() => onAction({ a: "accepte", c: jeu.n })}>Relever le défi</button>}
        {jeu.etat === "attente" && jeu.x.id === moi && <button type="button" className="lien danger" onClick={() => onAction({ a: "abandon", c: jeu.n })}>Annuler le défi</button>}
        {actionsJeu}
        {jeu.etat === "en_cours" && monMarque && <button type="button" className="lien danger" onClick={() => onAction({ a: "abandon", c: jeu.n })}>Abandonner</button>}
        {jeu.etat === "fini" && <button type="button" className="bouton secondaire petit" disabled={!pret} onClick={() => onAction({ a: "defi" })}>Lancer un nouveau défi</button>}
      </div>
    </div>
  );
}

/* Révélation automatique d'un engagement : dès que la clé est non nulle (les conditions sont réunies), on appelle envoyer(), une seule
   tentative toutes les 8 s tant que la condition reste vraie (le relais ou le réseau peut avoir perdu le message). */
export function useRevelationAuto(cle, envoyer) {
  const dernierEnvoi = useRef({});
  useEffect(() => {
    if (!cle) return;
    if (Date.now() - (dernierEnvoi.current[cle] || 0) < 8000) return;
    dernierEnvoi.current[cle] = Date.now();
    envoyer();
  });
}

/* Décompte du forfait : secondes restantes avant que l'adversaire en retard puisse être déclaré forfait (négatif ou nul : réclamable), ou null s'il
   n'y a pas de retard. depart : heure du relais depuis laquelle l'adversaire est en retard ; maintenant() : heure du relais « maintenant ».
   Se réaffiche chaque seconde tant qu'un retard est en cours. */
export function useDecompteForfait(depart, maintenant) {
  const [, setTic] = useState(0);
  useEffect(() => {
    if (depart === null) return undefined;
    const id = setInterval(() => setTic((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [depart]);
  return depart === null || !maintenant ? null : Math.ceil(depart + DELAI_FORFAIT - maintenant());
}

const joueursDe = (jeu, nom) => ({ x: nom(jeu.x), o: jeu.o ? nom(jeu.o) : null });
const marqueDe = (jeu, moi) => (jeu.x.id === moi ? "x" : jeu.o && jeu.o.id === moi ? "o" : null);

export function CarteMorpion({ jeu, moi, pret, nom, onAction }) {
  if (!jeu) return <p className="texte supprime">Partie introuvable.</p>;
  const noms = joueursDe(jeu, nom);
  const monMarque = marqueDe(jeu, moi);
  const monTour = jeu.etat === "en_cours" && monMarque === jeu.tour;
  const titre = titrePartie(jeu, noms, monTour ? "À toi de jouer !" : `Tour de ${noms[jeu.tour]}`);
  return (
    <CadreJeu jeu={jeu} moi={moi} pret={pret} noms={noms} onAction={onAction} classe="morpion" icone="⭕" nom="Morpion" marques={{ x: "✕", o: "◯" }} titre={titre}>
      <div className="grille-morpion" role="grid" aria-label="Grille de morpion">
        {jeu.cases.map((c, i) => (
          <button key={i} type="button" role="gridcell" className={`case${jeu.dernier === i ? " derniere" : ""}`}
                  disabled={!pret || !monTour || !!c} onClick={() => onAction({ a: "coup", c: jeu.n, i })}
                  aria-label={`Case ${i + 1} : ${c === "x" ? "croix" : c === "o" ? "rond" : "vide"}`}>
            {c === "x" ? "✕" : c === "o" ? "◯" : ""}
          </button>
        ))}
      </div>
    </CadreJeu>
  );
}


/* --- Pierre-feuille-ciseaux avec engagement ---------------------------------------------------------------------------------
   Mon coup et mon sel restent dans ce navigateur (localStorage) entre l'engagement et la révélation : sans eux, je ne pourrais pas
   révéler si la page est rechargée. Ils ne sont jamais envoyés avant la révélation, et seule l'empreinte SHA-256 circule d'abord.
   La mécanique (empreinte, sel, coffre des secrets, révélation automatique) vient de engagement.js : elle sert à tout jeu à information cachée. */
const secretPfc = (portee, partie, manche) => lireSecret(cleSecret("pfc", portee, partie, manche), (v) => Boolean(COUPS_PFC[v.m]));

const court = (h) => (h ? `${h.slice(0, 10)}…` : "");

export function CartePfc({ jeu, moi, pret, nom, onAction, portee, maintenant }) {
  const [choisi, setChoisi] = useState(null);  // manche pour laquelle je viens de cliquer (évite un double engagement avant le retour du serveur)
  const monMarque = jeu && marqueDe(jeu, moi);
  const ronde = (jeu && jeu.rondes[jeu.manche]) || { x: {}, o: {} };
  const moiCote = monMarque ? ronde[monMarque] : {};
  const autreCote = monMarque ? ronde[monMarque === "x" ? "o" : "x"] : {};
  const secret = jeu && monMarque ? secretPfc(portee, jeu.n, jeu.manche) : null;
  const depart = jeu && monMarque && maintenant ? departForfait(jeu, monMarque) : null;
  const resteForfait = useDecompteForfait(depart, maintenant);

  // Révélation automatique : dès que les deux empreintes sont publiées, je révèle mon coup et mon sel.
  const doitReveler = jeu && jeu.etat === "en_cours" && pret && monMarque && moiCote.h && autreCote.h && !moiCote.m && secret && secret.h === moiCote.h;
  useRevelationAuto(doitReveler ? `${jeu.n}:${jeu.manche}` : null, () => onAction({ a: "revele", c: jeu.n, r: jeu.manche, m: secret.m, x: secret.x }));

  if (!jeu) return <p className="texte supprime">Partie introuvable.</p>;
  const noms = joueursDe(jeu, nom);

  function sEngager(coup) {
    const sel = selAleatoire();
    const h = empreinte([...champsEngagementPfc(jeu.n, jeu.manche, monMarque), coup], sel);
    ecrireSecret(cleSecret("pfc", portee, jeu.n, jeu.manche), { m: coup, x: sel, h });
    setChoisi(jeu.manche);
    onAction({ a: "engage", c: jeu.n, r: jeu.manche, h });
  }

  let enCours;
  if (!monMarque) enCours = `Manche ${jeu.manche + 1} en cours`;
  else if (!moiCote.h) enCours = "Choisis ton coup : il reste caché tant que vous ne vous êtes pas tous les deux engagés.";
  else if (!autreCote.h) enCours = `Tu es engagé. En attente de l'engagement de ${monMarque === "x" ? noms.o : noms.x}…`;
  else enCours = "Les deux sont engagés : révélation…";
  const titre = titrePartie(jeu, noms, enCours, (g, n) => {
    if (g.motif === "forfait") return `${n[g.gagnant === "x" ? "o" : "x"]} n'a pas joué à temps (plus de ${DELAI_FORFAIT} s) : ${n[g.gagnant]} gagne par forfait.`;
    if (g.motif === "triche") return `${n[g.gagnant === "x" ? "o" : "x"]} a triché : sa révélation ne correspondait pas à son engagement. ${n[g.gagnant]} gagne.`;
    return null;
  });

  const secretPerdu = jeu.etat === "en_cours" && monMarque && moiCote.h && autreCote.h && !moiCote.m && (!secret || secret.h !== moiCote.h);
  const entete = jeu.etat !== "attente" && <p className="pfc-score" aria-label="Score">{noms.x} {jeu.points.x} – {jeu.points.o} {noms.o} <span className="note">(première à {MANCHES_GAGNANTES} manches)</span></p>;
  const actionsJeu = (
    <>
      {resteForfait !== null && resteForfait > 0 && <span className="note">Si {monMarque === "x" ? noms.o : noms.x} ne joue pas, forfait réclamable dans {resteForfait} s.</span>}
      {resteForfait !== null && resteForfait <= 0 && <button type="button" className="bouton petit" disabled={!pret} onClick={() => onAction({ a: "forfait", c: jeu.n, r: jeu.manche })}>Réclamer le forfait de {monMarque === "x" ? noms.o : noms.x}</button>}
    </>
  );
  return (
    <CadreJeu jeu={jeu} moi={moi} pret={pret} noms={noms} onAction={onAction} classe="pfc" icone="✊" nom="Pierre-feuille-ciseaux" titre={titre} entete={entete} actionsJeu={actionsJeu}>
      {jeu.etat === "en_cours" && monMarque && !moiCote.h && choisi !== jeu.manche && (
        <div className="pfc-coups" role="group" aria-label="Choisir ton coup">
          {Object.entries(COUPS_PFC).map(([c, d]) => (
            <button key={c} type="button" className="pfc-coup" disabled={!pret} onClick={() => sEngager(c)} aria-label={d.nom}><span aria-hidden="true">{d.icone}</span><small>{d.nom}</small></button>
          ))}
        </div>
      )}
      {secretPerdu && <p className="statut erreur" role="status">Ton coup secret est introuvable sur ce navigateur (stockage effacé ?) : tu ne peux plus le révéler. Abandonne la partie.</p>}
      {(jeu.manches.length > 0 || (jeu.etat === "en_cours" && (moiCote.h || autreCote.h))) && (
        <ol className="pfc-manches">
          {jeu.manches.map((m) => (
            <li key={m.manche}>
              Manche {m.manche + 1} : {COUPS_PFC[m.x].icone} {noms.x} · {COUPS_PFC[m.o].icone} {noms.o} →{" "}
              <strong>{m.gagnant === "nul" ? "égalité, on rejoue" : `${noms[m.gagnant]} gagne`}</strong>
              <span className="badge sur" title="Chaque révélation a été vérifiée contre l'empreinte SHA-256 publiée avant">empreintes vérifiées ✔</span>
            </li>
          ))}
          {jeu.etat === "en_cours" && (moiCote.h || autreCote.h) && (
            <li className="pfc-encours">
              Manche {jeu.manche + 1} : empreintes publiées —{" "}
              {noms.x} <code title={ronde.x.h || ""}>{ronde.x.h ? court(ronde.x.h) : "pas encore"}</code>,{" "}
              {noms.o} <code title={ronde.o.h || ""}>{ronde.o.h ? court(ronde.o.h) : "pas encore"}</code>
            </li>
          )}
        </ol>
      )}
    </CadreJeu>
  );
}

/* --- Puissance 4 ---------------------------------------------------------------------------------------------------------------
   Plateau de 7 colonnes sur 6 lignes : on choisit une colonne, le jeton tombe tout en bas. Chaque colonne est un seul bouton. */
export function CartePuissance4({ jeu, moi, pret, nom, onAction }) {
  if (!jeu) return <p className="texte supprime">Partie introuvable.</p>;
  const noms = joueursDe(jeu, nom);
  const monMarque = marqueDe(jeu, moi);
  const monTour = jeu.etat === "en_cours" && monMarque === jeu.tour;
  const titre = titrePartie(jeu, noms, monTour ? "À toi de jouer !" : `Tour de ${noms[jeu.tour]}`);
  const gagnantes = new Set(jeu.ligne || []);
  return (
    <CadreJeu jeu={jeu} moi={moi} pret={pret} noms={noms} onAction={onAction} classe="p4" icone="🔴" nom="Puissance 4" marques={{ x: "rouge", o: "jaune" }} titre={titre}>
      <div className="p4-plateau" role="group" aria-label="Plateau de Puissance 4">
        {Array.from({ length: COLONNES_P4 }, (_, c) => (
          <button key={c} type="button" className="p4-colonne" disabled={!pret || !monTour || caseDeChute(jeu.cases, c) < 0}
                  onClick={() => onAction({ a: "coup", c: jeu.n, i: c })} aria-label={`Colonne ${c + 1}${caseDeChute(jeu.cases, c) < 0 ? " (pleine)" : ""}`}>
            {Array.from({ length: LIGNES_P4 }, (_, l) => {
              const i = l * COLONNES_P4 + c;
              const v = jeu.cases[i];
              return <span key={l} className={`p4-disque${v ? ` ${v}` : ""}${gagnantes.has(i) ? " gagnant" : ""}${jeu.dernier === i ? " dernier" : ""}`} aria-hidden="true">{v === "x" ? "✕" : v === "o" ? "◯" : ""}</span>;
            })}
          </button>
        ))}
      </div>
    </CadreJeu>
  );
}

/* --- Bataille navale avec flotte engagée -----------------------------------------------------------------------------------------
   Ma flotte et mon sel restent dans CE navigateur (comme le coup du pierre-feuille-ciseaux) : seule l'empreinte SHA-256 est publiée avant la partie.
   Mon navigateur répond tout seul aux tirs de l'adversaire à partir de ma flotte secrète, puis la révèle à la fin pour la vérification. */
const cleBn = (portee, partie) => cleSecret("bn", portee, partie);
const secretBn = (portee, partie) => lireSecret(cleBn(portee, partie), (v) => flotteValide(v.m));
const coordonnee = (i) => `${String.fromCharCode(65 + (i % TAILLE_BN))}${Math.floor(i / TAILLE_BN) + 1}`;

function GrilleBn({ legende, cellule, onCase }) {
  return (
    <div className="bn-bloc">
      <p className="note">{legende}</p>
      <div className="grille-bn" role="grid" aria-label={legende}>
        {Array.from({ length: CASES_BN }, (_, i) => {
          const c = cellule(i);
          return (
            <button key={i} type="button" role="gridcell" className={`case-bn ${c.classe}`} disabled={!c.actif} onClick={() => onCase(i)}
                    aria-label={`${legende}, ${coordonnee(i)} : ${c.label}`}>{c.glyphe}</button>
          );
        })}
      </div>
    </div>
  );
}

export function CarteBatailleNavale({ jeu, moi, pret, nom, onAction, portee, maintenant }) {
  const [apercu, setApercu] = useState(() => flotteAleatoire());  // flotte proposée tant que je ne l'ai pas verrouillée
  const [probleme, setProbleme] = useState(null);
  const monMarque = jeu && marqueDe(jeu, moi);
  const autre = monMarque === "x" ? "o" : "x";
  const secret = jeu && monMarque ? secretBn(portee, jeu.n) : null;
  const monEngagement = jeu && monMarque ? jeu.engages[monMarque] : null;
  const secretOk = Boolean(secret && monEngagement && secret.h === monEngagement);
  const depart = jeu && monMarque && maintenant ? departForfaitBn(jeu, monMarque) : null;
  const resteForfait = useDecompteForfait(depart, maintenant);

  // Réponse automatique au tir de l'adversaire : touché (avec la lettre du navire) ou à l'eau, calculé depuis ma flotte secrète.
  const doitRepondre = jeu && jeu.etat === "en_cours" && jeu.phase === "tir" && jeu.attente && monMarque && jeu.attente.par !== monMarque && secretOk && pret;
  useRevelationAuto(doitRepondre ? `${jeu.n}:rep:${jeu.attente.s}` : null, () => {
    const cellule = secret.m[jeu.attente.i];
    onAction({ a: "reponse", c: jeu.n, i: jeu.attente.i, r: cellule === "." ? 0 : 1, ...(cellule === "." ? {} : { m: cellule }) });
  });
  // Vérification : quand toutes les cases d'une flotte sont touchées, chacun révèle sa flotte et son sel.
  const doitReveler = jeu && jeu.etat === "en_cours" && jeu.phase === "revelation" && monMarque && !jeu.reveles[monMarque] && secretOk && pret;
  useRevelationAuto(doitReveler ? `${jeu.n}:rev` : null, () => onAction({ a: "revele", c: jeu.n, f: secret.m, x: secret.x }));

  if (!jeu) return <p className="texte supprime">Partie introuvable.</p>;
  const noms = joueursDe(jeu, nom);

  function verrouiller() {
    let s = secret;  // déjà tirée lors d'une tentative précédente (l'engagement s'est perdu en route) : on la renvoie telle quelle
    if (!s) {
      const sel = selAleatoire();
      s = { m: apercu, x: sel, h: empreinte([jeu.n, monMarque, apercu], sel) };
      if (!ecrireSecret(cleBn(portee, jeu.n), s)) {
        setProbleme("Le stockage du navigateur est indisponible : ta flotte secrète ne pourrait pas être conservée jusqu'à la vérification.");
        return;
      }
    }
    setProbleme(null);
    onAction({ a: "engage", c: jeu.n, h: s.h });
  }

  const adversaireNom = noms[autre];
  const maFlotte = monMarque ? (secret ? secret.m : !monEngagement ? apercu : null) : null;
  const recus = new Map(reponsesDe(jeu, monMarque || "x").map((t) => [t.i, t]));
  const mesTirs = new Map(jeu.tirs.filter((t) => t.par === monMarque).map((t) => [t.i, t]));
  const subiAttente = jeu.attente && jeu.attente.par === autre ? jeu.attente.i : null;
  const tireAttente = jeu.attente && jeu.attente.par === monMarque ? jeu.attente.i : null;
  const flotteAdverse = monMarque ? jeu.reveles[autre] : null;  // révélée en fin de partie
  const peutTirer = jeu.etat === "en_cours" && jeu.phase === "tir" && jeu.tour === monMarque && !jeu.attente && pret;

  let enCours;
  if (!monMarque) enCours = jeu.phase === "placement" ? "Les joueurs placent leur flotte…" : jeu.phase === "tir" ? "Bataille en cours" : "Vérification des flottes…";
  else if (jeu.phase === "placement") enCours = !monEngagement ? "Place ta flotte (mélange-la si tu veux), puis verrouille-la : seule son empreinte est publiée." : `Flotte verrouillée. En attente de ${adversaireNom}…`;
  else if (jeu.phase === "revelation") enCours = "Une flotte est entièrement touchée : chacun révèle sa flotte pour que tout soit vérifié…";
  else if (jeu.attente) enCours = jeu.attente.par === monMarque ? `Tir en ${coordonnee(jeu.attente.i)} : en attente de la réponse de ${adversaireNom}…` : `${adversaireNom} tire en ${coordonnee(jeu.attente.i)} : réponse automatique…`;
  else enCours = jeu.tour === monMarque ? "À toi de tirer !" : `Tour de ${noms[jeu.tour]}`;
  const titre = titrePartie(jeu, noms, enCours, (g, n) => {
    const perdant = g.gagnant === "x" ? "o" : "x";
    if (g.motif === "forfait") return `${n[perdant]} n'a pas joué à temps (plus de ${DELAI_FORFAIT} s) : ${n[g.gagnant]} gagne par forfait.`;
    if (g.motif === "triche") return `${n[g.fraudeur || perdant]} a triché : ses réponses ne correspondaient pas à sa flotte engagée. ${n[g.gagnant]} gagne.`;
    if (g.motif === "coule") return `${n[g.gagnant]} a coulé toute la flotte de ${n[perdant]} !`;
    return null;
  });

  const entete = jeu.etat !== "attente" && jeu.phase !== "placement" && (
    <p className="pfc-score" aria-label="Navires coulés">
      {noms.x} a coulé {naviresCoules(jeu, "o").length}/{Object.keys(NAVIRES_BN).length} · {noms.o} a coulé {naviresCoules(jeu, "x").length}/{Object.keys(NAVIRES_BN).length}
      {jeu.etat === "fini" && jeu.motif === "coule" && <span className="badge sur" title="Chaque flotte révélée correspond à son empreinte SHA-256 et à toutes les réponses données">flottes vérifiées ✔</span>}
    </p>
  );
  const actionsJeu = (
    <>
      {resteForfait !== null && resteForfait > 0 && <span className="note">Si {adversaireNom} tarde trop, forfait réclamable dans {resteForfait} s.</span>}
      {resteForfait !== null && resteForfait <= 0 && <button type="button" className="bouton petit" disabled={!pret} onClick={() => onAction({ a: "forfait", c: jeu.n })}>Réclamer le forfait de {adversaireNom}</button>}
    </>
  );
  const secretPerdu = jeu.etat === "en_cours" && monMarque && monEngagement && !secretOk;
  return (
    <CadreJeu jeu={jeu} moi={moi} pret={pret} noms={noms} onAction={onAction} classe="bn" icone="🚢" nom="Bataille navale" titre={titre} entete={entete} actionsJeu={actionsJeu}>
      {secretPerdu && <p className="statut erreur" role="status">Ta flotte secrète est introuvable sur ce navigateur (stockage effacé ?) : tu ne peux plus répondre aux tirs. Abandonne la partie.</p>}
      {probleme && <p className="statut erreur" role="status">{probleme}</p>}
      {jeu.etat !== "attente" && monMarque && (
        <div className="bn-grilles">
          <GrilleBn legende="Ma flotte" onCase={() => {}} cellule={(i) => {
            const navire = maFlotte && maFlotte[i] !== ".";
            const t = recus.get(i);
            return {
              classe: [navire ? "navire" : "", t ? (t.r ? "touche" : "rate") : subiAttente === i ? "attente" : ""].join(" "),
              glyphe: t ? (t.r ? "✕" : "•") : subiAttente === i ? "…" : "",
              label: `${navire ? "navire" : "eau"}${t ? (t.r ? ", touché" : ", tir raté") : subiAttente === i ? ", tir en cours" : ""}`,
              actif: false,
            };
          }} />
          {jeu.phase !== "placement" && (
            <GrilleBn legende={`Flotte de ${adversaireNom}`} onCase={(i) => onAction({ a: "tir", c: jeu.n, i })} cellule={(i) => {
              const t = mesTirs.get(i);
              const revelee = flotteAdverse && flotteAdverse[i] !== ".";
              return {
                classe: t ? (t.r ? "touche" : "rate") : tireAttente === i ? "attente" : revelee ? "revelee" : "",
                glyphe: t ? (t.r ? "✕" : "•") : tireAttente === i ? "…" : "",
                label: t ? (t.r ? "touché" : "à l'eau") : tireAttente === i ? "tir en cours" : revelee ? "navire révélé" : "pas encore visée",
                actif: peutTirer && !t,
              };
            }} />
          )}
        </div>
      )}
      {jeu.etat === "en_cours" && monMarque && jeu.phase === "placement" && !monEngagement && (
        <div className="morpion-actions">
          <button type="button" className="bouton petit" disabled={!pret} onClick={verrouiller}>{secret ? "Renvoyer l'engagement" : "Verrouiller ma flotte"}</button>
          {!secret && <button type="button" className="bouton secondaire petit" onClick={() => setApercu(flotteAleatoire())}>Mélanger</button>}
        </div>
      )}
      {jeu.etat === "en_cours" && monMarque && monEngagement && jeu.phase === "placement" && <p className="note">Empreinte publiée : <code title={monEngagement}>{monEngagement.slice(0, 10)}…</code> (ta flotte, elle, reste ici)</p>}
    </CadreJeu>
  );
}

/* Carte de chaque jeu, par identifiant (le « j » des événements). Un jeu qu'une version plus récente connaîtrait et pas celle-ci
   s'affiche comme « non pris en charge » au lieu de casser la page. */
const CARTES = { morpion: CarteMorpion, pfc: CartePfc, p4: CartePuissance4, bn: CarteBatailleNavale };

export function CartePartie({ j, jeu, ...props }) {
  const Carte = Object.hasOwn(CARTES, j) ? CARTES[j] : null;
  if (!Carte) return <p className="texte supprime">Jeu non pris en charge par cette version.</p>;
  return <Carte jeu={jeu} {...props} />;
}
