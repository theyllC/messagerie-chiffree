import { useCallback, useEffect, useId, useRef, useState } from "react";
import CommentCaMarche from "./CommentCaMarche.jsx";
import { api, post, erreur, ok, info } from "./api.js";
import Conversation from "./Conversation.jsx";
import Salle from "./Salle.jsx";
import BandeauMaj, { useMaj } from "./Maj.jsx";
import MesCles from "./MesCles.jsx";
import { CleExpediteur, ClesEnvoi, empreinteCourte } from "./ClesAffichage.jsx";
import { CubeRsa, FondChiffre, useMaterialisation } from "./Animations.jsx";
import { Avatar, ChampCle, ChoixFichier, Coches, Fichier, ProfilModal, Statut, bip, envoyerFichier, parCle, ecrireReglage, formatTaille, lireReglage, notifier } from "./composants.jsx";

/* Le texte passe du brouillé au lisible quand on déchiffre. */
function useReveal(cible) {
  const [texte, setTexte] = useState("");
  useEffect(() => {
    if (!cible) return setTexte("");
    const final = cible.valeur;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setTexte(final);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789#%@&*+=?";
    const pas = 24;
    let i = 0;
    const id = setInterval(() => {
      const fixe = Math.floor((final.length * i) / pas);
      setTexte(
        [...final]
          .map((ch, j) => (/\s/.test(ch) || j < fixe ? ch : alphabet[Math.floor(Math.random() * alphabet.length)]))
          .join("")
      );
      if (++i > pas) {
        clearInterval(id);
        setTexte(final);
      }
    }, 38);
    return () => clearInterval(id);
  }, [cible]);
  return texte;
}

/* Icônes des onglets (traits simples, héritent de la couleur du texte). */
const ICONES = {
  envoyer: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z",
  recevoir: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  historique: "M12 6v6l4 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  conversations: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  contacts: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  cles: "m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4",
  salle: "M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M10 21v-4h4v4",
  marche: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01",
};
const ONGLETS = [
  ["envoyer", "Envoyer"], ["recevoir", "Recevoir"], ["historique", "Historique"], ["conversations", "Conversations"],
  ["contacts", "Contacts"], ["salle", "Salle de classe"], ["cles", "Mes clés"], ["marche", "Comment ça marche"],
];

function Icone({ nom }) {
  return (
    <svg className="icone" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ICONES[nom]} />
    </svg>
  );
}

function Liaison({ gauche, droite, cePc, envoi }) {
  return (
    <div className="liaison" aria-hidden="true">
      <div className="piste">
        <span className={`noeud ${cePc === "gauche" ? "soi" : ""}`} />
        <span className="fil">{envoi > 0 && <span key={envoi} className="paquet" />}</span>
        <span className={`noeud ${cePc === "droite" ? "soi" : ""}`} />
      </div>
      <div className="noms">
        <span>{gauche}</span>
        <span>{droite}</span>
      </div>
    </div>
  );
}

function BlocChiffre({ titre, texte, vide, onCopie }) {
  const affiche = useMaterialisation(texte);
  return (
    <div className="champ">
      <div className="titre">
        <span>{titre}</span>
        {texte && (
          <button type="button" className="lien"
                  onClick={() => navigator.clipboard.writeText(texte).then(onCopie)}>
            Copier
          </button>
        )}
      </div>
      <pre className={`zone chiffre ${texte ? "" : "vide"}`}>{texte ? affiche : vide}</pre>
    </div>
  );
}

