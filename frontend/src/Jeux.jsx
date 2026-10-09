import { useEffect, useRef, useState } from "react";
import { COUPS_PFC, MANCHES_GAGNANTES, engagement } from "./salonEvenements.js";

/* Cartes de jeu partagées : salon de la salle et conversations privées. Elle ne connaît pas le transport :
   elle affiche une partie (voir salonEvenements.js) et rend les actions choisies via onAction. */
export function CarteMorpion({ jeu, moi, pret, nom, onAction }) {
  if (!jeu) return <p className="texte supprime">Partie introuvable.</p>;
  const joueurX = nom(jeu.x);
  const joueurO = jeu.o ? nom(jeu.o) : null;
  const monMarque = jeu.x.id === moi ? "x" : jeu.o && jeu.o.id === moi ? "o" : null;
  const monTour = jeu.etat === "en_cours" && monMarque === jeu.tour;
  let titre;
  if (jeu.etat === "attente") titre = `${joueurX} cherche un adversaire…`;
  else if (jeu.etat === "en_cours") titre = monTour ? "À toi de jouer !" : `Tour de ${jeu.tour === "x" ? joueurX : joueurO}`;
  else if (jeu.gagnant === "nul") titre = "Match nul";
  else if (jeu.gagnant === "annule") titre = "Défi annulé";
  else titre = `${jeu.gagnant === "x" ? joueurX : joueurO} gagne${jeu.abandon ? " (abandon)" : " !"}`;
  return (
    <div className="morpion">
      <strong>⭕ Morpion · {joueurX} (✕){joueurO ? ` contre ${joueurO} (◯)` : ""}</strong>
      <p className="morpion-titre" role="status">{titre}</p>
      <div className="grille-morpion" role="grid" aria-label="Grille de morpion">
        {jeu.cases.map((c, i) => (
          <button key={i} type="button" role="gridcell" className={`case${jeu.dernier === i ? " derniere" : ""}`}
                  disabled={!pret || !monTour || !!c} onClick={() => onAction({ a: "coup", c: jeu.n, i })}
                  aria-label={`Case ${i + 1} : ${c === "x" ? "croix" : c === "o" ? "rond" : "vide"}`}>
            {c === "x" ? "✕" : c === "o" ? "◯" : ""}
          </button>
        ))}
      </div>
      <div className="morpion-actions">
        {jeu.etat === "attente" && jeu.x.id !== moi && <button type="button" className="bouton petit" disabled={!pret} onClick={() => onAction({ a: "accepte", c: jeu.n })}>Relever le défi</button>}
        {jeu.etat === "attente" && jeu.x.id === moi && <button type="button" className="lien danger" onClick={() => onAction({ a: "abandon", c: jeu.n })}>Annuler le défi</button>}
        {jeu.etat === "en_cours" && monMarque && <button type="button" className="lien danger" onClick={() => onAction({ a: "abandon", c: jeu.n })}>Abandonner</button>}
        {jeu.etat === "fini" && <button type="button" className="bouton secondaire petit" disabled={!pret} onClick={() => onAction({ a: "defi" })}>Lancer un nouveau défi</button>}
      </div>
    </div>
  );
}


/* --- Pierre-feuille-ciseaux avec engagement ---------------------------------------------------------------------------------
   Mon coup et mon sel restent dans ce navigateur (localStorage) entre l'engagement et la révélation : sans eux, je ne pourrais pas
   révéler si la page est rechargée. Ils ne sont jamais envoyés avant la révélation, et seule l'empreinte SHA-256 circule d'abord. */
const cleSecret = (portee, partie, manche) => `mc-pfc:${portee}:${partie}:${manche}`;

function lireSecret(portee, partie, manche) {
  try {
    const v = JSON.parse(localStorage.getItem(cleSecret(portee, partie, manche)));
    return v && COUPS_PFC[v.m] && typeof v.x === "string" && typeof v.h === "string" ? v : null;
  } catch {
    return null;
  }
}

function ecrireSecret(portee, partie, manche, secret) {
  try {
    localStorage.setItem(cleSecret(portee, partie, manche), JSON.stringify(secret));
  } catch { /* stockage indisponible : la révélation automatique échouera, l'interface le signale */ }
}

function selAleatoire() {
  const octets = new Uint8Array(16);
  crypto.getRandomValues(octets);
  return [...octets].map((o) => o.toString(16).padStart(2, "0")).join("");
}

const court = (h) => (h ? `${h.slice(0, 10)}…` : "");

