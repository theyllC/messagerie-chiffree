import { useEffect, useId, useRef, useState } from "react";
import { api, post, erreur, ok } from "./api.js";
import { Modal, Statut } from "./composants.jsx";

/* Date lisible à partir de "2026-10-07T14:27:29". */
export const dateFr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} à ${iso.slice(11, 16)}` : "inconnue (clé créée avant cette version)");

/* Début de l'empreinte, pour les lignes compactes : le détail complet est dans le modal. */
export const empreinteCourte = (empreinte) => (empreinte ? `${empreinte.split(" ").slice(0, 3).join(" ")} …` : "");

export function telecharger(nom, texte) {
  const lien = document.createElement("a");
  lien.href = URL.createObjectURL(new Blob([texte], { type: "application/x-pem-file" }));
  lien.download = nom;
  lien.click();
  setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
}

/* Ma clé publique (jamais la privée) : chargée seulement quand le coffre est ouvert. */
export function useIdentite(actif, marque) {
  const [identite, setIdentite] = useState(null);
  useEffect(() => {
    if (!actif) { setIdentite(null); return undefined; }
    let annule = false;
    api("/api/identite").then((r) => { if (!annule) setIdentite(r); }).catch(() => { if (!annule) setIdentite(null); });
    return () => { annule = true; };
  }, [actif, marque]);  // marque : empreinte de ma clé, change quand ma paire est remplacée
  return identite;
}

/* Une clé publique en détail : empreinte, taille, PEM, copie et export. `details` : lignes en plus, [[libellé, valeur], …]. */
export function ModalClePublique({ titre, intro, infos, details = [], nomFichier, onClose }) {
  const [statut, setStatut] = useState(null);

  function copier() {
    navigator.clipboard.writeText(infos.pem)
      .then(() => setStatut(ok("Clé publique copiée (format PEM).")))
      .catch(() => setStatut(erreur("Copie impossible : exporte-la en fichier .pem.")));
  }

  return (
    <Modal titre={titre} onClose={onClose}>
      {intro && <p className="note">{intro}</p>}
      <dl className="cles">
        <dt>Empreinte</dt>
        <dd><span className="code">{infos.empreinte}</span></dd>
        <dt>Taille</dt>
        <dd>{infos.bits} bits · RSA</dd>
        {details.map(([libelle, valeur]) => (
          <div key={libelle} style={{ display: "contents" }}>
            <dt>{libelle}</dt>
            <dd>{valeur}</dd>
          </div>
        ))}
      </dl>
      <pre className="zone chiffre pem" tabIndex={0} aria-label="Clé publique au format PEM">{infos.pem}</pre>
      <div className="actions-ligne">
        <button type="button" className="bouton secondaire petit" onClick={() => telecharger(nomFichier, infos.pem)}>Exporter en .pem</button>
        <button type="button" className="lien" onClick={copier}>Copier la clé publique</button>
      </div>
      <Statut statut={statut} />
    </Modal>
  );
}

/* Ma clé privée : jamais affichée d'office. Il faut redonner le mot de passe du coffre, et elle se masque toute seule. */
const DELAI_MASQUAGE = 60 * 1000;

export function ModalClePrivee({ onClose }) {
  const [mdp, setMdp] = useState("");
  const [pem, setPem] = useState(null);
  const [statut, setStatut] = useState(null);
  const [attente, setAttente] = useState(false);
  const fermer = useRef(onClose);
  fermer.current = onClose;
  const idMdp = useId();

  useEffect(() => {
    if (!pem) return undefined;
    const minuteur = setTimeout(() => fermer.current(), DELAI_MASQUAGE);
    return () => clearTimeout(minuteur);
  }, [pem]);

  async function reveler(ev) {
    ev.preventDefault();
    if (!mdp) return setStatut(erreur("Saisis le mot de passe du coffre."));
    setAttente(true);
    setStatut(null);
    try {
      const r = await post("/api/identite/privee", { mdp });
      setPem(r.pem);
      setMdp("");
    } catch (e) {
      setStatut(erreur(e.message));
    } finally {
      setAttente(false);
    }
  }

  return (
    <Modal titre="Ma clé privée" onClose={onClose}>
      {!pem ? (
        <form onSubmit={reveler} className="panneau">
          <p className="note">
            Pour l'afficher, redonne le mot de passe du coffre. Vérifie que personne ne regarde ton écran
            (et que tu ne le partages pas en visio).
          </p>
          <div className="champ">
            <div className="titre"><label htmlFor={idMdp}>Mot de passe du coffre</label></div>
            <input id={idMdp} type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="off" />
          </div>
          <Statut statut={statut} />
          <div className="actions-ligne">
            <button type="submit" className="bouton" disabled={attente}>{attente ? "Vérification…" : "Afficher la clé"}</button>
            <button type="button" className="lien" onClick={onClose}>Annuler</button>
          </div>
        </form>
      ) : (
        <>
          <p className="avertissement" role="alert">
            Ne la partage jamais et ne la copie nulle part : celui qui la possède peut lire tous les messages qu'on t'envoie
            et signer à ta place. Elle se masque toute seule au bout d'une minute.
          </p>
          <pre className="zone chiffre pem prive" tabIndex={0} aria-label="Clé privée au format PEM">{pem}</pre>
          <p className="note">Elle sert à ouvrir ce qui a été chiffré avec ta clé publique, et à signer tes demandes d'échange de clés.</p>
          <div className="actions-ligne">
            <button type="button" className="bouton secondaire petit" onClick={onClose}>Masquer</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* Qui sert à quoi : le rappel qu'on évite d'écrire en clair dans les pages. */
export function ModalAideCles({ onClose }) {
  return (
    <Modal titre="À quoi servent les clés ?" onClose={onClose}>
      <dl className="cles">
        <dt>Clé publique</dt>
        <dd>
          Tu la donnes à tout le monde. Ton contact s'en sert pour te chiffrer un message (RSA direct) et pour vérifier que
          tes demandes d'échange viennent bien de toi (ta signature).
        </dd>
        <dt>Clé privée</dt>
        <dd>
          Elle reste dans le coffre de ce PC, chiffrée par ton mot de passe. Elle ouvre ce qu'on t'envoie en RSA et signe en ton nom.
          Elle n'est jamais envoyée.
        </dd>
        <dt>Message à un contact</dt>
        <dd>
          Il est chiffré avec la clé secrète commune née de l'échange de clés, ou, en RSA direct, avec la clé publique du destinataire.
          La clé publique de l'expéditeur ne déchiffre rien : elle sert à l'identifier et à vérifier ses signatures.
        </dd>
        <dt>Mot de passe du coffre</dt>
        <dd>Il protège la clé privée sur ce PC. Il ne quitte jamais cet ordinateur et ne se récupère pas.</dd>
      </dl>
      <p className="note">Pour comparer à l'oral : lis ton empreinte à ton contact, il doit voir la même pour ta clé.</p>
    </Modal>
  );
}

/* Onglet Envoyer : mes deux clés en deux lignes, et le partage de ma clé publique avec le PC choisi. */
export function ClesEnvoi({ echanges, ip, onChange }) {
  const ouvert = echanges.etat === "ouvert";
  const identite = useIdentite(ouvert, echanges.moi);
  const [modal, setModal] = useState(null);  // "publique" | "privee" | "aide"
  const [statut, setStatut] = useState(null);
  const [enCours, setEnCours] = useState(false);
  const adresse = ip.trim();
  const echangee = ouvert && Boolean(echanges.cles?.[adresse]);
  const enAttente = ouvert && (echanges.sortants || []).includes(adresse);

  async function partager() {
    setEnCours(true);
    try {
      await post("/api/echange/demarrer", { ip: adresse });
      setStatut(ok("Ta clé publique est partie. Ton contact doit accepter la demande (onglet Contacts, chez lui)."));
      onChange();
    } catch (e) {
      setStatut(erreur(e.message));
    } finally {
      setEnCours(false);
    }
  }

  return (
    <fieldset className="groupe">
      <legend>Mes clés</legend>
      {!ouvert && (
        <p className="note">{echanges.etat === "absent" ? "Aucun coffre : crée-le" : "Coffre verrouillé : déverrouille-le"} dans l'onglet Contacts pour voir tes clés.</p>
      )}
      <div className="ligne-cle">
        <div className="contact-infos">
          <strong>Clé publique</strong>
          <span className="heure">À donner au PC 2{identite ? ` · ${empreinteCourte(identite.empreinte)}` : ""}</span>
        </div>
        <button type="button" className="bouton secondaire petit" disabled={!identite} onClick={() => setModal("publique")}>Voir</button>
      </div>
      <div className="ligne-cle">
        <div className="contact-infos">
          <strong>Clé privée</strong>
          <span className="heure">Secrète, reste sur ce PC · ••••• ••••• •••••</span>
        </div>
        <button type="button" className="bouton secondaire petit" disabled={!ouvert} onClick={() => setModal("privee")}>Afficher…</button>
      </div>
      <div className="ligne-cle">
        <div className="contact-infos">
          <strong>Partage avec ce PC</strong>
          <span className="heure">
            {!adresse ? "Indique d'abord l'adresse du PC 2."
              : echangee ? "✓ Clés échangées : il a ta clé publique, tu as la sienne."
              : enAttente ? "Demande envoyée : en attente que ce PC l'accepte."
              : "Il n'a pas encore ta clé publique."}
          </span>
        </div>
        {adresse && !echangee && (
          <button type="button" className="bouton secondaire petit" disabled={!ouvert || enCours} onClick={partager}>
            {enAttente ? "Renvoyer" : "Partager ma clé publique"}
          </button>
        )}
      </div>
      <Statut statut={statut} />
      <button type="button" className="lien" onClick={() => setModal("aide")}>À quoi servent ces clés ?</button>

      {modal === "publique" && identite && (
        <ModalClePublique titre="Ma clé publique" infos={identite} nomFichier="ma-cle-publique.pem"
                          intro="Celle que tu donnes aux autres. Elle ne permet pas de te lire : elle sert à te chiffrer des messages et à vérifier tes signatures."
                          details={[["Créée le", dateFr(identite.cree)]]} onClose={() => setModal(null)} />
      )}
      {modal === "privee" && <ModalClePrivee onClose={() => setModal(null)} />}
      {modal === "aide" && <ModalAideCles onClose={() => setModal(null)} />}
    </fieldset>
  );
}

/* Onglet Recevoir : la clé publique de l'expéditeur du message reçu. */
export function CleExpediteur({ recu, echanges, contacts }) {
  const ouvert = echanges.etat === "ouvert";
  const v = recu?.v ?? 1;
  const identite = useIdentite(ouvert && v === 5, echanges.moi);
  const [modal, setModal] = useState(false);
  if (!recu) return null;

  const adresse = recu.pair;
  const nom = contacts[adresse] || adresse;
  const cleExp = ouvert ? echanges.cles?.[adresse] : undefined;
  let corps;
  let infos = null;
  let intro = "";
  let titre = "";
  let fichier = "";

  if (v === 1 || v === 4) {
    corps = <p className="note">Message à clé saisie à la main : aucune clé publique n'intervient. Utilise la clé que ton contact t'a donnée.</p>;
  } else if (!ouvert) {
    corps = <p className="note">Déverrouille le coffre (onglet Contacts) pour voir la clé publique de l'expéditeur.</p>;
  } else if (v === 5) {
    infos = identite;
    titre = "Ma clé publique (celle qui a chiffré ce message)";
    fichier = "ma-cle-publique.pem";
    intro = "En RSA direct, l'expéditeur chiffre avec ta clé publique et n'envoie pas la sienne : il n'est pas authentifié. Seule ta clé privée ouvre ce message.";
    corps = <p className="note">Message RSA direct de {nom} : chiffré avec <strong>ta</strong> clé publique, que seule ta clé privée peut ouvrir. L'expéditeur n'envoie pas la sienne.</p>;
  } else if (cleExp?.pem) {
    infos = cleExp;
    titre = `Clé publique de ${nom}`;
    fichier = `cle-publique-${adresse.replace(/[^0-9a-zA-Z.-]/g, "_")}.pem`;
    intro = `Reçue de ${nom} lors de l'échange de clés. Elle l'identifie et permet de vérifier ses signatures. Ce message, lui, s'ouvre avec la clé secrète que vous partagez depuis l'échange (rangée dans ton coffre). Compare l'empreinte avec celle qu'il voit chez lui.`;
    corps = <p className="note">Message de <strong>{nom}</strong> · empreinte de sa clé publique : <span className="code">{empreinteCourte(cleExp.empreinte)}</span></p>;
  } else {
    corps = <p className="note">Aucune clé publique enregistrée pour {adresse}. Échange les clés avec ce PC dans l'onglet Contacts.</p>;
  }

  return (
    <fieldset className="groupe">
      <legend>Clé publique de l'expéditeur</legend>
      <div className="ligne-cle">
        {corps}
        {infos && <button type="button" className="bouton secondaire petit" onClick={() => setModal(true)}>Voir la clé</button>}
      </div>
      {modal && infos && (
        <ModalClePublique titre={titre} infos={infos} nomFichier={fichier} intro={intro} onClose={() => setModal(false)} />
      )}
    </fieldset>
  );
}
