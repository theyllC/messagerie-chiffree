import { useState } from "react";
import { post } from "./api.js";

const ETAPES = [
  {
    titre: "1. Texte en clair",
    description: "Ton message original, lisible par quiconque l'intercepte. Pour l'ordinateur, ce ne sont que des octets.",
    explication: "C'est le point de départ : ce que tu tapes.",
  },
  {
    titre: "2. Transformation de la clé (scrypt)",
    description: "Le mot de passe est transformé en vraie clé de 256 bits par l'algorithme scrypt, avec un sel aléatoire.",
    explication: "Pourquoi scrypt ? Il est volontairement lent et gourmand : un pirate ne peut essayer que très peu de mots de passe par seconde. Le sel garantit qu'un même mot de passe donne une clé différente à chaque message.",
  },
  {
    titre: "3. Chiffrement AES-256-GCM",
    description: "Le message est chiffré avec AES-256-GCM. Le nonce rend chaque chiffrement unique, et le tag est une signature d'intégrité.",
    explication: "Une clé fausse ou un message modifié, même d'un seul bit, fait échouer la vérification du tag : aucun texte partiel n'est révélé.",
  },
  {
    titre: "4. Ce qui circule sur le réseau",
    description: "Sur le réseau passe uniquement une longue chaîne illisible : version, sel, nonce, texte chiffré et tag, le tout en base64.",
    explication: "C'est ce que verrait un espion. Sans la clé exacte, impossible de le lire. Teste-le ci-dessous.",
  },
];

function Donnee({ titre, valeur }) {
  return (
    <div className="champ">
      <div className="titre"><span>{titre}</span></div>
      <pre className="zone chiffre petit">{valeur}</pre>
    </div>
  );
}

const hexVersEspaces = (h) => h.replace(/(..)/g, "$1 ").trim();

