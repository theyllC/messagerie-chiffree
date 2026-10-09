import { useId, useState } from "react";
import { post, erreur, ok } from "./api.js";
import { Modal, Statut } from "./composants.jsx";
import { ModalCleDepuisPremiers, ModalRsaPasAPas } from "./AtelierRsa.jsx";
import { ModalAideCles, ModalClePrivee, ModalClePublique, dateFr, empreinteCourte, useIdentite } from "./ClesAffichage.jsx";

/* Formulaire d'import, dans un modal : colle la clé d'un contact ou choisis son fichier .pem. */
function ModalImport({ ouvert, onImporte, onClose }) {
  const [ip, setIp] = useState("");
  const [nom, setNom] = useState("");
  const [texte, setTexte] = useState("");
  const [statut, setStatut] = useState(null);
  const idIp = useId();
  const idNom = useId();
  const idTexte = useId();
  const idFichier = useId();

  function lireFichier(ev) {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    if (f.size > 16 * 1024) return setStatut(erreur("Ce fichier est trop gros pour être une clé publique."));
    f.text().then((t) => { setTexte(t); setStatut(null); }).catch(() => setStatut(erreur("Lecture du fichier impossible.")));
  }

  async function importer(ev) {
    ev.preventDefault();
    if (!ip.trim()) return setStatut(erreur("Indique l'adresse IP du contact (127.0.0.1 pour tester sur ce PC)."));
    if (!texte.trim()) return setStatut(erreur("Colle la clé publique du contact ou choisis son fichier .pem."));
    try {
      const r = await post("/api/cle-publique/importer", { ip: ip.trim(), name: nom.trim(), pem: texte });
      onImporte(ok(`Clé importée. Empreinte : ${r.empreinte}. Compare-la avec celle que ton contact voit chez lui.`));
      onClose();
    } catch (e) {
      setStatut(erreur(e.message));
    }
  }

  return (
    <Modal titre="Importer la clé d'un contact" onClose={onClose}>
      <form onSubmit={importer} className="panneau">
        <p className="note">
          Sans échange automatique (réseau qui le bloque, démonstration) : colle la clé publique de ton contact ou choisis son fichier .pem.
          Tu pourras ensuite lui écrire dans l'onglet Envoyer en « RSA direct ».
        </p>
        <div className="duo">
          <div className="champ">
            <div className="titre"><label htmlFor={idIp}>Adresse IP du contact</label></div>
            <input id={idIp} value={ip} onChange={(e) => setIp(e.target.value)} inputMode="decimal" disabled={!ouvert} />
          </div>
          <div className="champ">
            <div className="titre"><label htmlFor={idNom}>Nom (facultatif)</label></div>
            <input id={idNom} value={nom} onChange={(e) => setNom(e.target.value)} disabled={!ouvert} />
          </div>
        </div>
        <div className="champ">
          <div className="titre"><label htmlFor={idTexte}>Clé publique (PEM)</label></div>
          <textarea id={idTexte} rows={6} value={texte} onChange={(e) => setTexte(e.target.value)} disabled={!ouvert}
                    placeholder={"-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----"} spellCheck={false} />
        </div>
        <div className="choix-fichier">
          <input id={idFichier} type="file" accept=".pem,.pub,.txt" className="cache" onChange={lireFichier} disabled={!ouvert} />
          <label htmlFor={idFichier} className="bouton secondaire petit">Choisir un fichier .pem…</label>
        </div>
        <Statut statut={statut} />
        <div className="actions-ligne">
          <button type="submit" className="bouton" disabled={!ouvert}>Importer la clé</button>
          <button type="button" className="lien" onClick={onClose}>Annuler</button>
        </div>
      </form>
    </Modal>
  );
}

