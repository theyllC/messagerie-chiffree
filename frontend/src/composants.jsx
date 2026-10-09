import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { post } from "./api.js";

export const MAX_FICHIER = 2 * 1024 * 1024;

export function formatTaille(octets) {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${(octets / 1024 / 1024).toFixed(1)} Mo`;
}

export function Statut({ statut }) {
  return (
    <p className={`statut ${statut?.type ?? ""}`} role="status">
      {statut?.texte}
    </p>
  );
}

const FOCALISABLES = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* Fenêtre modale : Échap ou clic sur le fond pour fermer, le focus reste dedans et revient au bouton d'origine.
   Rendue dans <body> (portail) : elle n'est pas masquée avec l'onglet, et un formulaire à l'intérieur n'envoie pas celui de la page. */
export function Modal({ titre, onClose, children }) {
  const fenetre = useRef(null);
  const fermer = useRef(onClose);
  fermer.current = onClose;
  const idTitre = useId();

  useEffect(() => {
    const avant = document.activeElement;
    const ancienDefilement = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const premier = fenetre.current?.querySelector("input, textarea, select");
    (premier || fenetre.current)?.focus();
    function touche(ev) {
      if (ev.key === "Escape") { ev.stopPropagation(); fermer.current(); return; }
      if (ev.key !== "Tab" || !fenetre.current) return;
      const liste = [...fenetre.current.querySelectorAll(FOCALISABLES)];
      if (!liste.length) { ev.preventDefault(); return; }
      const debut = liste[0], fin = liste[liste.length - 1];
      if (ev.shiftKey && (document.activeElement === debut || document.activeElement === fenetre.current)) { ev.preventDefault(); fin.focus(); }
      else if (!ev.shiftKey && document.activeElement === fin) { ev.preventDefault(); debut.focus(); }
    }
    document.addEventListener("keydown", touche);
    return () => {
      document.removeEventListener("keydown", touche);
      document.body.style.overflow = ancienDefilement;
      if (avant && document.contains(avant)) avant.focus();
    };
  }, []);

  return createPortal(
    <div className="modal-fond" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}
         onSubmit={(ev) => ev.stopPropagation()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={idTitre} tabIndex={-1} ref={fenetre}>
        <div className="modal-tete">
          <h2 id={idTitre}>{titre}</h2>
          <button type="button" className="lien modal-fermer" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal-corps">{children}</div>
      </div>
    </div>,
    document.body
  );
}

/* Accusés de réception : ✓ envoyé, ✓✓ remis sur le PC du contact, ✓✓ lu (message déchiffré). */
const LIBELLES = { attente: "en attente", envoye: "envoyé", remis: "remis", lu: "lu", echec: "non envoyé" };
const SYMBOLES = { attente: "🕐", envoye: "✓", remis: "✓✓", lu: "✓✓", echec: "⚠" };
const INFOBULLES = {
  attente: "En attente : le destinataire n'est pas joignable, l'envoi reprendra automatiquement.",
  echec: "Non envoyé : le destinataire est resté injoignable, l'envoi a été abandonné.",
};
export function Coches({ statut }) {
  if (!LIBELLES[statut]) return null;
  return <span className={`coches ${statut}`} title={INFOBULLES[statut]}>{SYMBOLES[statut]} {LIBELLES[statut]}</span>;
}

/* Avatar d'un contact ou de soi-même : l'émoji choisi, sinon l'initiale du nom. */
export function Avatar({ profil, nom, petit }) {
  const contenu = profil?.avatar || (profil?.pseudo || nom || "?").trim().charAt(0).toUpperCase() || "?";
  return <span className={`avatar ${petit ? "petit" : ""} ${profil?.avatar ? "emoji" : ""}`} aria-hidden="true">{contenu}</span>;
}

export const EMOJIS = [
  "🐱", "🐶", "🦊", "🐼", "🦁", "🐲", "🦄", "🐙",
  "🎮", "🎵", "🎨", "🏀", "⚡", "🔥", "💎", "🌟",
  "🚀", "🎯", "👾", "🤖", "💻", "📚", "🎭", "🎪",
];

/* Fenêtre « Mon profil » : pseudo + grille d'émojis. Le profil est visible par les autres PC (détection, échange de clés). */
export function ProfilModal({ profil, onClose, onSauve }) {
  const [pseudo, setPseudo] = useState(profil.pseudo);
  const [avatar, setAvatar] = useState(profil.avatar);
  const [statut, setStatutLocal] = useState(null);
  const idPseudo = useId();

  async function enregistrer(ev) {
    ev.preventDefault();
    try {
      const r = await post("/api/profil", { pseudo: pseudo.trim(), avatar: avatar.trim() });
      onSauve(r);
      onClose();
    } catch (e) {
      setStatutLocal({ type: "erreur", texte: e.message });
    }
  }

  return (
    <Modal titre="Mon profil" onClose={onClose}>
      <form onSubmit={enregistrer} className="grille">
        <div className="champ">
          <div className="titre"><label htmlFor={idPseudo}>Pseudo</label><span className="heure">{pseudo.length}/20</span></div>
          <input id={idPseudo} value={pseudo} maxLength={20} autoComplete="off" placeholder="Ex : Alice"
                 onChange={(e) => setPseudo(e.target.value)} />
        </div>
        <div className="champ">
          <div className="titre"><span>Avatar</span>
            {avatar && <button type="button" className="lien" onClick={() => setAvatar("")}>Retirer</button>}
          </div>
          <div className="grille-emojis" role="group" aria-label="Choisir un avatar">
            {EMOJIS.map((e) => (
              <button key={e} type="button" className="emoji" aria-pressed={avatar === e} aria-label={`Avatar ${e}`}
                      onClick={() => setAvatar(e)}>{e}</button>
            ))}
          </div>
          <p className="note">Ou 2 caractères (initiales) :</p>
          <input aria-label="Initiales" className="initiales" value={EMOJIS.includes(avatar) ? "" : avatar} maxLength={2}
                 autoComplete="off" onChange={(e) => setAvatar(e.target.value.trim())} />
        </div>
        <p className="note">Ton pseudo et ton avatar sont visibles des PC de ton réseau (détection) et de tes contacts. Rien de secret : ne mets pas d'information personnelle.</p>
        <div className="action">
          <button type="submit" className="bouton">Enregistrer</button>
          <button type="button" className="bouton secondaire" onClick={onClose}>Annuler</button>
          <Statut statut={statut} />
        </div>
      </form>
    </Modal>
  );
}

const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/* Pièce jointe déchiffrée : aperçu des images, enregistrement pour tout le reste. */
export function Fichier({ f }) {
  return (
    <div className="fichier">
      {IMAGES.includes(f.type) && <img src={`data:${f.type};base64,${f.donnees}`} alt={f.nom} />}
      <div>
        <strong>{f.nom}</strong> <span className="heure">({formatTaille(f.taille)})</span>
      </div>
      <a className="lien" href={`data:application/octet-stream;base64,${f.donnees}`} download={f.nom}>
        Enregistrer le fichier
      </a>
    </div>
  );
}

function lireBase64(fichier) {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(String(lecteur.result).split(",")[1] ?? "");
    lecteur.onerror = () => reject(new Error("Lecture du fichier impossible."));
    lecteur.readAsDataURL(fichier);
  });
}

/* v2 et v3 : clé échangée ; v5 : clé publique importée (RSA direct) ; le coffre fournit la clé. v1 et v4 : clé saisie à la main. */
export const parCle = (v) => v === 2 || v === 3 || v === 5;  // v5 : RSA direct, ouvert par la clé privée du coffre

/* Envoie un fichier déjà choisi. Lève une Error avec un message lisible en cas d'échec. */
export async function envoyerFichier({ ip, nom, fichier, manuel, cle }) {
  if (fichier.size > MAX_FICHIER) throw new Error(`Fichier trop gros (${formatTaille(MAX_FICHIER)} maximum).`);
  if (manuel && !cle) throw new Error("Saisis d'abord la clé : le destinataire en aura besoin pour ouvrir le fichier.");
  const donnees = await lireBase64(fichier);
  return post("/api/envoyer-fichier", {
    ip, nom_fichier: fichier.name, type: fichier.type || "application/octet-stream", donnees, nom, cle: manuel ? cle : "",
  });
}

/* Choix d'une pièce jointe : le fichier attend ici, il part avec le message quand on clique sur « Envoyer ». */
export function ChoixFichier({ fichier, onChange, manuel, bloque }) {
  const [erreurTaille, setErreurTaille] = useState(null);
  const id = useId();
  function choisir(ev) {
    const f = ev.target.files[0];
    ev.target.value = "";  // permet de rechoisir le même fichier
    if (!f) return;
    if (f.size > MAX_FICHIER) {
      setErreurTaille(`Fichier trop gros (${formatTaille(MAX_FICHIER)} maximum).`);
      return;
    }
    setErreurTaille(null);
    onChange(f);
  }
  return (
    <div className="champ">
      <div className="titre"><label htmlFor={id}>Pièce jointe (facultatif, {formatTaille(MAX_FICHIER)} maximum, chiffrée)</label></div>
      {bloque ? (
        <p className="note">Pièce jointe indisponible en RSA direct : échange d'abord les clés avec ce contact (onglet Contacts).</p>
      ) : fichier ? (
        <div className="carte-ip">
          <div>
            <p>Prêt à partir avec le message</p>
            <strong className="petit">{fichier.name} · {formatTaille(fichier.size)}</strong>
          </div>
          <button type="button" className="lien danger" onClick={() => onChange(null)}>Retirer</button>
        </div>
      ) : (
        <div className="choix-fichier">
          <input id={id} type="file" className="cache" onChange={choisir} />
          <label htmlFor={id} className="bouton secondaire petit">Choisir un fichier…</label>
          <span className="note">Aucun fichier choisi</span>
        </div>
      )}
      {erreurTaille && <p className="statut erreur" role="status">{erreurTaille}</p>}
      {fichier && manuel && <p className="note">Le fichier sera protégé par la clé saisie ci-dessus.</p>}
    </div>
  );
}

/* Notifications : le contenu des messages n'y figure jamais (il est chiffré). */
export function lireReglage(cle) {
  try { return localStorage.getItem(cle) === "1"; } catch { return false; }
}

export function ecrireReglage(cle, valeur) {
  try { localStorage.setItem(cle, valeur ? "1" : "0"); } catch { /* stockage indisponible : réglage non retenu */ }
}

export function bip() {
  try {
    const Contexte = window.AudioContext || window.webkitAudioContext;
    const c = new Contexte();
    const o = c.createOscillator();
    const g = c.createGain();
    o.connect(g);
    g.connect(c.destination);
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.start();
    o.stop(c.currentTime + 0.18);
    setTimeout(() => c.close(), 400);
  } catch { /* son bloqué par le navigateur : tant pis */ }
}

export function notifier(titre, corps) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(titre, { body: corps });
      n.onclick = () => window.focus();
    }
  } catch { /* notifications indisponibles */ }
}

export function ChampCle({ valeur, onChange }) {
  const id = useId();
  return (
    <div className="champ">
      <label htmlFor={id}>Clé</label>
      <input id={id} type="password" value={valeur} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