/* Envoi groupé : liste de contacts à cocher. Seuls ceux dont on a une clé (échangée ou importée) sont sélectionnables. */
function SelectionGroupe({ contacts, profils, echanges, selection, onChange }) {
  const ouvert = echanges.etat === "ouvert";
  const aUneCle = (ip) => ouvert && Boolean(echanges.cles[ip] || (echanges.importees || {})[ip]);
  const liste = Object.entries(contacts).sort(([ia, a], [ib, b]) => (a || ia).localeCompare(b || ib, "fr"));
  const eligibles = liste.filter(([ip]) => aUneCle(ip)).map(([ip]) => ip);
  const bascule = (ip) => onChange(selection.includes(ip) ? selection.filter((x) => x !== ip) : [...selection, ip]);
  return (
    <div className="champ">
      <div className="titre">
        <span>Destinataires ({selection.length} sélectionné{selection.length > 1 ? "s" : ""})</span>
        {eligibles.length > 0 && (
          <button type="button" className="lien" onClick={() => onChange(selection.length === eligibles.length ? [] : eligibles)}>
            {selection.length === eligibles.length ? "Tout décocher" : "Tout cocher"}
          </button>
        )}
      </div>
      {!ouvert && <p className="note">{echanges.etat === "absent" ? "Aucun coffre : crée-le" : "Coffre verrouillé : déverrouille-le"} dans l'onglet Contacts pour écrire à plusieurs contacts.</p>}
      {ouvert && liste.length === 0 && <p className="note">Ton carnet est vide : ajoute des contacts (onglet Contacts) et échange les clés avec eux.</p>}
      {liste.length > 0 && (
        <div className="liste-cases" role="group" aria-label="Destinataires">
          {liste.map(([ip, nom]) => {
            const permis = aUneCle(ip);
            return (
              <label key={ip} className={`case ${permis ? "" : "desactive"}`}
                     title={permis ? undefined : "Pas de clé pour ce contact : échange les clés ou importe sa clé publique."}>
                <input type="checkbox" disabled={!permis} checked={selection.includes(ip)} onChange={() => bascule(ip)} />
                <Avatar profil={profils[ip]} nom={nom || ip} petit />
                <span>{nom || ip}{profils[ip]?.pseudo && profils[ip].pseudo !== nom ? <span className="pseudo-distant"> · {profils[ip].pseudo}</span> : null} <span className="heure">({ip}){permis ? "" : " · pas de clé"}</span></span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Envoyer({ onEnvoye, contacts, profils, prefill, echanges, entrees }) {
  const [ip, setIp] = useState("");
  const [nomPc, setNomPc] = useState("");
  const [voisins, setVoisins] = useState([]);
  const [nomsPc, setNomsPc] = useState({});   // noms d'ordinateur des PC détectés
  const [recherche, setRecherche] = useState(false);
  const [message, setMessage] = useState("");
  const [chiffre, setChiffre] = useState("");
  const [statut, setStatut] = useState(null);
  const [envoi, setEnvoi] = useState(0);
  const [enCours, setEnCours] = useState(false);
  const [choixCle, setChoixCle] = useState("");  // clé choisie pour ce contact : "echangee" | "importee" ("" : la plus sûre disponible)
  const [dernierId, setDernierId] = useState(null);
  const [fichier, setFichier] = useState(null);   // pièce jointe choisie, envoyée avec le message
  const [groupe, setGroupe] = useState(false);    // false : un seul contact (IP) ; true : plusieurs contacts cochés
  const [selection, setSelection] = useState([]); // IP cochées en mode groupe
  const [resultats, setResultats] = useState(null); // résultat du dernier envoi groupé
  const idIp = useId();
  const idNom = useId();
  const idMsg = useId();
  // Clé échangée avec ce contact (disponible seulement coffre ouvert) : plus besoin de saisir de clé
  const cleContact = echanges.etat === "ouvert" ? echanges.cles[ip.trim()] : undefined;
  const cleImportee = echanges.etat === "ouvert" ? (echanges.importees || {})[ip.trim()] : undefined;
  // Clés disponibles pour ce contact. Rien à saisir : on choisit laquelle utiliser (l'échangée par défaut, plus complète).
  const disponibles = [cleContact && "echangee", cleImportee && "importee"].filter(Boolean);
  const typeCle = disponibles.includes(choixCle) ? choixCle : disponibles[0] || "";
  const rsaDirect = typeCle === "importee";  // clé publique importée, aucun échange réseau
  const sansCle = !typeCle;  // aucune clé pour ce contact
  const dernier = entrees.find((e) => e.id === dernierId);  // son statut évolue : envoyé, remis, lu

  // Détection des PC du réseau local (au démarrage, puis sur demande)
  const actualiserVoisins = useCallback(() => {
    setRecherche(true);
    api("/api/decouverte")
      .then((r) => { setVoisins(r.voisins); setNomsPc(r.noms || {}); })
      .catch(() => setVoisins([]))
      .finally(() => setRecherche(false));
  }, []);
  useEffect(actualiserVoisins, [actualiserVoisins]);

  // Destinataire choisi depuis l'onglet Contacts
  useEffect(() => {
    if (prefill) { setIp(prefill.ip); setNomPc(prefill.nom); setChoixCle(""); }
  }, [prefill]);

  // Choisir un PC (détecté ou saisi) : on reprend le nom du carnet s'il existe
  function choisirIp(valeur) {
    setIp(valeur);
    setChoixCle("");
    if (contacts[valeur.trim()]) setNomPc(contacts[valeur.trim()]);
  }

  async function envoyerGroupe() {
    if (echanges.etat !== "ouvert") return setStatut(erreur("Déverrouille le coffre (onglet Contacts) pour écrire à plusieurs contacts."));
    const cibles = selection.filter((a) => echanges.cles[a] || (echanges.importees || {})[a]);
    if (!cibles.length) return setStatut(erreur("Coche au moins un contact."));
    if (!message.trim()) return setStatut(erreur("Écris un message."));
    if (fichier) return setStatut(erreur("Les pièces jointes ne partent pas encore en envoi groupé : retire le fichier ou écris à un seul contact."));
    setEnCours(true);
    setResultats(null);
    setStatut(info(`Envoi à ${cibles.length} contact${cibles.length > 1 ? "s" : ""}…`));
    try {
      const r = await post("/api/envoyer-groupe", { destinataires: cibles, message });
      setResultats(r.envois);
      const n = (s) => r.envois.filter((e) => e.statut === s).length;
      if (n("ok") + n("attente") > 0) setEnvoi((x) => x + 1);
      const morceaux = [n("ok") && `${n("ok")} envoyé${n("ok") > 1 ? "s" : ""}`, n("attente") && `${n("attente")} en attente`, n("erreur") && `${n("erreur")} en erreur`].filter(Boolean);
      setStatut((n("erreur") ? erreur : n("attente") ? info : ok)(morceaux.join(", ") + "."));
      if (n("erreur") === 0) setMessage("");
      onEnvoye();
    } catch (e) {
      setStatut(erreur(e.message));
    } finally {
      setEnCours(false);
    }
  }

  async function envoyer(ev) {
    ev?.preventDefault();
    if (enCours) return;
    if (groupe) return envoyerGroupe();
    if (!ip.trim()) return setStatut(erreur("Indique l'adresse IP du PC 2 (127.0.0.1 pour tester sur ce PC)."));
    if (echanges.etat !== "ouvert") return setStatut(erreur("Déverrouille le coffre (onglet Contacts) : c'est lui qui garde les clés."));
    if (sansCle) return setStatut(erreur("Aucune clé pour ce contact : échange les clés (onglet Contacts) ou importe sa clé publique (onglet Mes clés)."));
    if (rsaDirect && fichier) return setStatut(erreur("Un fichier demande la clé échangée avec ce contact (onglet Contacts) : avec la clé publique importée, seuls les messages texte partent."));
    if (!message.trim() && !fichier) return setStatut(erreur("Écris un message ou joins un fichier."));
    setEnCours(true);
    setStatut(info("Envoi en cours…"));
    let fichierPart = false;
    let enAttente = false;  // destinataire hors ligne : le message attend dans la file d'attente
    try {
      // Le fichier part d'abord, puis le message : le destinataire les reçoit dans cet ordre.
      if (fichier) {
        const f = await envoyerFichier({ ip: ip.trim(), nom: nomPc.trim(), fichier, manuel: false, cle: "" });
        setDernierId(f.id);
        enAttente = f.statut === "attente";
        fichierPart = true;
        setFichier(null);
      }
      if (message.trim()) {
        const r = await post("/api/envoyer", { ip: ip.trim(), cle: "", message, nom: nomPc.trim(), contact_cle: typeCle === "echangee", rsa_direct: rsaDirect });
        setChiffre(r.chiffre);
        setDernierId(r.id);
        enAttente = enAttente || r.statut === "attente";
      }
      if (enAttente) {
        setStatut(info("Message en file d'attente : il sera envoyé dès que le PC sera joignable."));
        onEnvoye();
        return;
      }
      setEnvoi((n) => n + 1);
      setStatut(ok(fichier && message.trim() ? "Fichier et message envoyés au PC 2." : fichier ? "Fichier envoyé au PC 2." : "Message envoyé au PC 2."));
      onEnvoye();
    } catch (e) {
      setStatut(erreur(fichierPart ? `Le fichier est parti, mais pas le message : ${e.message}` : e.message));
      if (fichierPart) onEnvoye();
    } finally {
      setEnCours(false);
    }
  }

  return (
    <form onSubmit={envoyer} className="panneau grille">
      <Liaison gauche="PC 1 (ce PC)" droite={groupe ? `${selection.length} contact${selection.length > 1 ? "s" : ""}` : ip.trim() ? `PC 2 (${nomPc.trim() || ip.trim()})` : "PC 2"} cePc="gauche" envoi={envoi} />
      <fieldset className="groupe">
        <legend>Destinataire</legend>
      <div className="mode-envoi" role="group" aria-label="Nombre de destinataires">
        <button type="button" className={`bouton petit ${groupe ? "secondaire" : ""}`} aria-pressed={!groupe} onClick={() => setGroupe(false)}>Un contact</button>
        <button type="button" className={`bouton petit ${groupe ? "" : "secondaire"}`} aria-pressed={groupe} onClick={() => setGroupe(true)}>Plusieurs contacts</button>
      </div>
      {groupe ? (
        <SelectionGroupe contacts={contacts} profils={profils} echanges={echanges} selection={selection} onChange={setSelection} />
      ) : (<>
      <div className="duo">
        <div className="champ">
          <div className="titre"><label htmlFor={idIp}>Adresse IP du PC 2</label></div>
          <input id={idIp} value={ip} onChange={(e) => choisirIp(e.target.value)} inputMode="decimal" />
        </div>
        <div className="champ">
          <div className="titre"><label htmlFor={idNom}>Nom du PC (facultatif)</label></div>
          <input id={idNom} value={nomPc} onChange={(e) => setNomPc(e.target.value)} placeholder="Ex : PC de Koffi" />
        </div>
      </div>
      <div className="champ">
        <div className="titre">
          <span>PC détectés sur le réseau</span>
          <button type="button" className="lien" onClick={actualiserVoisins} disabled={recherche}>
            {recherche ? "Recherche…" : "Actualiser"}
          </button>
        </div>
        {voisins.length > 0 ? (
          <select value="" aria-label="PC détectés" onChange={(e) => e.target.value && choisirIp(e.target.value)}>
            <option value="">Sélectionner un PC</option>
            {voisins.map((adresse) => (
              <option key={adresse} value={adresse}>
                {contacts[adresse] ? `${contacts[adresse]} (${adresse})` : nomsPc[adresse] ? `${nomsPc[adresse]} (${adresse})` : adresse}
              </option>
            ))}
          </select>
        ) : (
          <p className="note">{recherche ? "Recherche en cours…" : "Aucun PC détecté sur le réseau local : saisis son adresse IP ci-dessus."}</p>
        )}
      </div>
      </>)}
      </fieldset>
      {!groupe && <ClesEnvoi echanges={echanges} ip={ip} onChange={onEnvoye} />}
      {groupe ? (
        <p className="note">Envoi groupé : chaque contact reçoit un message ordinaire, chiffré avec sa propre clé (clé échangée, sinon clé publique importée). Il ne sait pas que le message est envoyé à d'autres.</p>
      ) : (
      <fieldset className="groupe">
        <legend>Clé utilisée</legend>
      {echanges.etat !== "ouvert" ? (
        <p className="note">{echanges.etat === "absent" ? "Aucun coffre : crée-le" : "Coffre verrouillé : déverrouille-le"} dans l'onglet Contacts : il garde les clés avec lesquelles tu chiffres.</p>
      ) : !ip.trim() ? (
        <p className="note">Choisis un destinataire : tu verras ici les clés que tu as pour lui.</p>
      ) : sansCle ? (
        <p className="note">Aucune clé pour ce contact. Échange les clés dans l'onglet Contacts (ta clé publique part, la sienne revient), ou importe sa clé publique dans « Mes clés ».</p>
      ) : (
        <div className="choix-cle" role="radiogroup" aria-label="Clé à utiliser pour ce message">
          {cleContact && (
            <label className={`carte-cle${typeCle === "echangee" ? " choisie" : ""}`}>
              <input type="radio" name="cle-envoi" checked={typeCle === "echangee"} onChange={() => setChoixCle("echangee")} />
              <span className="contact-infos">
                <strong>Clé échangée avec {nomPc.trim() || contacts[ip.trim()] || ip.trim()}</strong>
                <span className="heure">
                  AES-256 partagée, transmise chiffrée en RSA{cleContact.empreinte ? ` · empreinte ${empreinteCourte(cleContact.empreinte)}` : ""} · {cleContact.verifie ? "code vérifié" : "code non vérifié"}
                </span>
                <span className="heure">Messages, fichiers, accusés de lecture.</span>
              </span>
            </label>
          )}
          {cleImportee && (
            <label className={`carte-cle${typeCle === "importee" ? " choisie" : ""}`}>
              <input type="radio" name="cle-envoi" checked={typeCle === "importee"} onChange={() => setChoixCle("importee")} />
              <span className="contact-infos">
                <strong>Clé publique RSA de {nomPc.trim() || contacts[ip.trim()] || ip.trim()}</strong>
                <span className="heure">RSA {cleImportee.bits} bits · empreinte {empreinteCourte(cleImportee.empreinte)}</span>
                <span className="heure">RSA direct : une clé AES jetable chiffrée avec cette clé publique. Messages texte seulement, pas d'accusé « lu ».</span>
              </span>
            </label>
          )}
        </div>
      )}
      </fieldset>
      )}
      <fieldset className="groupe">
        <legend>Contenu</legend>
      <div className="champ">
        <div className="titre"><label htmlFor={idMsg}>Message en clair</label><span className="heure">Ctrl + Entrée pour envoyer</span></div>
        <textarea id={idMsg} rows={5} value={message} onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.ctrlKey && e.key === "Enter" && envoyer()} />
      </div>
      {!groupe && <ChoixFichier fichier={fichier} onChange={setFichier} manuel={false} bloque={rsaDirect} />}
      </fieldset>
      <div className="action principale">
        <button type="submit" className="bouton" disabled={enCours}>
          {groupe ? `Chiffrer et envoyer à ${selection.length} contact${selection.length > 1 ? "s" : ""}`
            : fichier ? "Chiffrer et envoyer le fichier" + (message.trim() ? " + message" : "") : "Chiffrer et envoyer"}
        </button>
        <Statut statut={statut} />
        {!groupe && <Coches statut={dernier?.statut} />}
      </div>
      {groupe && resultats && (
        <ul className="resultats-groupe" aria-label="Résultat de l'envoi groupé">
          {resultats.map((e) => (
            <li key={e.ip} className={e.statut}>
              {e.statut === "ok" ? "✓" : e.statut === "attente" ? "🕐" : "✗"} {contacts[e.ip] || e.ip}
              {" "}({e.statut === "ok" ? "envoyé" : e.statut === "attente" ? "en attente : hors ligne" : e.message})
            </li>
          ))}
        </ul>
      )}
      {!groupe && <BlocChiffre titre="Message chiffré" texte={chiffre} vide="Le message chiffré apparaîtra ici."
                   onCopie={() => setStatut(ok("Message chiffré copié."))} />}
    </form>
  );
}

function Recevoir({ onRecu, echanges, contacts }) {
  const [monIp, setMonIp] = useState("…");
  const [recu, setRecu] = useState(null);  // dernier message reçu (v >= 2 : clé échangée, v = 1 : clé saisie)
  const [cle, setCle] = useState("");
  const [clair, setClair] = useState(null);
  const [fichier, setFichier] = useState(null);
  const [statut, setStatut] = useState(null);
  const [envoi, setEnvoi] = useState(0);
  const dernier = useRef(null);
  const affiche = useReveal(clair);
  const v = recu?.v ?? 1;
  const crypte = recu?.crypte ?? "";

  useEffect(() => {
    api("/api/ip").then((r) => setMonIp(r.ip)).catch((e) => setStatut(erreur(e.message)));
    api("/api/historique")
      .then((r) => { dernier.current = r.entrees.reduce((m, e) => Math.max(m, e.id), 0); })
      .catch(() => { dernier.current = 0; });
  }, []);

  useEffect(() => {
    const id = setInterval(async () => {
      if (dernier.current === null) return;
      try {
        const r = await api(`/api/recus?apres=${dernier.current}`);
        if (r.messages.length) {
          const m = r.messages[r.messages.length - 1];
          dernier.current = m.id;
          setRecu(m);
          setClair(null);
          setFichier(null);
          setEnvoi((n) => n + 1);
          setStatut(info(parCle(m.v) ? "Message reçu. Clique sur Déchiffrer." : "Message reçu. Saisis la clé, puis déchiffre."));
          onRecu(m);
        }
      } catch { /* le serveur redémarre : on réessaie au prochain tour */ }
    }, 1000);
    return () => clearInterval(id);
  }, [onRecu]);

  async function dechiffrer(ev) {
    ev.preventDefault();
    if (!recu) return setStatut(erreur("Aucun message reçu pour l'instant."));
    if (!parCle(v) && !cle) return setStatut(erreur("Saisis la clé utilisée par l'émetteur."));
    try {
      const r = await post("/api/dechiffrer", { id: recu.id, cle: parCle(v) ? "" : cle });
      setClair(r.fichier ? null : { valeur: r.clair });
      setFichier(r.fichier ?? null);
      setStatut(ok(r.fichier ? "Pièce jointe déchiffrée." : "Message déchiffré."));
    } catch (e) {
      setStatut(erreur(e.message));
    }
  }

  return (
    <form onSubmit={dechiffrer} className="panneau grille">
      <div className="carte-ip">
        <div>
          <p>Adresse de ce PC, à saisir dans l'émetteur</p>
          <strong>{monIp}</strong>
        </div>
        <button type="button" className="lien" onClick={() => navigator.clipboard.writeText(monIp).then(() => setStatut(ok("Adresse IP copiée.")))}>
          Copier
        </button>
      </div>
      <Liaison gauche="PC 1" droite="PC 2 (ce PC)" cePc="droite" envoi={envoi} />
      <BlocChiffre titre="Message chiffré reçu" texte={crypte}
                   vide={recu?.blob ? `Pièce jointe chiffrée (${formatTaille(recu.taille)}).`
                                    : "En attente d'un message. Donne l'adresse ci-dessus à l'émetteur."} />
      <CleExpediteur recu={recu} echanges={echanges} contacts={contacts} />
      {parCle(v) ? (
        <div className="action">
          <button type="submit" className="bouton">Déchiffrer</button>
          <p className="note">Chiffré avec la clé échangée : aucune clé à saisir (coffre déverrouillé).</p>
        </div>
      ) : (
        <div className="duo cle-bouton">
          <ChampCle valeur={cle} onChange={setCle} />
          <button type="submit" className="bouton">Déchiffrer</button>
        </div>
      )}
      <Statut statut={statut} />
      <div className="champ">
        <div className="titre"><span>Message en clair</span></div>
        <div className={`zone clair ${affiche ? "" : "vide"}`} aria-live="polite">
          {affiche || "Le message déchiffré s'affichera ici."}
        </div>
      </div>
      {fichier && <Fichier f={fichier} />}
    </form>
  );
}

/* Un contact de la salle a pour adresse « relais:<id> » : on affiche « via la salle de classe » plutôt que cet identifiant. */
const libelleAdresse = (adresse) => (adresse.startsWith("relais:") ? "via la salle de classe" : adresse);

const pad = (n) => String(n).padStart(2, "0");
const jourIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function libelleJour(jour) {
  const hier = new Date();
  hier.setDate(hier.getDate() - 1);
  if (jour === jourIso(new Date())) return "Aujourd'hui";
  if (jour === jourIso(hier)) return "Hier";
  const t = new Date(`${jour}T00:00:00`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function Entree({ e, contacts }) {
  const [ouvert, setOuvert] = useState(false);
  const [cle, setCle] = useState("");
  const [clair, setClair] = useState(null);
  const [message, setMessage] = useState(null); // { type, texte } ou null
  const [fichier, setFichier] = useState(null);
  const affiche = useReveal(clair);
  const recu = e.sens === "recu";
  const v2 = parCle(e.v);  // chiffré avec une clé échangée : le coffre fournit la clé

  // Aperçu : 20 premiers caractères du chiffré + "..." (jamais le texte en clair)
  const apercu = e.blob
    ? `Pièce jointe chiffrée (${formatTaille(e.taille)})`
    : e.crypte ? `${e.crypte.substring(0, 20)}${e.crypte.length > 20 ? "..." : ""}` : "";

  // Afficher le nom du contact si disponible, sinon l'IP
  const paireAffichee = contacts[e.pair] ? contacts[e.pair] : e.pair;

  function basculer() {
    if (ouvert) { setCle(""); setClair(null); setFichier(null); setMessage(null); } // le texte en clair n'est jamais gardé
    setOuvert(!ouvert);
  }

  async function relire(ev) {
    ev.preventDefault();
    if (!v2 && !cle) return setMessage(erreur("Saisis la clé de ce message."));
    try {
      const r = await post("/api/dechiffrer", { id: e.id, cle: v2 ? "" : cle });
      setClair(r.fichier ? null : { valeur: r.clair });
      setFichier(r.fichier ?? null);
      setMessage(null);
    } catch (err) {
      setClair(null);
      setFichier(null);
      setMessage(erreur(err.message));
    }
  }

  function copier() {
    navigator.clipboard.writeText(e.crypte)
      .then(() => setMessage(ok("Message chiffré copié.")))
      .catch(() => setMessage(erreur("Copie impossible : sélectionne le texte à la main.")));
  }

  return (
    <li className={`entree ${recu ? "recu" : "envoye"}`}>
      <button type="button" className="entree-tete" aria-expanded={ouvert} onClick={basculer}>
        <span>{recu ? "Reçu de" : "Envoyé à"} <strong>{paireAffichee}</strong>{v2 && <span className="etiquette">{e.v === 3 ? "pièce jointe" : e.v === 5 ? "RSA direct" : "clé échangée"}</span>}{e.v === 4 && <span className="etiquette">pièce jointe</span>}</span>
        <span className="heure">{e.heure.slice(11, 16)} {!recu && <Coches statut={e.statut} />}</span>
      </button>
      {!ouvert && <pre className="apercu">{apercu}</pre>}
      {ouvert && (
        <div className="detail">
          <pre className="zone chiffre">{e.blob ? `Pièce jointe chiffrée (${formatTaille(e.taille)}) : contenu rangé à part.` : e.crypte}</pre>
          {e.v === 5 && !recu ? (
            <p className="note">Message en RSA direct : seul le destinataire peut le déchiffrer (avec sa clé privée). Toi non plus, c'est normal.</p>
          ) : (
            <form onSubmit={relire} className={v2 ? "action" : "duo cle-bouton"}>
              {!v2 && <ChampCle valeur={cle} onChange={setCle} />}
              <button type="submit" className="bouton">Relire</button>
            </form>
          )}
          {/* Bouton copier le message chiffré dans le presse-papiers */}
          {!e.blob && <button type="button" className="lien" onClick={copier}>Copier le chiffré</button>}
          {message && <Statut statut={message} />}
          {clair && <div className="zone clair" aria-live="polite">{affiche}</div>}
          {fichier && <Fichier f={fichier} />}
        </div>
      )}
    </li>
  );
}

const DUREES = [[0, "Jamais"], [1, "1 jour"], [7, "7 jours"], [30, "30 jours"], [90, "90 jours"], [365, "1 an"]];

function Historique({ entrees, contacts, onVider, onRafraichir }) {
  const [filtre, setFiltre] = useState("tous");
  const [confirmer, setConfirmer] = useState(false);
  const [jours, setJours] = useState(0);
  const [statutRetention, setStatutRetention] = useState(null);
  const idRetention = useId();
  useEffect(() => {
    api("/api/parametres").then((r) => setJours(r.retention_jours)).catch(() => {});
  }, []);

  async function changerRetention(valeur) {
    try {
      const r = await post("/api/parametres", { retention_jours: valeur });
      setJours(r.retention_jours);
      setStatutRetention(ok(valeur ? `Les messages de plus de ${valeur} jour(s) sont effacés automatiquement.` : "Aucun effacement automatique."));
      onRafraichir();
    } catch (err) {
      setStatutRetention(erreur(err.message));
    }
  }
  const durees = DUREES.some(([d]) => d === jours) ? DUREES : [...DUREES, [jours, `${jours} jours`]];
  const nb = (sens) => entrees.filter((e) => e.sens === sens).length;
  const filtres = [
    ["tous", `Tous (${entrees.length})`],
    ["recu", `Reçus (${nb("recu")})`],
    ["envoye", `Envoyés (${nb("envoye")})`],
  ];
  const liste = entrees.filter((e) => filtre === "tous" || e.sens === filtre).reverse();
  const groupes = [];
  for (const e of liste) {
    const jour = e.heure.slice(0, 10);
    if (!groupes.length || groupes[groupes.length - 1].jour !== jour) groupes.push({ jour, items: [] });
    groupes[groupes.length - 1].items.push(e);
  }

  return (
    <div className="panneau">
      <p className="note">
        Seuls les messages chiffrés sont conservés, sur ce PC. Pour relire un message, saisis sa clé :
        le texte en clair n'est jamais enregistré.
      </p>
      <div className="champ">
        <div className="titre"><label htmlFor={idRetention}>Effacer automatiquement les messages après</label></div>
        <select id={idRetention} value={jours} onChange={(ev) => changerRetention(Number(ev.target.value))}>
          {durees.map(([d, libelle]) => <option key={d} value={d}>{libelle}</option>)}
        </select>
        {statutRetention && <Statut statut={statutRetention} />}
      </div>
      <div className="filtres">
        {filtres.map(([valeur, libelle]) => (
          <button key={valeur} type="button" aria-pressed={filtre === valeur} onClick={() => setFiltre(valeur)}>
            {libelle}
          </button>
        ))}
      </div>
      {groupes.length === 0 && (
        <div className="etat-vide">
          <strong>Aucun message pour l'instant</strong>
          <p className="note">Les messages et fichiers que tu envoies et reçois apparaîtront ici. Commence par l'onglet Envoyer.</p>
        </div>
      )}
      {groupes.map((g) => (
        <section key={g.jour}>
          <h2 className="jour">{libelleJour(g.jour)}</h2>
          <ul className="entrees">{g.items.map((e) => <Entree key={e.id} e={e} contacts={contacts} />)}</ul>
        </section>
      ))}
      {entrees.length > 0 && (
        <div className="vider">
          {!confirmer ? (
            <button type="button" className="lien" onClick={() => setConfirmer(true)}>Effacer l'historique</button>
          ) : (
            <>
              <span>Effacer tous les messages de cet historique ?</span>
              <button type="button" className="lien danger" onClick={() => { onVider(); setConfirmer(false); }}>Effacer définitivement</button>
              <button type="button" className="lien" onClick={() => setConfirmer(false)}>Annuler</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PanneauCoffre({ etat, onChange }) {
  const [mdp, setMdp] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [statut, setStatut] = useState(null);
  const [reinit, setReinit] = useState(false);
  const idMdp = useId();
  const idConf = useId();

  async function agir(promesse) {
    try {
      await promesse;
      setMdp(""); setConfirmation(""); setStatut(null); setReinit(false);
      onChange();
    } catch (e) {
      setStatut(erreur(e.message));
    }
  }

  function creer(ev) {
    ev.preventDefault();
    if (mdp !== confirmation) return setStatut(erreur("Les deux mots de passe sont différents."));
    { setStatut(info("Génération de la clé RSA-3072… quelques secondes.")); agir(post("/api/coffre/creer", { mdp })); }
  }

  function ouvrir(ev) {
    ev.preventDefault();
    { setStatut(info("Ouverture du coffre… (migration éventuelle vers le RSA, quelques secondes)")); agir(post("/api/coffre/ouvrir", { mdp })); }
  }

  if (etat === "ouvert") {
    return (
      <div className="carte-ip">
        <div>
          <p>Coffre de clés</p>
          <strong className="petit">Déverrouillé</strong>
        </div>
        <button type="button" className="lien" onClick={() => agir(post("/api/coffre/verrouiller", {}))}>Verrouiller</button>
      </div>
    );
  }

  if (etat === "absent") {
    return (
      <form onSubmit={creer} className="panneau encadre">
        <p className="note">
          Le coffre garde sur ce PC les clés échangées avec tes contacts, chiffrées par un mot de passe.
          Avec elles, plus besoin de retaper une clé à chaque message. Choisis un mot de passe que tu n'oublieras pas :
          il ne peut pas être récupéré.
        </p>
        <div className="duo">
          <div className="champ">
            <div className="titre"><label htmlFor={idMdp}>Mot de passe du coffre</label></div>
            <input id={idMdp} type="password" value={mdp} autoComplete="new-password" onChange={(e) => setMdp(e.target.value)} />
          </div>
          <div className="champ">
            <div className="titre"><label htmlFor={idConf}>Confirmation</label></div>
            <input id={idConf} type="password" value={confirmation} autoComplete="new-password" onChange={(e) => setConfirmation(e.target.value)} />
          </div>
        </div>
        <div className="action">
          <button type="submit" className="bouton">Créer le coffre</button>
          <Statut statut={statut} />
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={ouvrir} className="panneau encadre">
      <div className="duo cle-bouton">
        <div className="champ">
          <div className="titre"><label htmlFor={idMdp}>Coffre verrouillé : mot de passe</label></div>
          <input id={idMdp} type="password" value={mdp} autoComplete="current-password" onChange={(e) => setMdp(e.target.value)} />
        </div>
        <button type="submit" className="bouton">Déverrouiller</button>
      </div>
      <Statut statut={statut} />
      <div className="vider">
        {!reinit ? (
          <button type="button" className="lien" onClick={() => setReinit(true)}>Mot de passe oublié ?</button>
        ) : (
          <>
            <span>Réinitialiser supprime toutes les clés échangées : il faudra les échanger de nouveau.</span>
            <button type="button" className="lien danger" onClick={() => agir(post("/api/coffre/reinitialiser", {}))}>Réinitialiser le coffre</button>
            <button type="button" className="lien" onClick={() => setReinit(false)}>Annuler</button>
          </>
        )}
      </div>
    </form>
  );
}

/* Les différentes clés, en clair : ce qui reste sur ce PC et ce qui est partagé. */
function Contacts({ contacts, profils, echanges, actif, onChange, onEcrire, onConversation }) {
  const [ip, setIp] = useState("");
  const [nom, setNom] = useState("");
  const [enLigne, setEnLigne] = useState({});   // {ip: true/false}
  const [verif, setVerif] = useState(false);
  const [edition, setEdition] = useState(null);  // { ip, nom } en cours de renommage
  const [confirmer, setConfirmer] = useState(false);
  const [statut, setStatut] = useState(null);
  const [voisins, setVoisins] = useState(null);   // PC détectés sur le réseau (null = pas encore cherché)
  const [noms, setNoms] = useState({});            // nom saisi pour chaque PC détecté
  const [recherche, setRecherche] = useState(false);
  const [nomsDetectes, setNomsDetectes] = useState({});  // noms d'ordinateur renvoyés par la détection
  const idIp = useId();
  const idNom = useId();
  const ouvert = echanges.etat === "ouvert";

  function chercher() {
    setRecherche(true);
    api("/api/decouverte")
      .then((r) => { setVoisins(r.voisins); setNomsDetectes(r.noms || {}); })
      .catch((e) => { setVoisins([]); setStatut(erreur(e.message)); })
      .finally(() => setRecherche(false));
  }
  async function ajouterVoisin(adresse) {
    const n = (noms[adresse] ?? nomsDetectes[adresse] ?? "").trim();
    if (!n) return setStatut(erreur("Donne un nom à ce PC avant de l'ajouter."));
    try {
      await post("/api/contacts", { ip: adresse, name: n });
      onChange();
      setStatut(ok(`${n} ajouté au carnet.`));
    } catch (e) {
      setStatut(erreur(e.message));
    }
  }

  // Les PC dont on a une clé ou une demande apparaissent même sans nom dans le carnet
  const liste = Object.entries(contacts).sort(([ia, a], [ib, b]) => (a || ia).localeCompare(b || ib, "fr"));

  const verifier = useCallback(() => {
    setVerif(true);
    api("/api/statut-contacts")
      .then((r) => setEnLigne(r.statuts))
      .catch(() => {})
      .finally(() => setVerif(false));
  }, []);
  // Vérifie qui est en ligne à l'ouverture de l'onglet et quand la liste change
  const nbContacts = liste.length;
  useEffect(() => { if (actif && nbContacts) verifier(); }, [actif, nbContacts, verifier]);

  async function agir(promesse, message) {
    try {
      await promesse;
      onChange();
      if (message) setStatut(ok(message));
    } catch (e) {
      setStatut(erreur(e.message));
    }
  }

  function ajouter(ev) {
    ev.preventDefault();
    if (!ip.trim()) return setStatut(erreur("Indique l'adresse IP du contact."));
    if (!nom.trim()) return setStatut(erreur("Donne un nom au contact."));
    agir(post("/api/contacts", { ip: ip.trim(), name: nom.trim() }), "Contact enregistré.");
    setIp(""); setNom("");
  }

  function valider(ev) {
    ev.preventDefault();
    if (!edition.nom.trim()) return setStatut(erreur("Le nom ne peut pas être vide."));
    agir(post("/api/renommer-contact", { ip: edition.ip, name: edition.nom }), "Contact renommé.");
    setEdition(null);
  }

  return (
    <div className="panneau">
      <PanneauCoffre etat={echanges.etat} onChange={onChange} />
      <p className="note">Tes clés (empreinte, export .pem, import de la clé d'un contact) sont dans l'onglet « Mes clés ».</p>

      {echanges.demandes.length > 0 && (
        <div className="panneau encadre">
          <div className="titre"><span>Demandes d'échange de clés ({echanges.demandes.length})</span></div>
          {echanges.demandes.map((d) => (
            <div key={d.ip} className="demande">
              <div className="contact-infos">
                <strong>{contacts[d.ip] || profils[d.ip]?.pseudo || d.ip}</strong>
                <span className="heure">{libelleAdresse(d.ip)} · {d.heure.slice(11, 16)}</span>
                {d.code
                  ? <span className="code">Code de sécurité : {d.code}</span>
                  : <span className="heure">Déverrouille le coffre pour accepter et voir le code de sécurité.</span>}
              </div>
              <div className="contact-actions">
                <button type="button" className="lien" disabled={!ouvert}
                        onClick={() => agir(post("/api/echange/accepter", { ip: d.ip }), "Clés échangées. Compare le code de sécurité avec ton contact.")}>
                  Accepter
                </button>
                <button type="button" className="lien danger" onClick={() => agir(post("/api/echange/refuser", { ip: d.ip }))}>Refuser</button>
              </div>
            </div>
          ))}
          <p className="note">N'accepte que si tu connais ce PC : sinon, refuse.</p>
        </div>
      )}

      <form onSubmit={ajouter} className="duo ajout">
        <div className="champ">
          <div className="titre"><label htmlFor={idNom}>Nom</label></div>
          <input id={idNom} value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Ex : PC de Koffi" />
        </div>
        <div className="champ">
          <div className="titre"><label htmlFor={idIp}>Adresse IP</label></div>
          <input id={idIp} value={ip} onChange={(e) => setIp(e.target.value)} inputMode="decimal" placeholder="192.168.1.20" />
        </div>
        <button type="submit" className="bouton">Ajouter</button>
      </form>
      <Statut statut={statut} />

      <div className="panneau encadre">
        <div className="titre">
          <span>PC détectés sur ton réseau</span>
          <button type="button" className="lien" onClick={chercher} disabled={recherche}>
            {recherche ? "Recherche…" : "Détecter les PC du réseau"}
          </button>
        </div>
        {voisins === null && <p className="note">Cherche les PC du même réseau où ce programme est ouvert, puis ajoute-les au carnet.</p>}
        {voisins !== null && !recherche && voisins.filter((v) => !contacts[v]).length === 0 && (
          <p className="note">Aucun nouveau PC trouvé. Le programme doit être ouvert sur l'autre PC, sur le même réseau (le pare-feu doit autoriser le port 5000).</p>
        )}
        {(voisins || []).filter((v) => !contacts[v]).map((v) => (
          <div key={v} className="demande">
            <div className="contact-infos"><strong>{v}</strong><span className="heure">en ligne</span></div>
            <div className="contact-actions">
              <input aria-label={`Nom du PC ${v}`} value={noms[v] ?? nomsDetectes[v] ?? ""} placeholder="Nom du contact"
                     onChange={(e) => setNoms({ ...noms, [v]: e.target.value })}
                     onKeyDown={(e) => e.key === "Enter" && ajouterVoisin(v)} />
              <button type="button" className="lien" onClick={() => ajouterVoisin(v)}>Ajouter</button>
            </div>
          </div>
        ))}
      </div>

      <div className="titre">
        <span>Mes contacts ({liste.length})</span>
        <button type="button" className="lien" onClick={verifier} disabled={verif || !liste.length}>
          {verif ? "Vérification…" : "Vérifier qui est en ligne"}
        </button>
      </div>

      {liste.length === 0 && (
        <div className="etat-vide">
          <strong>Ton carnet est vide</strong>
          <p className="note">Ajoute un contact ci-dessus, détecte les PC du réseau, ou saisis un nom quand tu envoies un message : il sera enregistré tout seul.</p>
        </div>
      )}

      <ul className="entrees">
        {liste.map(([adresse, nomContact]) => {
          const etat = enLigne[adresse];
          const cle = echanges.cles[adresse];
          const attente = echanges.sortants.includes(adresse);
          return (
            <li key={adresse} className="contact">
              {edition?.ip === adresse ? (
                <form onSubmit={valider} className="contact-edition">
                  <input value={edition.nom} autoFocus aria-label="Nouveau nom"
                         onChange={(e) => setEdition({ ip: adresse, nom: e.target.value })} />
                  <button type="submit" className="bouton petit">Valider</button>
                  <button type="button" className="bouton secondaire petit" onClick={() => setEdition(null)}>Annuler</button>
                </form>
              ) : (
                <>
                  <div className="contact-tete">
                    <Avatar profil={profils[adresse]} nom={nomContact || adresse} />
                    <div className="contact-infos">
                      <strong>{nomContact || adresse}{profils[adresse]?.pseudo && profils[adresse].pseudo !== nomContact ? <span className="pseudo-distant"> · {profils[adresse].pseudo}</span> : null}</strong>
                      <span className="heure ligne-statut">
                        <span className={`point ${etat === undefined ? "" : etat ? "on" : "off"}`} aria-hidden="true" />
                        {etat === undefined ? "statut inconnu" : etat ? "en ligne" : "hors ligne"} · {libelleAdresse(adresse)}
                      </span>
                    </div>
                    <div className="contact-actions">
                      <button type="button" className="bouton petit" onClick={() => onConversation(adresse)}>Conversation</button>
                      <button type="button" className="bouton secondaire petit" onClick={() => onEcrire(adresse, nomContact)}>Écrire</button>
                    </div>
                  </div>
                  {cle && (
                    <div className="contact-cle">
                      <span className={`badge ${cle.algo === "x25519" ? "alerte" : cle.verifie ? "sur" : ""}`}>
                        {cle.algo === "x25519" ? "Ancien format" : cle.verifie ? "Clé vérifiée" : "Clé à vérifier"}
                      </span>
                      <span className="code" title="Code de sécurité : à comparer avec ton contact">{cle.code}</span>
                      <label className="case">
                        <input type="checkbox" checked={cle.verifie}
                               onChange={(e) => agir(post("/api/cle/verifier", { ip: adresse, verifie: e.target.checked }))} />
                        J'ai comparé ce code avec mon contact
                      </label>
                    </div>
                  )}
                  {cle && cle.algo === "x25519" && <p className="note">Ancien format de clé (X25519) : renouvelle-la avec « Passer au RSA ». Les anciens messages restent lisibles.</p>}
                  {attente && <p className="note">Demande envoyée, en attente de sa réponse…</p>}
                  <div className="contact-pied">
                    {(!cle || cle.algo === "x25519") && !attente && ouvert && (
                      <button type="button" className="bouton secondaire petit"
                              onClick={() => agir(post("/api/echange/demarrer", { ip: adresse }), "Demande envoyée : ton contact doit l'accepter.")}>
                        {cle ? "Passer au RSA" : "Échanger les clés"}
                      </button>
                    )}
                    {!cle && !attente && !ouvert && <span className="note">Déverrouille le coffre pour échanger les clés.</span>}
                    <details className="plus">
                      <summary>Gérer</summary>
                      <div className="plus-corps">
                        <button type="button" className="lien" onClick={() => setEdition({ ip: adresse, nom: nomContact })}>Renommer</button>
                        {cle && (
                          <button type="button" className="lien danger"
                                  onClick={() => agir(post("/api/cle/revoquer", { ip: adresse }), "Clé révoquée.")}>
                            Révoquer la clé
                          </button>
                        )}
                        <button type="button" className="lien danger"
                                onClick={() => agir(post("/api/supprimer-contact", { ip: adresse }), "Contact supprimé.")}>
                          Supprimer le contact
                        </button>
                      </div>
                    </details>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {liste.length > 0 && (
        <div className="vider">
          {!confirmer ? (
            <button type="button" className="lien" onClick={() => setConfirmer(true)}>Vider le carnet</button>
          ) : (
            <>
              <span>Supprimer tous les contacts (et leurs clés si le coffre est ouvert) ?</span>
              <button type="button" className="lien danger"
                      onClick={() => { agir(post("/api/vider-contacts", {}), "Carnet vidé."); setConfirmer(false); }}>
                Supprimer définitivement
              </button>
              <button type="button" className="lien" onClick={() => setConfirmer(false)}>Annuler</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const THEMES = [["auto", "Thème : auto"], ["clair", "Thème : clair"], ["sombre", "Thème : sombre"]];

function lireTheme() {
  try { const t = localStorage.getItem("mc-theme"); return THEMES.some(([n]) => n === t) ? t : "auto"; } catch { return "auto"; }
}

function appliquerTheme(theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
appliquerTheme(lireTheme());

export default function App() {
  const [theme, setTheme] = useState(lireTheme);
  const [onglet, setOnglet] = useState("envoyer");
  const [nouveau, setNouveau] = useState(false);
  const [entrees, setEntrees] = useState([]);
  const [contacts, setContacts] = useState({});
  const [profils, setProfils] = useState({});      // pseudo + avatar des contacts {ip: {pseudo, avatar}}
  const [monProfil, setMonProfil] = useState({ pseudo: "", avatar: "" });
  const [profilOuvert, setProfilOuvert] = useState(false);
  const [fileAttente, setFileAttente] = useState([]);  // messages en attente d'un destinataire hors ligne
  const [prefill, setPrefill] = useState(null);
  const [choixConversation, setChoixConversation] = useState(null);
  const [notifs, setNotifs] = useState(() => lireReglage("mc-notifs"));
  const [echanges, setEchanges] = useState({ etat: "absent", cles: {}, demandes: [], sortants: [] });
  const ongletRef = useRef(onglet);
  ongletRef.current = onglet;
  const notifsRef = useRef(notifs);
  notifsRef.current = notifs;
  // Mises à jour : bannière + notification (même réglage que les messages) quand une nouvelle version sort
  const { maj, verifier: verifierMaj, installer: installerMaj } = useMaj((m) => {
    if (notifsRef.current) { bip(); notifier("Mise à jour disponible", `Version ${m.nouvelle_version}`); }
  });
  // Noms à afficher : le carnet d'abord, sinon le pseudo annoncé (élèves de la salle qui ne sont pas encore contacts)
  const noms = { ...Object.fromEntries(Object.entries(profils).filter(([, p]) => p.pseudo).map(([a, p]) => [a, p.pseudo])), ...contacts };
  const contactsRef = useRef(noms);
  contactsRef.current = noms;

  // Historique + carnet de contacts (le nom peut changer après un envoi)
  const rafraichir = useCallback(() => {
    api("/api/historique").then((r) => setEntrees(r.entrees)).catch(() => {});
    api("/api/contacts").then((r) => { setContacts(r.contacts); setProfils(r.profils || {}); }).catch(() => {});
    api("/api/echanges").then(setEchanges).catch(() => {});
    api("/api/file-attente").then((r) => setFileAttente(r.messages)).catch(() => {});
  }, []);
  useEffect(() => { api("/api/profil").then(setMonProfil).catch(() => {}); }, []);
  // Les demandes d'échange de clés arrivent à tout moment : on interroge le serveur régulièrement
  useEffect(() => {
    const id = setInterval(() => {
      api("/api/echanges").then(setEchanges).catch(() => {});
      api("/api/file-attente").then((r) => setFileAttente(r.messages)).catch(() => {});
      api("/api/contacts").then((r) => { setContacts(r.contacts); setProfils(r.profils || {}); }).catch(() => {});
      // Les accusés de réception (remis, lu) arrivent après l'envoi : on garde la liste à jour
      if (["envoyer", "historique"].includes(ongletRef.current)) {
        api("/api/historique").then((r) => setEntrees(r.entrees)).catch(() => {});
      }
    }, 3000);
    return () => clearInterval(id);
  }, []);
  const vider = () => api("/api/historique", { method: "DELETE" }).then((r) => setEntrees(r.entrees)).catch(() => {});
  useEffect(rafraichir, [rafraichir]);

  const surReception = useRef((m) => {
    const ailleurs = ongletRef.current !== "recevoir" || document.hidden;
    if (ailleurs) setNouveau(true);
    if (ailleurs && notifsRef.current) {
      bip();
      notifier("Nouveau message chiffré", `De ${contactsRef.current[m.pair] || m.pair}`);
    }
    rafraichir();
  }).current;

  // Un point dans le titre de l'onglet du navigateur signale un message non lu
  useEffect(() => {
    document.title = nouveau ? "(•) Messagerie chiffrée" : "Messagerie chiffrée";
  }, [nouveau]);
  useEffect(() => {
    const auRetour = () => { if (ongletRef.current === "recevoir") setNouveau(false); };
    window.addEventListener("focus", auRetour);
    return () => window.removeEventListener("focus", auRetour);
  }, []);

  function basculerNotifs(actif) {
    setNotifs(actif);
    ecrireReglage("mc-notifs", actif);
    if (actif && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
    if (actif) bip();
  }
  const ouvrirConversation = (ip) => { setChoixConversation({ ip }); setOnglet("conversations"); };
  const ecrireA = (ip, nom) => { setPrefill({ ip, nom }); setOnglet("envoyer"); };
  const choisir = (nom) => {
    setOnglet(nom);
    if (nom === "recevoir") setNouveau(false);
  };

  function changerTheme() {
    const suivant = THEMES[(THEMES.findIndex(([n]) => n === theme) + 1) % THEMES.length][0];
    setTheme(suivant);
    appliquerTheme(suivant);
    try { localStorage.setItem("mc-theme", suivant); } catch { /* stockage indisponible : thème non retenu */ }
  }

  return (
    <>
    <FondChiffre />
    <main className="page">
      <header className="entete">
        <svg className="marque" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
          <rect x="1.5" y="1.5" width="37" height="37" rx="9" fill="none" stroke="currentColor" strokeWidth="3" />
          <path d="M13 18v-3.5a7 7 0 0 1 14 0V18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <rect x="10" y="18" width="20" height="14" rx="3" fill="currentColor" />
          <path d="M20 22.5v5" stroke="var(--surface)" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
        <h1>Messagerie chiffrée</h1>
        <button type="button" className="badge-profil" onClick={() => setProfilOuvert(true)} title="Modifier mon profil">
          <Avatar profil={monProfil} nom="Moi" petit />
          <span>{monProfil.pseudo || "Mon profil"}</span>
        </button>
        <button type="button" className="lien theme" onClick={changerTheme}>{THEMES.find(([n]) => n === theme)[1]}</button>
      </header>
      <aside className="lateral">
      <nav className="onglets" role="tablist" aria-orientation="vertical" aria-label="Sections">
        {ONGLETS.map(([id, libelle]) => (
          <button key={id} type="button" role="tab" aria-selected={onglet === id} onClick={() => choisir(id)}>
            <Icone nom={id} />
            <span className="libelle">{libelle}</span>
            {id === "recevoir" && nouveau && <span className="pastille" aria-label="nouveau message" />}
            {id === "envoyer" && fileAttente.length > 0 && (
              <span className="pastille nombre" title={`${fileAttente.length} message${fileAttente.length > 1 ? "s" : ""} en attente`}
                    aria-label={`${fileAttente.length} message${fileAttente.length > 1 ? "s" : ""} en attente`}>{fileAttente.length}</span>
            )}
            {id === "contacts" && echanges.demandes.length > 0 && onglet !== "contacts" && <span className="pastille" aria-label="demande d'échange de clés" />}
          </button>
        ))}
      </nav>
        <CubeRsa />
      </aside>
      <div className="contenu">
      <p className="sous-titre">Chiffre un message ou un fichier, envoie-le à un autre PC et déchiffre-le là-bas.</p>
      <div className="reglages">
        <label className="case notif">
          <input type="checkbox" checked={notifs} onChange={(ev) => basculerNotifs(ev.target.checked)} />
          Notification et son quand un message arrive
          {notifs && "Notification" in window && Notification.permission === "denied" && " (notifications bloquées par le navigateur : le son reste actif)"}
        </label>
      </div>
      <BandeauMaj maj={maj} verifier={verifierMaj} installer={installerMaj} />
      {fileAttente.length > 0 && (
        <div className="bandeau-file" role="status">
          <span>🕐 {fileAttente.length} message{fileAttente.length > 1 ? "s" : ""} en attente : {[...new Set(fileAttente.map((m) => contacts[m.ip] || m.ip))].join(", ")} n'est pas joignable, l'envoi reprendra automatiquement.</span>
          <button type="button" className="lien danger" onClick={() => api("/api/file-attente/vider", { method: "POST", body: "{}" }).then(rafraichir).catch(() => {})}>Annuler les envois</button>
        </div>
      )}
      {/* Tout reste monté : la réception continue pendant qu'on est sur un autre onglet. */}
      <section hidden={onglet !== "envoyer"}><Envoyer onEnvoye={rafraichir} contacts={contacts} profils={profils} prefill={prefill} echanges={echanges} entrees={entrees} /></section>
      <section hidden={onglet !== "recevoir"}><Recevoir onRecu={surReception} echanges={echanges} contacts={noms} /></section>
      <section hidden={onglet !== "historique"}><Historique entrees={entrees} contacts={noms} onVider={vider} onRafraichir={rafraichir} /></section>
      <section hidden={onglet !== "conversations"}>
        <Conversation contacts={noms} profils={profils} monProfil={monProfil} echanges={echanges} entrees={entrees} actif={onglet === "conversations"}
                      choix={choixConversation} onEnvoye={rafraichir} />
      </section>
      <section hidden={onglet !== "contacts"}>
        <Contacts contacts={contacts} profils={profils} echanges={echanges} actif={onglet === "contacts"} onChange={rafraichir} onEcrire={ecrireA} onConversation={ouvrirConversation} />
      </section>
      <section hidden={onglet !== "salle"}>
        <Salle contacts={contacts} profils={profils} echanges={echanges} actif={onglet === "salle"} onChange={rafraichir} onEcrire={ecrireA} onConversation={ouvrirConversation} />
      </section>
      <section hidden={onglet !== "cles"}><MesCles echanges={echanges} contacts={noms} onChange={rafraichir} /></section>
      <section hidden={onglet !== "marche"}><CommentCaMarche /></section>
      </div>
    </main>
    {profilOuvert && <ProfilModal profil={monProfil} onClose={() => setProfilOuvert(false)} onSauve={setMonProfil} />}
    </>
  );
}