/* Page « Mes clés » : un résumé, et chaque détail dans son modal. */
export default function MesCles({ echanges, contacts, onChange }) {
  const ouvert = echanges.etat === "ouvert";
  const identite = useIdentite(ouvert, echanges.moi);
  const [modal, setModal] = useState(null);  // "publique" | "privee" | "import" | "aide" | { importee: adresse }
  const [statut, setStatut] = useState(null);

  async function retirer(adresse) {
    try {
      await post("/api/cle-publique/supprimer", { ip: adresse });
      setStatut(ok("Clé importée supprimée."));
      onChange();
    } catch (e) {
      setStatut(erreur(e.message));
    }
  }

  const importees = Object.entries(echanges.importees || {});
  const vue = modal?.importee ? echanges.importees?.[modal.importee] : null;
  const fermer = () => setModal(null);

  return (
    <div className="panneau grille">
      {!ouvert && (
        <p className="note">Coffre {echanges.etat === "absent" ? "absent : crée-le" : "verrouillé : déverrouille-le"} dans l'onglet Contacts pour voir et gérer tes clés.</p>
      )}

      <fieldset className="groupe">
        <legend>Ma paire de clés RSA</legend>
        {ouvert && identite ? (
          <p className="note">
            <strong>{identite.bits} bits</strong> · créée le {dateFr(identite.cree)}<br />
            Empreinte : <span className="code">{empreinteCourte(identite.empreinte)}</span>
          </p>
        ) : ouvert ? <p className="note">Chargement…</p> : null}
        <div className="actions-ligne">
          <button type="button" className="bouton secondaire petit" disabled={!identite} onClick={() => setModal("publique")}>Ma clé publique</button>
          <button type="button" className="bouton secondaire petit" disabled={!ouvert} onClick={() => setModal("privee")}>Ma clé privée…</button>
          <button type="button" className="lien" onClick={() => setModal("aide")}>À quoi servent-elles ?</button>
        </div>
      </fieldset>

      <fieldset className="groupe">
        <legend>Clés des contacts</legend>
        {ouvert && importees.length === 0 && <p className="note">Aucune clé importée. Les clés échangées automatiquement sont dans l'onglet Contacts.</p>}
        {ouvert && importees.map(([adresse, i]) => (
          <div key={adresse} className="ligne-cle">
            <div className="contact-infos">
              <strong>{contacts[adresse] || adresse}</strong>
              <span className="heure">{adresse} · importée le {dateFr(i.date)}</span>
            </div>
            <div className="actions-ligne">
              <button type="button" className="bouton secondaire petit" onClick={() => setModal({ importee: adresse })}>Voir</button>
              <button type="button" className="lien danger" onClick={() => retirer(adresse)}>Supprimer</button>
            </div>
          </div>
        ))}
        <div className="actions-ligne">
          <button type="button" className="bouton secondaire petit" disabled={!ouvert} onClick={() => setModal("import")}>Importer la clé d'un contact…</button>
        </div>
      </fieldset>

      <fieldset className="groupe">
        <legend>Atelier RSA</legend>
        <div className="actions-ligne">
          <button type="button" className="bouton secondaire petit" onClick={() => setModal("atelier")}>RSA pas à pas (mes p et q)…</button>
          <button type="button" className="bouton secondaire petit" disabled={!ouvert} onClick={() => setModal("premiers")}>Créer ma clé depuis mes nombres premiers…</button>
        </div>
      </fieldset>
      <Statut statut={statut} />

      {modal === "atelier" && <ModalRsaPasAPas onClose={fermer} />}
      {modal === "premiers" && <ModalCleDepuisPremiers onChange={(s) => { setStatut(s); onChange(); }} onClose={fermer} />}
      {modal === "publique" && identite && (
        <ModalClePublique titre="Ma clé publique" infos={identite} nomFichier="ma-cle-publique.pem"
                          intro="Celle que tu peux donner à tout le monde. Elle sert à te chiffrer des messages et à vérifier tes signatures."
                          details={[["Créée le", dateFr(identite.cree)]]} onClose={fermer} />
      )}
      {modal === "privee" && <ModalClePrivee onClose={fermer} />}
      {modal === "aide" && <ModalAideCles onClose={fermer} />}
      {modal === "import" && <ModalImport ouvert={ouvert} onImporte={(s) => { setStatut(s); onChange(); }} onClose={fermer} />}
      {vue && vue.pem && (
        <ModalClePublique titre={`Clé de ${contacts[modal.importee] || modal.importee}`} infos={vue} nomFichier="cle-publique-contact.pem"
                          intro="Clé importée à la main. Tu peux lui écrire en « RSA direct » : seul son PC peut ouvrir le message. L'expéditeur n'est pas authentifié, sans accusé « lu » ni pièce jointe."
                          details={[["Importée le", dateFr(vue.date)], ["Adresse", modal.importee]]} onClose={fermer} />
      )}
    </div>
  );
}
