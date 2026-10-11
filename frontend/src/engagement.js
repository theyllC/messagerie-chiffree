/* Brique d'engagement (schéma d'engagement par hachage) : réutilisable par tous les jeux qui cachent une information puis la révèlent
   (pierre-feuille-ciseaux aujourd'hui, bataille navale, vote vérifiable, poker « mental » demain).

   S'engager : on publie H = SHA-256(champs | sel). Révéler : on publie la valeur et le sel, et chacun vérifie H.
   - Le sel (128 bits tirés au hasard) rend l'empreinte indevinable : sans lui, on retrouverait la valeur en essayant les possibilités.
   - Les champs de contexte (partie, manche, côté…) lient l'engagement à un endroit précis : on ne peut pas le rejouer ailleurs
     ni republier l'empreinte de l'adversaire comme la sienne.
   - Le séparateur « | » est interdit dans les champs : sinon deux contextes différents pourraient donner le même texte haché
     (par exemple ["a|b", "c"] et ["a", "b|c"]). */
import { sha256Hex } from "./sha256.js";

const SEPARATEUR = "|";

/* Texte haché : champs et sel séparés par « | ». Lève une erreur si un champ contient le séparateur. */
export function texteEngagement(champs, sel) {
  const tous = [...champs, sel].map(String);
  if (tous.some((c) => c.includes(SEPARATEUR))) throw new Error("Champ d'engagement invalide : le séparateur « | » est réservé.");
  return tous.join(SEPARATEUR);
}

export const empreinte = (champs, sel) => sha256Hex(texteEngagement(champs, sel));

/* Vrai seulement si l'empreinte publiée h correspond à ces champs et à ce sel. Ne lève jamais d'erreur : une valeur mal formée
   (venant d'un autre joueur) est simplement une révélation fausse. */
export function verifierEngagement(h, champs, sel) {
  try {
    return typeof h === "string" && empreinte(champs, sel) === h;
  } catch {
    return false;
  }
}

/* Sel de 128 bits (32 caractères hexadécimaux), tiré avec le générateur cryptographique du navigateur. */
export function selAleatoire() {
  const octets = new Uint8Array(16);
  crypto.getRandomValues(octets);
  return [...octets].map((o) => o.toString(16).padStart(2, "0")).join("");
}

/* Coffre des secrets : ma valeur et mon sel doivent rester dans CE navigateur entre l'engagement et la révélation (sinon une page
   rechargée ne pourrait plus révéler). Ils ne sont jamais envoyés avant la révélation. La clé garde le format historique du
   pierre-feuille-ciseaux (« mc-pfc:portée:partie:manche ») : les parties en cours survivent à la mise à jour. */
export const cleSecret = (jeu, portee, ...ids) => `mc-${jeu}:${portee}:${ids.join(":")}`;

/* Le secret rangé sous cette clé, ou null. valide(secret) vérifie la forme propre au jeu. */
export function lireSecret(cle, valide = () => true) {
  try {
    const v = JSON.parse(localStorage.getItem(cle));
    return v && typeof v.x === "string" && typeof v.h === "string" && valide(v) ? v : null;
  } catch {
    return null;
  }
}

export function ecrireSecret(cle, secret) {
  try {
    localStorage.setItem(cle, JSON.stringify(secret));
    return true;
  } catch {
    return false;  // stockage indisponible : la révélation automatique échouera, l'interface le signale
  }
}
