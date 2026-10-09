import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const CLE_IGNOREE = "mc-maj-ignoree";   // version dont l'utilisateur a masqué la bannière (« Plus tard »)
const CLE_ANNONCEE = "mc-maj-annoncee"; // dernière version déjà signalée par une notification

const lire = (cle) => { try { return localStorage.getItem(cle) || ""; } catch { return ""; } };
const ecrire = (cle, valeur) => { try { if (valeur) localStorage.setItem(cle, valeur); else localStorage.removeItem(cle); } catch { /* stockage indisponible */ } };

// Suit l'état des mises à jour auprès du serveur Python. Quand le programme redémarre avec une
// nouvelle version, la page se recharge toute seule pour charger la nouvelle interface.
export function useMaj(surNouvelle) {
  const [maj, setMaj] = useState(null);
  const depart = useRef("");
  const rappel = useRef(surNouvelle);
  rappel.current = surNouvelle;

  const appliquer = useRef((m) => {
    if (!depart.current) depart.current = m.version;
    else if (m.version !== depart.current) { window.location.reload(); return; }
    if (m.etat === "disponible" && m.nouvelle_version && lire(CLE_ANNONCEE) !== m.nouvelle_version) {
      ecrire(CLE_ANNONCEE, m.nouvelle_version);
      if (rappel.current) rappel.current(m);
    }
    setMaj(m);
  }).current;

  const actions = useRef({
    verifier: () => api("/api/maj/verifier", { method: "POST", body: "{}" }).then((m) => { appliquer(m); return m; }),
    installer: () => api("/api/maj/installer", { method: "POST", body: "{}" }).then((m) => { appliquer(m); return m; }),
  }).current;

  useEffect(() => {
    const charger = () => api("/api/maj").then(appliquer).catch(() => {});
    charger();
    const id = setInterval(charger, 2500);
    return () => clearInterval(id);
  }, [appliquer]);

  return { maj, ...actions };
}

// Bannière : version disponible / téléchargement / redémarrage / erreur. Hors de ces cas :
// une simple ligne avec la version actuelle et un bouton « Rechercher une mise à jour ».
export default function BandeauMaj({ maj, verifier, installer }) {
  const [ignoree, setIgnoree] = useState(() => lire(CLE_IGNOREE));
  const [occupe, setOccupe] = useState(false);
  const [retour, setRetour] = useState("");
  if (!maj || !maj.configure) return null;

  const plusTard = () => { ecrire(CLE_IGNOREE, maj.nouvelle_version); setIgnoree(maj.nouvelle_version); };
  async function lancer() {
    setRetour("");
    setOccupe(true);
    try { await installer(); } catch (e) { setRetour(e.message); }
    setOccupe(false);
  }
  async function chercher() {
    setRetour("");
    setOccupe(true);
    try {
      const m = await verifier();
      if (m.erreur_verif) setRetour(m.erreur_verif);
      else if (m.etat === "disponible") { ecrire(CLE_IGNOREE, ""); setIgnoree(""); }
      else setRetour("Tu as la dernière version.");
    } catch (e) { setRetour(e.message); }
    setOccupe(false);
  }
  const lien = <a href={maj.page} target="_blank" rel="noreferrer">Voir la version</a>;

  if (maj.etat === "telechargement") {
    return (
      <div className="bandeau-maj" role="status">
        <span>⬇️ Téléchargement de la version {maj.nouvelle_version}… {maj.progression > 0 && `${maj.progression} %`}</span>
        <progress max="100" value={maj.progression} aria-label="Progression du téléchargement" />
      </div>
    );
  }
  if (maj.etat === "installation") {
    return (
      <div className="bandeau-maj" role="status">
        <span>♻️ Installation de la version {maj.nouvelle_version} : le programme redémarre et cette page se rechargera toute seule. Si ce n'est pas le cas dans une minute, rouvre {window.location.origin}.</span>
      </div>
    );
  }
  if (maj.etat === "erreur") {
    return (
      <div className="bandeau-maj erreur" role="alert">
        <span>⚠️ La mise à jour {maj.nouvelle_version} a échoué : {maj.erreur}</span>
        <span className="actions">
          {maj.installable && <button type="button" className="bouton petit" disabled={occupe} onClick={lancer}>Réessayer</button>}
          {lien}
        </span>
      </div>
    );
  }
  if (maj.etat === "disponible" && ignoree !== maj.nouvelle_version) {
    return (
      <div className="bandeau-maj" role="status">
        <span>
          🔔 <strong>Version {maj.nouvelle_version} disponible</strong> (tu as la {maj.version}).
          {maj.notes && <> {maj.notes}</>}
          {retour && <> <span className="statut erreur">{retour}</span></>}
        </span>
        <span className="actions">
          {maj.installable
            ? <button type="button" className="bouton petit" disabled={occupe} onClick={lancer}>Mettre à jour</button>
            : lien}
          <button type="button" className="lien" onClick={plusTard}>Plus tard</button>
        </span>
      </div>
    );
  }
  return (
    <p className="note ligne-version">
      Version {maj.version} ·{" "}
      <button type="button" className="lien" disabled={occupe} onClick={chercher}>Rechercher une mise à jour</button>
      {retour && <> · {retour}</>}
    </p>
  );
}