export function CartePfc({ jeu, moi, pret, nom, onAction, portee }) {
  const dernierEnvoi = useRef({});
  const [choisi, setChoisi] = useState(null);  // manche pour laquelle je viens de cliquer (évite un double engagement avant le retour du serveur)
  const monMarque = jeu && (jeu.x.id === moi ? "x" : jeu.o && jeu.o.id === moi ? "o" : null);
  const ronde = (jeu && jeu.rondes[jeu.manche]) || { x: {}, o: {} };
  const moiCote = monMarque ? ronde[monMarque] : {};
  const autreCote = monMarque ? ronde[monMarque === "x" ? "o" : "x"] : {};
  const secret = jeu && monMarque ? lireSecret(portee, jeu.n, jeu.manche) : null;

  // Révélation automatique : dès que les deux empreintes sont publiées, je révèle mon coup et mon sel (une seule tentative toutes les 8 s).
  useEffect(() => {
    if (!jeu || jeu.etat !== "en_cours" || !pret || !monMarque || !moiCote.h || !autreCote.h || moiCote.m) return;
    if (!secret || secret.h !== moiCote.h) return;
    const cle = `${jeu.n}:${jeu.manche}`;
    if (Date.now() - (dernierEnvoi.current[cle] || 0) < 8000) return;
    dernierEnvoi.current[cle] = Date.now();
    onAction({ a: "revele", c: jeu.n, r: jeu.manche, m: secret.m, x: secret.x });
  });

  if (!jeu) return <p className="texte supprime">Partie introuvable.</p>;
  const noms = { x: nom(jeu.x), o: jeu.o ? nom(jeu.o) : null };

  function sEngager(coup) {
    const sel = selAleatoire();
    const h = engagement(jeu.n, jeu.manche, coup, sel);
    ecrireSecret(portee, jeu.n, jeu.manche, { m: coup, x: sel, h });
    setChoisi(jeu.manche);
    onAction({ a: "engage", c: jeu.n, r: jeu.manche, h });
  }

  let titre;
  if (jeu.etat === "attente") titre = `${noms.x} cherche un adversaire…`;
  else if (jeu.etat === "en_cours") {
    if (!monMarque) titre = `Manche ${jeu.manche + 1} en cours`;
    else if (!moiCote.h) titre = "Choisis ton coup : il reste caché tant que vous ne vous êtes pas tous les deux engagés.";
    else if (!autreCote.h) titre = `Tu es engagé. En attente de l'engagement de ${monMarque === "x" ? noms.o : noms.x}…`;
    else titre = "Les deux sont engagés : révélation…";
  } else if (jeu.gagnant === "nul") titre = "Match nul";
  else if (jeu.gagnant === "annule") titre = "Défi annulé";
  else if (jeu.motif === "triche") titre = `${noms[jeu.gagnant === "x" ? "o" : "x"]} a triché : sa révélation ne correspondait pas à son engagement. ${noms[jeu.gagnant]} gagne.`;
  else titre = `${noms[jeu.gagnant]} gagne${jeu.abandon ? " (abandon)" : " !"}`;

  const secretPerdu = jeu.etat === "en_cours" && monMarque && moiCote.h && autreCote.h && !moiCote.m && (!secret || secret.h !== moiCote.h);
  return (
    <div className="pfc">
      <strong>✊ Pierre-feuille-ciseaux · {noms.x}{noms.o ? ` contre ${noms.o}` : ""}</strong>
      {jeu.etat !== "attente" && <p className="pfc-score" aria-label="Score">{noms.x} {jeu.points.x} – {jeu.points.o} {noms.o} <span className="note">(première à {MANCHES_GAGNANTES} manches)</span></p>}
      <p className="morpion-titre" role="status">{titre}</p>
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
      <div className="morpion-actions">
        {jeu.etat === "attente" && jeu.x.id !== moi && <button type="button" className="bouton petit" disabled={!pret} onClick={() => onAction({ a: "accepte", c: jeu.n })}>Relever le défi</button>}
        {jeu.etat === "attente" && jeu.x.id === moi && <button type="button" className="lien danger" onClick={() => onAction({ a: "abandon", c: jeu.n })}>Annuler le défi</button>}
        {jeu.etat === "en_cours" && monMarque && <button type="button" className="lien danger" onClick={() => onAction({ a: "abandon", c: jeu.n })}>Abandonner</button>}
        {jeu.etat === "fini" && <button type="button" className="bouton secondaire petit" disabled={!pret} onClick={() => onAction({ a: "defi" })}>Lancer un nouveau défi</button>}
      </div>
    </div>
  );
}
