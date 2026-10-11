import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ajouterFermees, estActive, partiesVisibles } from "./partiesZone.js";

/* Zone des parties d'une conversation privée. Réduite, c'est une barre d'une ligne sous les messages (la conversation garde toute la place) ;
   ouverte, la mise en page dépend de la largeur (voir styles.css) : panneau à droite des messages sur une fenêtre large, ou parties à la place
   des messages sur une fenêtre étroite. Jamais deux zones qui défilent l'une dans l'autre. Le parent est prévenu par onOuverture(vrai|faux)
   pour poser la classe « jeux-ouverts » sur le chat. Les parties terminées se ferment (✕) et ne reviennent plus sur ce navigateur,
   les anciennes sont rangées à part. rendre(g) affiche la carte d'une partie ; la zone ne connaît pas les jeux.
   À monter avec key={ip} : un état par conversation. */
const cleFermees = (ip) => `mc-parties-fermees:${ip}`;

function lireFermees(ip) {
  try {
    const v = JSON.parse(localStorage.getItem(cleFermees(ip)));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function ecrireFermees(ip, liste) {
  try {
    localStorage.setItem(cleFermees(ip), JSON.stringify(liste));
  } catch { /* stockage indisponible : les parties fermées reviendront au prochain chargement */ }
}

export default function ZoneParties({ parties, ip, rendre, onOuverture }) {
  const [fermees, setFermees] = useState(() => lireFermees(ip));
  const [reduite, setReduite] = useState(true);  // on n'ouvre pas tout seul une partie ancienne : seulement un nouveau défi (ci-dessous)
  const [toutVoir, setToutVoir] = useState(false);
  const connues = useRef(new Set(parties.map((g) => g.n)));

  // Un nouveau défi (le mien ou celui du contact) rouvre la zone réduite : on ne rate pas une invitation.
  useEffect(() => {
    const nouvelles = parties.filter((g) => !connues.current.has(g.n));
    if (!nouvelles.length) return;
    connues.current = new Set(parties.map((g) => g.n));
    if (nouvelles.some(estActive)) setReduite(false);
  }, [parties]);

  const { liste, actives, finies } = partiesVisibles(parties, fermees, toutVoir);
  const { cachees } = partiesVisibles(parties, fermees, false);  // anciennes parties rangées à part par défaut : le bouton reste là une fois qu'on les a affichées
  const visible = liste.length > 0 || cachees > 0;
  const ouverte = visible && !reduite;
  useLayoutEffect(() => {  // avant l'affichage : sinon une image montre la zone ouverte avec l'ancienne mise en page (messages écrasés)
    if (!onOuverture) return undefined;
    onOuverture(ouverte);
    return () => onOuverture(false);
  }, [ouverte, onOuverture]);
  if (!visible) return null;

  function fermer(ids) {
    const suite = ajouterFermees(fermees, ids, parties);
    setFermees(suite);
    ecrireFermees(ip, suite);
  }
  const resume = actives ? `${actives} en cours` : `${finies} terminée${finies > 1 ? "s" : ""}`;
  return (
    <section className={`parties-zone${reduite ? " reduite" : ""}`} aria-label="Parties avec ce contact">
      <div className="parties-entete">
        <button type="button" className="parties-bascule" aria-expanded={!reduite} onClick={() => setReduite((r) => !r)}
                title={reduite ? "Afficher les parties" : "Réduire les parties"}>
          <span aria-hidden="true">🎮</span> Parties <span className="badge">{resume}</span> <span aria-hidden="true">{reduite ? "▸" : "▾"}</span>
        </button>
        {!reduite && <button type="button" className="lien parties-retour" onClick={() => setReduite(true)}>💬 Revenir à la conversation</button>}
        {!reduite && cachees > 0 && <button type="button" className="lien" onClick={() => setToutVoir((v) => !v)}>{toutVoir ? "Masquer les anciennes" : `Anciennes parties (${cachees})`}</button>}
        {!reduite && finies > 0 && <button type="button" className="lien" onClick={() => fermer(parties.filter((g) => !estActive(g)).map((g) => g.n))}>Fermer les terminées</button>}
      </div>
      {!reduite && (
        <div className="parties-liste">
          {liste.map((g) => (
            <div key={g.n} className="bulle large partie">
              {rendre(g)}
              {!estActive(g) && <button type="button" className="lien parties-fermer" onClick={() => fermer([g.n])} aria-label="Fermer cette partie">✕ Fermer</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