export default function CommentCaMarche() {
  const [etape, setEtape] = useState(0);
  const [texte, setTexte] = useState("Bonjour, ceci est un message secret !");
  const [cle, setCle] = useState("motdepasse123");
  const [demo, setDemo] = useState(null);   // résultat de la démonstration (+ texte et clé utilisés)
  const [statut, setStatut] = useState(null);
  const [essai, setEssai] = useState(null);
  const [enCours, setEnCours] = useState(false);
  const courante = ETAPES[etape];

  async function lancer(ev) {
    ev.preventDefault();
    setEnCours(true);
    setEssai(null);
    try {
      const r = await post("/api/demo", { texte, cle });
      setDemo({ ...r, texteUtilise: texte.trim(), cleUtilisee: cle });
      setStatut({ type: "ok", texte: "Calculé avec de vraies valeurs. Parcours les étapes." });
      setEtape(0);
    } catch (e) {
      setStatut({ type: "erreur", texte: e.message });
    } finally {
      setEnCours(false);
    }
  }

  async function essayer(cleEssai) {
    try {
      const r = await post("/api/dechiffrer", { crypte: demo.message, cle: cleEssai });
      setEssai({ type: "ok", texte: `Clé correcte : le message est déchiffré (« ${r.clair} »).` });
    } catch (e) {
      setEssai({ type: "erreur", texte: e.message });
    }
  }

  // Même clé avec le dernier caractère changé
  const cleFausse = demo ? demo.cleUtilisee.slice(0, -1) + (demo.cleUtilisee.endsWith("x") ? "y" : "x") : "";

  return (
    <div className="panneau">
      <h2 className="titre-page">Comment ça marche : le chiffrement pas à pas</h2>

      <form onSubmit={lancer} className="panneau encadre">
        <p className="note">Écris un texte et une clé, puis lance la démonstration : chaque étape montrera les vraies valeurs calculées. Rien n'est envoyé ni enregistré.</p>
        <div className="duo">
          <div className="champ">
            <div className="titre"><label htmlFor="demo-texte">Texte</label></div>
            <input id="demo-texte" value={texte} maxLength={200} onChange={(e) => setTexte(e.target.value)} />
          </div>
          <div className="champ">
            <div className="titre"><label htmlFor="demo-cle">Clé (8 caractères minimum)</label></div>
            <input id="demo-cle" value={cle} onChange={(e) => setCle(e.target.value)} />
          </div>
        </div>
        <div className="action">
          <button type="submit" className="bouton" disabled={enCours}>Lancer la démonstration</button>
          {statut && <p className={`statut ${statut.type}`} role="status">{statut.texte}</p>}
        </div>
      </form>

      <ol className="etapes" aria-label="Progression">
        {ETAPES.map((e, i) => (
          <li key={e.titre}>
            <button type="button" className={i === etape ? "actif" : ""} aria-current={i === etape ? "step" : undefined}
                    aria-label={e.titre} onClick={() => setEtape(i)}>
              {i + 1}
            </button>
          </li>
        ))}
      </ol>

      <div className="etape-corps" aria-live="polite">
        <h3>{courante.titre}</h3>
        <p>{courante.description}</p>
        <p className="note">{courante.explication}</p>
      </div>

      {!demo && <p className="note">Lance la démonstration pour voir les valeurs réelles de cette étape.</p>}

      {demo && etape === 0 && (
        <>
          <Donnee titre="Ton texte" valeur={demo.texteUtilise} />
          <Donnee titre={`Le même texte en octets (hexadécimal, ${demo.texte_hex.length / 2} octets)`} valeur={hexVersEspaces(demo.texte_hex)} />
        </>
      )}
      {demo && etape === 1 && (
        <>
          <Donnee titre="Sel aléatoire (16 octets)" valeur={hexVersEspaces(demo.sel)} />
          <Donnee titre="Clé AES-256 obtenue avec ta clé et ce sel (32 octets)" valeur={hexVersEspaces(demo.cle_derivee)} />
        </>
      )}
      {demo && etape === 2 && (
        <>
          <Donnee titre="Nonce aléatoire (12 octets)" valeur={hexVersEspaces(demo.nonce)} />
          <Donnee titre="Texte chiffré" valeur={hexVersEspaces(demo.chiffre)} />
          <Donnee titre="Tag d'intégrité (16 octets)" valeur={hexVersEspaces(demo.tag)} />
        </>
      )}
      {demo && etape === 3 && (
        <>
          <Donnee titre={`Message envoyé sur le réseau (${demo.taille} caractères)`} valeur={demo.message} />
          <div className="action">
            <button type="button" className="bouton" onClick={() => essayer(demo.cleUtilisee)}>Déchiffrer avec la bonne clé</button>
            <button type="button" className="bouton secondaire" onClick={() => essayer(cleFausse)}>Avec une clé fausse d'un caractère</button>
          </div>
          {essai && <p className={`statut ${essai.type}`} role="status">{essai.texte}</p>}
        </>
      )}

      <div className="action">
        <button type="button" className="bouton secondaire" onClick={() => setEtape(etape - 1)} disabled={etape === 0}>
          ← Précédent
        </button>
        <button type="button" className="bouton" onClick={() => setEtape(etape + 1)} disabled={etape === ETAPES.length - 1}>
          Suivant →
        </button>
        {etape > 0 && (
          <button type="button" className="lien" onClick={() => setEtape(0)}>Recommencer</button>
        )}
      </div>

      <div className="etape-corps">
        <h3>Avec la clé de ton contact : plus de mot de passe à partager</h3>
        <p>
          Dans l'onglet Contacts, chaque PC possède une paire de clés RSA-3072. Ils s'échangent leurs clés publiques (signées en RSA-PSS), puis l'un
          crée une clé secrète aléatoire et l'envoie chiffrée avec la clé publique de l'autre (RSA-OAEP) : seul son destinataire peut l'ouvrir.
          Elle est rangée dans le coffre, protégé par un mot de passe.
        </p>
        <p className="note">
          Reste une question : parle-t-on bien à la bonne personne ? Chaque PC affiche un code de sécurité : s'il est identique
          des deux côtés, personne ne s'est glissé au milieu de l'échange.
        </p>
      </div>

      <div className="etape-corps">
        <h3>Les autres protections</h3>
        <p>
          <strong>Anti-rejeu :</strong> chaque message chiffré est unique. Si quelqu'un capture un message puis le renvoie tel quel,
          il est reconnu et ignoré.
        </p>
        <p>
          <strong>Accusés de réception :</strong> ✓ envoyé, ✓✓ remis sur le PC du contact, ✓✓ lu une fois déchiffré. Les accusés « remis » et « lu »
          sont signés avec la clé échangée : un faux accusé est rejeté. Si ton contact a verrouillé son coffre, « remis » n'apparaît qu'à son déverrouillage.
        </p>
        <p>
          <strong>Pièces jointes :</strong> les fichiers sont chiffrés comme les messages, avec la clé échangée avec ton contact, et rangés chiffrés sur le disque.
        </p>
        <p className="note">
          Limite : les messages et fichiers à clé saisie n'ont pas de clé partagée pour signer les accusés : un intrus sur le réseau pourrait fabriquer un faux « remis ». Il n'y a pas de « lu » pour eux.
        </p>
      </div>
    </div>
  );
}
