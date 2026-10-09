import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { api, post, erreur, ok } from "./api.js";
import { Avatar, Statut } from "./composants.jsx";
import qrcode from "./qrcode.js";

/* QR code en SVG (généré ici, rien n'est envoyé sur Internet). */
function QrCode({ texte }) {
  const svg = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(texte);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch {
      return "";
    }
  }, [texte]);
  return <div className="qr" role="img" aria-label={`QR code du lien ${texte}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Carte({ salle, ip, port, agir, setStatut }) {
  const [confirmer, setConfirmer] = useState("");
  const copier = (texte, message) => navigator.clipboard.writeText(texte).then(() => setStatut(ok(message)), () => setStatut(erreur("Copie impossible : sélectionne le texte à la main.")));
  return (
    <section className="salle-carte encadre">
      <QrCode texte={salle.lien} />
      <div className="salle-infos">
        <h3>{salle.nom}</h3>
        <div className="code-salle" aria-label={`Code de la salle : ${salle.code.split("").join(" ")}`}>{salle.code}</div>
        <p className="note">Lien : <code>{salle.lien}</code></p>
        <p className="note">ou adresse <code>{ip}:{port}</code> + code <code>{salle.code}</code></p>
        <div className="contact-actions gauche">
          <button type="button" className="bouton petit" onClick={() => copier(salle.lien, "Lien copié : envoie-le aux élèves.")}>Copier le lien</button>
          <button type="button" className="bouton secondaire petit" onClick={() => copier(salle.code, "Code copié.")}>Copier le code</button>
          <button type="button" className="bouton secondaire petit"
                  onClick={() => agir(post("/api/salle/nouveau-code", { code: salle.code }), "Nouveau code généré : les élèves déjà dans la salle y restent.")}>
            Nouveau code
          </button>
        </div>
      </div>
      <div className="salle-eleves">
        <div className="titre"><span>Élèves ({salle.membres.length})</span></div>
        {salle.membres.length === 0 && <p className="note">Personne n'a encore rejoint la salle.</p>}
        <ul className="entrees">
          {salle.membres.map((m) => (
            <li key={m.id} className="contact">
              <div className="contact-tete">
                <Avatar profil={m} nom={m.pseudo || "?"} />
                <div className="contact-infos">
                  <strong>{m.pseudo || "(sans pseudo)"}{m.role === "createur" ? " · créateur" : m.role === "admin" ? " · admin" : ""}</strong>
                  <span className="heure ligne-statut">
                    <span className={`point ${m.en_ligne ? "on" : "off"}`} aria-hidden="true" />
                    {m.en_ligne ? "en ligne" : "hors ligne"}{m.en_attente ? ` · ${m.en_attente} message(s) en attente` : ""}
                  </span>
                </div>
                <div className="contact-actions">
                  <button type="button" className="lien danger" onClick={() => agir(post("/api/salle/retirer", { code: salle.code, id: m.id }), `${m.pseudo || "Élève"} retiré de la salle.`)}>Retirer</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="vider">
          {confirmer === salle.code ? (
            <>
              <button type="button" className="lien danger" onClick={() => { setConfirmer(""); agir(post("/api/salle/supprimer", { code: salle.code }), "Salle supprimée."); }}>Oui, supprimer la salle et ses messages en attente</button>
              <button type="button" className="lien" onClick={() => setConfirmer("")}>Annuler</button>
            </>
          ) : (
            <button type="button" className="lien danger" onClick={() => setConfirmer(salle.code)}>Supprimer cette salle</button>
          )}
        </div>
      </div>
    </section>
  );
}

export default function SalleProf({ actif, onChange, onVoirAnnuaire, coffre }) {
  const [etat, setEtat] = useState(null);
  const [nom, setNom] = useState("");
  const [statut, setStatut] = useState(null);
  const [enCours, setEnCours] = useState(false);
  const idNom = useId();

  const actualiser = useCallback(async () => {
    try {
      setEtat(await api("/api/salle/hebergement"));
    } catch { /* le serveur redémarre : on réessaie au prochain tour */ }
  }, []);

  useEffect(() => {
    if (!actif) return undefined;
    actualiser();
    const id = setInterval(actualiser, 3000);
    return () => clearInterval(id);
  }, [actif, actualiser]);

  async function agir(promesse, message) {
    try {
      const e = await promesse;
      if (e && e.salles) setEtat(e);
      onChange();
      if (message) setStatut(ok(message));
    } catch (err) {
      setStatut(erreur(err.message));
    }
  }

  async function creer(ev) {
    ev.preventDefault();
    setEnCours(true);
    setStatut(null);
    await agir(post("/api/salle/creer", { nom: nom.trim(), rejoindre: true }), "Salle créée : montre le QR code aux élèves ou envoie-leur le lien.");
    setNom("");
    setEnCours(false);
  }

  if (!etat) return <p className="note">Chargement…</p>;
  const { actif: enMarche, salles, ip, port } = etat;

  return (
    <div className="panneau">
      <form onSubmit={creer} className="panneau encadre">
        <p className="note">
          Crée une salle depuis ce PC : le programme fait lui-même office de <strong>relais</strong>. Tu obtiens un <strong>QR code</strong>, un <strong>code à 6 chiffres</strong> et un <strong>lien</strong> à donner aux élèves.
          Les messages restent chiffrés : le relais ne peut pas les lire.
        </p>
        <p className="note">
          Tu en es le <strong>créateur</strong> : admin de la salle, tu peux nommer des élèves admins, supprimer des messages et retirer des membres.
          Le salon commun est <strong>chiffré de bout en bout</strong> : c'est ton programme qui crée la clé du salon et la distribue aux élèves.
        </p>
        {coffre !== "ouvert" && (
          <p className="statut info" role="status">
            {coffre === "absent" ? "Crée ton coffre" : "Déverrouille ton coffre"} dans l'onglet Contacts : sans lui, ton programme ne peut pas créer la clé du salon.
          </p>
        )}
        <div className="champ">
          <div className="titre"><label htmlFor={idNom}>Nom de la salle</label></div>
          <input id={idNom} value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Classe de 3A" maxLength={40} autoComplete="off" />
        </div>
        <div className="action">
          <button type="submit" className="bouton" disabled={enCours}>{enCours ? "Création…" : "Créer la salle"}</button>
          <Statut statut={statut} />
        </div>
      </form>

      <div className="carte-ip">
        <div>
          <p>Relais de la salle</p>
          <strong className="petit">{enMarche ? "en marche" : "arrêté"}</strong>
          <p className="ligne-statut"><span className={`point ${enMarche ? "on" : "off"}`} aria-hidden="true" />{enMarche ? `les élèves se connectent à ${ip}:${port}` : "les élèves ne peuvent pas rejoindre tant qu'il est arrêté"}</p>
        </div>
        {enMarche
          ? <button type="button" className="lien danger" onClick={() => agir(post("/api/salle/fermer", {}), "Relais arrêté : les salles et les messages en attente sont conservés.")}>Arrêter le relais</button>
          : <button type="button" className="bouton petit" onClick={() => agir(post("/api/salle/demarrer", {}), "Relais démarré.")}>Démarrer le relais</button>}
      </div>

      {enMarche && (
        <p className="note">
          Pare-feu : si les élèves n'arrivent pas à rejoindre, autorise le port <strong>{port}</strong> en TCP (Windows propose de le faire au premier lancement : accepte pour les réseaux privés).
          Pour écrire aux élèves, <button type="button" className="lien" onClick={onVoirAnnuaire}>ouvre l'annuaire de la salle</button>.
        </p>
      )}

      {salles.length === 0 && (
        <div className="etat-vide">
          <strong>Aucune salle pour l'instant</strong>
          <p className="note">Donne un nom à ta salle puis clique sur « Créer la salle ».</p>
        </div>
      )}
      {salles.map((s) => <Carte key={s.code} salle={s} ip={ip} port={port} agir={agir} setStatut={setStatut} />)}
    </div>
  );
}
