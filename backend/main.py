"""Serveur local : relie l'interface React au réseau (sockets TCP)."""
import base64
import binascii
import hashlib
import hmac
import json
import math
import os
import secrets
import socket
import sys
import threading
import re
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import uvicorn
from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import mise_a_jour

app = FastAPI()

# Les valeurs par défaut conviennent ; les variables d'environnement servent aux tests
# (lancer deux instances sur le même PC).
PORT_SOCKET = int(os.environ.get("MC_PORT_SOCKET", 5000))  # port où les autres PC envoient leurs messages
PORT_WEB = int(os.environ.get("MC_PORT_WEB", 8000))        # port de l'interface (ce PC seulement)
HOTE_ECOUTE = os.environ.get("MC_HOTE", "0.0.0.0")
PORT_UDP = int(os.environ.get("MC_PORT_UDP", 5001))          # port de la détection par diffusion (UDP)
DIFFUSION_SUPP = [a.strip() for a in os.environ.get("MC_DIFFUSION", "").split(",") if a.strip()]  # adresses à sonder en plus (tests)
CLE_MIN = 8            # longueur minimale de la clé secrète
MDP_MIN = 8            # longueur minimale du mot de passe du coffre
MAX_HISTORIQUE = 500   # nombre maximal d'entrées conservées
MAX_MESSAGE = 4000     # longueur maximale d'un message en clair (caractères)
MAX_RECU = 6 * 1024 * 1024    # taille maximale acceptée à la réception (octets), pièces jointes comprises
MAX_FICHIER = 2 * 1024 * 1024  # taille maximale d'une pièce jointe (octets)
SEUIL_BLOB = 32 * 1024         # au-delà, le message chiffré est rangé dans son propre fichier
MAX_DEMANDES = 20      # demandes d'échange de clés en attente, au maximum
RSA_BITS = 3072        # taille des clés RSA générées par ce programme
RSA_MIN, RSA_MAX = 3072, 8192  # tailles acceptées pour la clé d'un contact (les clés plus faibles sont refusées)
# Dans l'.exe, PyInstaller décompresse le front dans sys._MEIPASS
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
DIST = BASE / "frontend" / "dist"
# L'historique ne contient que des messages chiffrés, jamais le texte en clair.
DOSSIER = Path(os.environ.get("APPDATA") or Path.home()) / "MessagerieChiffree"
FICHIER = DOSSIER / "historique.json"
FICHIER_CONTACTS = DOSSIER / "contacts.json"
FICHIER_COFFRE = DOSSIER / "coffre.json"
FICHIER_ECHANGES = DOSSIER / "echanges.json"
FICHIER_VUS = DOSSIER / "vus.json"
FICHIER_PARAMETRES = DOSSIER / "parametres.json"
DOSSIER_BLOBS = DOSSIER / "fichiers"  # gros messages chiffrés (pièces jointes), hors de l'historique
FICHIER_PROFIL = DOSSIER / "profil.json"                    # mon pseudo et mon avatar
FICHIER_PROFILS_DISTANTS = DOSSIER / "profils_distants.json"  # pseudo et avatar des autres PC {ip: {pseudo, avatar}}
FICHIER_FILE = DOSSIER / "file_attente.json"                # messages en attente d'un destinataire hors ligne
MAX_VUS = 5000         # empreintes de messages déjà vus (anti-rejeu)
MAX_PSEUDO = 20        # longueur maximale du pseudo (caractères)
MAX_AVATAR = 4         # longueur maximale de l'avatar (points de code : un émoji peut en compter 2, avec son sélecteur)
MAX_FILE = 50          # messages en attente au maximum
MAX_TENTATIVES = 20    # essais de réexpédition avant abandon
INTERVALLE_FILE = float(os.environ.get("MC_INTERVALLE_FILE", 15))  # secondes entre deux passages sur la file
MAX_GROUPE = 50        # destinataires d'un envoi groupé, au maximum
FICHIER_RELAIS = DOSSIER / "relais.json"                    # salle de classe rejointe (adresse du relais, identifiant, jeton)
INTERVALLE_RELAIS = float(os.environ.get("MC_INTERVALLE_RELAIS", 2))  # secondes entre deux relevés de la boîte du relais
PORT_RELAIS_DEFAUT = 8100
INTERVALLE_SALON = float(os.environ.get("MC_INTERVALLE_SALON", 4))  # secondes entre deux tours de distribution des clés du salon
PREFIXE_RELAIS = "relais:"  # un contact joignable par le relais a pour adresse « relais:<id> » au lieu d'une IP

verrou = threading.RLock()


def b64e(octets):
    return base64.b64encode(octets).decode("ascii")


def b64d(texte):
    return base64.b64decode(texte, validate=True)


def maintenant():
    return datetime.now().isoformat(timespec="seconds")


def ecrire_json(chemin, donnees):
    """Écriture atomique. À appeler avec le verrou pris. Renvoie False si l'écriture échoue."""
    try:
        chemin.parent.mkdir(parents=True, exist_ok=True)
        tmp = chemin.with_suffix(".tmp")
        tmp.write_text(json.dumps(donnees, ensure_ascii=False), encoding="utf-8")
        tmp.replace(chemin)
        return True
    except OSError:
        return False  # les données restent disponibles en mémoire jusqu'à la fermeture


def lire_json(chemin, defaut):
    try:
        return json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return defaut


# --- Historique (envoyés et reçus), conservé dans un fichier -----------------
def charger():
    donnees = lire_json(FICHIER, [])
    if not isinstance(donnees, list):
        return []
    cles = {"id", "sens", "crypte", "pair", "heure"}
    return [d for d in donnees if isinstance(d, dict) and cles <= d.keys() and isinstance(d["id"], int)]


def sauvegarder():
    """À appeler avec le verrou pris."""
    ecrire_json(FICHIER, historique)


historique = charger()


def ecrire_blob(h, crypte):
    try:
        DOSSIER_BLOBS.mkdir(parents=True, exist_ok=True)
        (DOSSIER_BLOBS / f"{h}.txt").write_text(crypte, encoding="ascii")
        return True
    except OSError:
        return False


def crypte_de(m):
    """Message chiffré complet d'une entrée (relu depuis son fichier s'il est volumineux)."""
    if not m.get("blob"):
        return m["crypte"]
    try:
        return (DOSSIER_BLOBS / f"{m['h']}.txt").read_text(encoding="ascii")
    except (OSError, KeyError):
        return ""


def h_de(m):
    return m.get("h") or empreinte(m["crypte"])


def nettoyer_blobs():
    """Supprime les fichiers de gros messages qui ne sont plus dans l'historique. Verrou pris."""
    try:
        presents = list(DOSSIER_BLOBS.iterdir())
    except OSError:
        return
    utiles = {f"{m['h']}.txt" for m in historique if m.get("blob")}
    for f in presents:
        if f.name not in utiles:
            try:
                f.unlink()
            except OSError:
                pass


def ajouter(sens, crypte, pair, statut=None):
    h = empreinte(crypte)
    with verrou:
        identifiant = (historique[-1]["id"] if historique else 0) + 1
        entree = {"id": identifiant, "sens": sens, "crypte": crypte, "pair": pair, "heure": maintenant(),
                  "h": h, "v": version_message(crypte)}
        if statut:
            entree["statut"] = statut  # messages envoyés : envoye -> remis -> lu
        if len(crypte) > SEUIL_BLOB and ecrire_blob(h, crypte):
            entree.update(crypte="", blob=True, taille=len(crypte))
        historique.append(entree)
        del historique[:-MAX_HISTORIQUE]
        purger()
        nettoyer_blobs()
        sauvegarder()
        return identifiant


def retirer(identifiant):
    with verrou:
        historique[:] = [m for m in historique if m["id"] != identifiant]
        nettoyer_blobs()
        sauvegarder()


def empreinte(crypte):
    """Identifiant court d'un message chiffré (même valeur chez l'émetteur et le destinataire)."""
    return hashlib.sha256(crypte.encode("ascii")).hexdigest()[:16]


ORDRE_STATUT = {"attente": -1, "envoye": 0, "remis": 1, "lu": 2}  # « attente » : pas encore parti (destinataire hors ligne)


def maj_statut(h, nouveau):
    """Fait avancer le statut d'un message envoyé (jamais en arrière). Verrou pris."""
    for m in historique:
        if m["sens"] == "envoye" and h_de(m) == h:
            if ORDRE_STATUT[nouveau] > ORDRE_STATUT.get(m.get("statut", "envoye"), 0):
                m["statut"] = nouveau
                sauvegarder()
            return


# --- Anti-rejeu : un même message chiffré n'est accepté qu'une seule fois ----
# Un attaquant qui capture un message ne peut pas le renvoyer : il serait identique octet pour octet.
_vus_liste = [h for h in lire_json(FICHIER_VUS, []) if isinstance(h, str)][-MAX_VUS:]
_vus = set(_vus_liste)


def marquer_vu(h):
    """Renvoie False si ce message a déjà été vu."""
    with verrou:
        if h in _vus:
            return False
        _vus.add(h)
        _vus_liste.append(h)
        while len(_vus_liste) > MAX_VUS:
            _vus.discard(_vus_liste.pop(0))
        ecrire_json(FICHIER_VUS, _vus_liste)
        return True


# --- Réglages ----------------------------------------------------------------
parametres = {"retention_jours": 0}  # 0 = ne jamais effacer automatiquement
_p = lire_json(FICHIER_PARAMETRES, {})
if isinstance(_p, dict) and isinstance(_p.get("retention_jours"), int) and 0 <= _p["retention_jours"] <= 3650:
    parametres["retention_jours"] = _p["retention_jours"]


def purger():
    """Supprime les messages plus anciens que la durée choisie. Verrou pris."""
    jours = parametres["retention_jours"]
    if jours <= 0:
        return
    limite = datetime.now() - timedelta(days=jours)
    garde = []
    for m in historique:
        try:
            if datetime.fromisoformat(m["heure"]) < limite:
                continue
        except ValueError:
            pass
        garde.append(m)
    if len(garde) != len(historique):
        historique[:] = garde
        nettoyer_blobs()
        sauvegarder()


# --- Carnet de contacts IP ↔ nom, conservé dans un fichier -------------------
def charger_contacts():
    donnees = lire_json(FICHIER_CONTACTS, {})
    if not isinstance(donnees, dict):
        return {}
    return {str(ip): str(nom) for ip, nom in donnees.items()}


contacts = charger_contacts()  # {ip: nom}


# --- Profils : pseudo + avatar (le mien, et ceux des autres PC) ---------------
# Rien de secret : le pseudo et l'avatar circulent en clair (détection UDP, demandes d'échange de clés).
def nettoyer_pseudo(valeur):
    if not isinstance(valeur, str):
        return ""
    return "".join(c for c in valeur if c.isprintable()).strip()[:MAX_PSEUDO]


def nettoyer_avatar(valeur):
    if not isinstance(valeur, str):
        return ""
    return "".join(c for c in valeur if c.isprintable() and not c.isspace())[:MAX_AVATAR]


def profil_propre(d):
    d = d if isinstance(d, dict) else {}
    return {"pseudo": nettoyer_pseudo(d.get("pseudo")), "avatar": nettoyer_avatar(d.get("avatar"))}


mon_profil = profil_propre(lire_json(FICHIER_PROFIL, {}))
_pd = lire_json(FICHIER_PROFILS_DISTANTS, {})
profils_distants = {str(ip): profil_propre(p) for ip, p in _pd.items()} if isinstance(_pd, dict) else {}


def retenir_profil_distant(ip, pseudo, avatar):
    """Mémorise le profil annoncé par un autre PC (ignoré s'il est vide). Verrou pris par l'appelant ou non : on le prend ici."""
    p = profil_propre({"pseudo": pseudo, "avatar": avatar})
    if not (p["pseudo"] or p["avatar"]):
        return
    with verrou:
        if profils_distants.get(ip) != p:
            profils_distants[ip] = p
            ecrire_json(FICHIER_PROFILS_DISTANTS, profils_distants)


def champs_profil():
    """Pseudo et avatar à joindre aux trames envoyées aux autres PC."""
    return {"pseudo": mon_profil["pseudo"], "avatar": mon_profil["avatar"]}


# --- Chiffrement par mot de passe (version 1) --------------------------------
# AES-256-GCM, clé dérivée du mot de passe avec scrypt.
# Format : base64( 0x01 | sel (16) | nonce (12) | données + tag )
def deriver(cle, sel):
    return Scrypt(salt=sel, length=32, n=2**15, r=8, p=1).derive(cle.encode("utf-8"))


def chiffrer(texte, cle):
    sel, nonce = os.urandom(16), os.urandom(12)
    donnees = AESGCM(deriver(cle, sel)).encrypt(nonce, texte.encode("utf-8"), b"v1")
    return b64e(b"\x01" + sel + nonce + donnees)


# --- Chiffrement avec la clé d'un contact (version 2) ------------------------
# Format : base64( 0x02 | identifiant de clé (8) | nonce (12) | données + tag )
# L'identifiant ne révèle rien de la clé : il sert à retrouver la bonne clé dans le coffre.
def id_cle(cle):
    return hashlib.sha256(b"id" + cle).digest()[:8]


def chiffrer_v2(texte, cle):
    kid, nonce = id_cle(cle), os.urandom(12)
    donnees = AESGCM(cle).encrypt(nonce, texte.encode("utf-8"), b"v2" + kid)
    return b64e(b"\x02" + kid + nonce + donnees)


def chiffrer_v3(texte, cle):
    """Version 3 : même structure que la v2, pour les pièces jointes (contenu = enveloppe JSON)."""
    kid, nonce = id_cle(cle), os.urandom(12)
    donnees = AESGCM(cle).encrypt(nonce, texte.encode("utf-8"), b"v3" + kid)
    return b64e(b"\x03" + kid + nonce + donnees)


def chiffrer_v4(texte, mdp):
    """Version 4 : pièce jointe protégée par une clé saisie à la main (comme la v1), sans échange de clés préalable."""
    sel, nonce = os.urandom(16), os.urandom(12)
    donnees = AESGCM(deriver(mdp, sel)).encrypt(nonce, texte.encode("utf-8"), b"v4")
    return b64e(b"\x04" + sel + nonce + donnees)


# --- Chiffrement RSA direct (version 5) --------------------------------------
# Pour un contact dont on a seulement importé la clé publique (sans échange réseau) : une clé AES est tirée au
# hasard, chiffrée avec la clé publique du destinataire (RSA-OAEP), et le message est chiffré avec cette clé.
# Format : base64( 0x05 | longueur de wrap (2) | wrap | nonce (12) | données + tag )
# Seul le destinataire (clé privée) peut l'ouvrir. L'expéditeur n'est pas authentifié : n'importe qui
# connaissant ta clé publique peut t'écrire en v5.
def chiffrer_v5(texte, pub):
    cle_pub = charger_pub_rsa(pub)
    if cle_pub is None:
        raise ValueError("clé publique invalide")
    cle, nonce = os.urandom(32), os.urandom(12)
    wrap = cle_pub.encrypt(cle, OAEP)
    donnees = AESGCM(cle).encrypt(nonce, texte.encode("utf-8"), b"v5" + wrap)
    return b64e(b"\x05" + len(wrap).to_bytes(2, "big") + wrap + nonce + donnees)


def lire_v5(brut):
    """Octets d'un message v5 -> (wrap, nonce, données). ValueError si la structure est incohérente."""
    n = int.from_bytes(brut[1:3], "big")
    if not RSA_MIN // 8 <= n <= RSA_MAX // 8 or len(brut) < 3 + n + 12 + 16:
        raise ValueError("format invalide")
    return brut[3:3 + n], brut[3 + n:15 + n], brut[15 + n:]


def nom_sur(nom):
    """Nom de fichier sans dossier ni caractère interdit."""
    nom = nom.replace("\\", "/").split("/")[-1]
    nom = "".join(c for c in nom if c.isprintable() and c not in '<>:"|?*').strip(". ")
    return nom[:120] or "fichier"


def lire_enveloppe_fichier(texte):
    """Contenu déchiffré d'un message v3 -> {nom, type, donnees (base64), taille}."""
    try:
        e = json.loads(texte)
        nom, mime, donnees = e["n"], e["t"], e["d"]
        if not all(isinstance(x, str) for x in (nom, mime, donnees)):
            raise ValueError
        taille = len(b64d(donnees))
    except (ValueError, KeyError, TypeError):
        raise ValueError("fichier invalide")
    return {"nom": nom_sur(nom), "type": mime[:100], "donnees": donnees, "taille": taille}


def decoder(crypte):
    """Renvoie les octets du message ou lève ValueError si le format est invalide."""
    try:
        brut = base64.b64decode(crypte, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("format invalide")
    # v1 et v4 : 1 + 16 + 12 + tag (16) = 45 octets minimum ; v2 et v3 : 1 + 8 + 12 + 16 = 37 ; v5 : RSA wrap + 31
    if not brut or not ((brut[0] in (1, 4) and len(brut) >= 45) or (brut[0] in (2, 3) and len(brut) >= 37)
                     or (brut[0] == 5 and len(brut) >= 3 + RSA_MIN // 8 + 12 + 16)):
        raise ValueError("format invalide")
    if brut[0] == 5:
        lire_v5(brut)  # structure vérifiée dès la réception
    return brut


def version_message(crypte):
    try:
        return decoder(crypte)[0]
    except ValueError:
        return 0


def ip_locale():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# --- Coffre : identité RSA + clés des contacts, chiffré par un mot de passe
# Le fichier coffre.json contient tout, chiffré en AES-256-GCM (clé dérivée par scrypt).
# Tant que le coffre est verrouillé, aucune clé n'est en mémoire.
salon_cles = {}  # {époque: clé AES-256 du salon (32 octets)} : en mémoire seulement, jamais écrite sur disque
coffre = {"cle": None, "sel": None, "donnees": None}  # donnees is None <=> verrouillé


def etat_coffre():
    if coffre["donnees"] is not None:
        return "ouvert"
    return "verrouille" if FICHIER_COFFRE.exists() else "absent"


MSG_VERROUILLE = "Le coffre est verrouillé : déverrouille-le dans l'onglet Contacts."


def exiger_ouvert():
    if coffre["donnees"] is None:
        raise HTTPException(423, MSG_VERROUILLE)


def sauver_coffre():
    """À appeler avec le verrou pris, coffre ouvert."""
    nonce = os.urandom(12)
    clair = json.dumps(coffre["donnees"]).encode("utf-8")
    bloc = AESGCM(coffre["cle"]).encrypt(nonce, clair, b"coffre-v1")
    if not ecrire_json(FICHIER_COFFRE, {"v": 1, "sel": b64e(coffre["sel"]),
                                        "nonce": b64e(nonce), "data": b64e(bloc)}):
        raise HTTPException(500, "Impossible d'écrire le coffre sur le disque.")


def nouvelle_identite():
    """Paire de clés RSA de ce PC. La clé privée ne quitte jamais le coffre."""
    prive = rsa.generate_private_key(public_exponent=65537, key_size=RSA_BITS)
    return {
        "rsa_date": maintenant(),
        "rsa_prive": b64e(prive.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption())),
        "rsa_publique": b64e(prive.public_key().public_bytes(serialization.Encoding.DER,
                                                             serialization.PublicFormat.SubjectPublicKeyInfo)),
    }


def creer_coffre(mdp):
    sel = os.urandom(16)
    donnees = {**nouvelle_identite(), "cles": {}}  # cles : {ip: {"cle", "pub", "verifie", "date", "algo", "anciennes"}}
    coffre.update(cle=deriver(mdp, sel), sel=sel, donnees=donnees)
    sauver_coffre()


def migrer_vers_rsa():
    """Coffre créé avec l'ancien échange X25519 : les clés des contacts restent valables (ce sont de simples
    clés secrètes), on fige leur code de sécurité d'origine, puis on remplace l'identité par une paire RSA.
    Verrou pris, coffre ouvert. Renvoie True si le coffre a été modifié."""
    d = coffre["donnees"]
    if "rsa_prive" in d:
        return False
    ancienne = d.pop("publique", None)
    d.pop("prive", None)
    for k in d["cles"].values():
        k.setdefault("algo", "x25519")
        if ancienne and "code" not in k:
            try:
                k["code"] = code_paire(b64d(ancienne), b64d(k["pub"]))
            except (binascii.Error, ValueError, KeyError):
                pass
    d.update(nouvelle_identite())
    return True


def ouvrir_coffre(mdp):
    d = lire_json(FICHIER_COFFRE, None)
    try:
        sel = b64d(d["sel"])
        cle = deriver(mdp, sel)
        clair = AESGCM(cle).decrypt(b64d(d["nonce"]), b64d(d["data"]), b"coffre-v1")
        donnees = json.loads(clair)
    except InvalidTag:
        raise HTTPException(400, "Mot de passe incorrect.")
    except (TypeError, KeyError, ValueError):
        raise HTTPException(500, "Le fichier du coffre est illisible. Tu peux le réinitialiser.")
    coffre.update(cle=cle, sel=sel, donnees=donnees)
    if migrer_vers_rsa():
        sauver_coffre()


def verrouiller_coffre():
    coffre.update(cle=None, sel=None, donnees=None)
    salon_cles.clear()  # les clés du salon ne restent jamais en mémoire coffre fermé


PSS = padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH)
OAEP = padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


def charger_pub_rsa(pub):
    """Clé publique RSA (DER en base64) -> objet, ou None si elle est invalide ou trop faible."""
    if not isinstance(pub, str) or len(pub) > 4096:
        return None
    try:
        cle = serialization.load_der_public_key(b64d(pub))
    except (binascii.Error, ValueError):
        return None
    if isinstance(cle, rsa.RSAPublicKey) and RSA_MIN <= cle.key_size <= RSA_MAX and cle.public_numbers().e == 65537:
        return cle
    return None


def pub_valide(pub):
    return charger_pub_rsa(pub) is not None


def cle_privee():
    return serialization.load_der_private_key(b64d(coffre["donnees"]["rsa_prive"]), password=None)


def signer(message):
    """Signature RSA-PSS de ce PC. Coffre ouvert."""
    return cle_privee().sign(message, PSS, hashes.SHA256())


def signature_valide(pub, signature, message):
    cle = charger_pub_rsa(pub)
    if cle is None or not isinstance(signature, str) or len(signature) > 2048:
        return False
    try:
        cle.verify(b64d(signature), message, PSS, hashes.SHA256())
        return True
    except (InvalidSignature, binascii.Error, ValueError):
        return False


# Ce que chaque PC signe : le jeton de la demande lie la réponse à la demande, la clé publique prouve
# la possession de la clé privée, et « wrap » (la clé secrète chiffrée) ne peut pas être remplacé.
def transcrit_hello(jeton, pub):
    return b"hello-v1|" + jeton.encode("utf-8") + b"|" + b64d(pub)


def transcrit_ack(jeton, pub, wrap):
    return b"ack-v1|" + jeton.encode("utf-8") + b"|" + b64d(pub) + b"|" + wrap


def code_paire(pub1, pub2):
    """Code à comparer à voix haute avec le contact : il doit être identique sur les deux PC."""
    h = hashlib.sha256(b"".join(sorted([pub1, pub2]))).digest()
    return " ".join(str(int.from_bytes(h[i * 4:i * 4 + 4], "big") % 100000).zfill(5) for i in range(6))


def code_securite(pub_distante):
    return code_paire(b64d(coffre["donnees"]["rsa_publique"]), b64d(pub_distante))


def enregistrer_cle(ip, cle, pub):
    """Mémorise la clé secrète échangée avec ce contact. Une clé précédente est gardée de côté :
    elle sert encore à relire les anciens messages. Verrou pris, coffre ouvert."""
    cles = coffre["donnees"]["cles"]
    avant = cles.get(ip)
    anciennes = []
    if avant:
        anciennes = ([{"cle": avant["cle"], "date": avant["date"]}] + avant.get("anciennes", []))[:5]
    cles[ip] = {"cle": b64e(cle), "pub": pub, "verifie": False, "date": maintenant(),
                "algo": "rsa", "anciennes": anciennes}


def cle_par_id(kid):
    for k in coffre["donnees"]["cles"].values():
        for c in [k["cle"]] + [a["cle"] for a in k.get("anciennes", [])]:
            cle = b64d(c)
            if id_cle(cle) == kid:
                return cle
    return None


def dechiffrer(crypte, cle):
    brut = decoder(crypte)
    if brut[0] in (1, 4):
        sel, nonce, donnees = brut[1:17], brut[17:29], brut[29:]
        return AESGCM(deriver(cle, sel)).decrypt(nonce, donnees, b"v%d" % brut[0]).decode("utf-8")
    if brut[0] == 5:
        wrap, nonce, donnees = lire_v5(brut)
        with verrou:
            exiger_ouvert()
            cle_aes = cle_privee().decrypt(wrap, OAEP)  # lève ValueError si ce message n'est pas pour nous
        return AESGCM(cle_aes).decrypt(nonce, donnees, b"v5" + wrap).decode("utf-8")
    kid, nonce, donnees = brut[1:9], brut[9:21], brut[21:]
    with verrou:
        exiger_ouvert()
        cle_contact = cle_par_id(kid)
    if cle_contact is None:
        raise LookupError("aucune clé échangée ne correspond à ce message")
    return AESGCM(cle_contact).decrypt(nonce, donnees, b"v%d" % brut[0] + kid).decode("utf-8")


# --- Échange de clés par RSA : poignée de main hello / ack -------------------
# A -> B : {"t":"hello","pub":clé publique RSA de A,"r":jeton,"sig":signature de A}
#          B voit une demande et l'accepte.
# B -> A : {"t":"ack","pub":clé publique de B,"r":même jeton,"sig":signature de B,
#           "wrap":clé secrète tirée au hasard par B, chiffrée avec la clé publique de A (RSA-OAEP)}
# A ouvre « wrap » avec sa clé privée : les deux PC ont la même clé secrète, qui n'a jamais circulé en clair.
# Les demandes en attente (clés publiques seulement) sont conservées dans echanges.json,
# même coffre verrouillé.
def charger_echanges():
    d = lire_json(FICHIER_ECHANGES, {})
    d = d if isinstance(d, dict) else {}
    sortie = {k: d.get(k) if isinstance(d.get(k), dict) else {} for k in ("demandes", "sortants", "acks", "lus", "remis")}
    # Les demandes et réponses de l'ancien échange (X25519) ne sont plus valables
    sortie["demandes"] = {ip: v for ip, v in sortie["demandes"].items() if isinstance(v, dict) and pub_valide(v.get("pub"))}
    sortie["acks"] = {j: v for j, v in sortie["acks"].items() if isinstance(v, dict) and pub_valide(v.get("pub"))}
    return sortie


echanges = charger_echanges()  # demandes {ip: {pub, r, heure}} · sortants {jeton: {ip, heure}} · acks {jeton: {pub, wrap}} · lus {empreinte: mac}


def sauver_echanges():
    ecrire_json(FICHIER_ECHANGES, echanges)


def finaliser_acks():
    """Termine les échanges initiés par ce PC dont la réponse est arrivée. Verrou pris, coffre ouvert."""
    if coffre["donnees"] is None:
        return
    modifie = False
    for jeton, ack in list(echanges["acks"].items()):
        cible = echanges["sortants"].pop(jeton, None)
        echanges["acks"].pop(jeton, None)
        modifie = True
        if not cible:
            continue
        try:
            cle = cle_privee().decrypt(b64d(ack["wrap"]), OAEP)
        except (KeyError, TypeError, ValueError, binascii.Error):
            continue  # réponse illisible : l'échange est abandonné
        if len(cle) == 32:
            enregistrer_cle(cible["ip"], cle, ack["pub"])
    if modifie:
        sauver_coffre()
        sauver_echanges()


def mac_lu(cle, h):
    return hmac.new(cle, b"lu" + bytes.fromhex(h), "sha256").hexdigest()[:32]


def mac_remis(cle, h):
    return hmac.new(cle, b"remis" + bytes.fromhex(h), "sha256").hexdigest()[:32]


def finaliser_lus():
    """Valide les accusés « remis » et « lu » reçus (signés avec la clé du contact). Verrou pris, coffre ouvert."""
    if coffre["donnees"] is None or not (echanges["lus"] or echanges["remis"]):
        return
    for nom, statut, signer in (("lus", "lu", mac_lu), ("remis", "remis", mac_remis)):
        for h, mac in list(echanges[nom].items()):
            del echanges[nom][h]
            entree = next((m for m in historique if m["sens"] == "envoye" and h_de(m) == h), None)
            if entree is None:
                continue
            try:
                brut = decoder(crypte_de(entree))
            except ValueError:
                continue
            cle = cle_par_id(brut[1:9]) if brut[0] in (2, 3) else None
            if cle is not None and hmac.compare_digest(signer(cle, h), mac):
                maj_statut(h, statut)
    sauver_echanges()


def envoyer_silencieux(ip, trame):
    try:
        transmettre(ip, json.dumps(trame), 3)
    except OSError:
        pass  # un accusé perdu n'est pas grave


def signaler_lu(entree):
    """Prévient l'émetteur que son message a été déchiffré (accusé signé). Verrou pris, coffre ouvert."""
    if entree["sens"] != "recu" or entree.get("lu_envoye"):
        return
    try:
        brut = decoder(crypte_de(entree))
    except ValueError:
        return
    cle = cle_par_id(brut[1:9]) if brut[0] in (2, 3) else None
    if cle is None:
        return
    entree["lu_envoye"] = True
    sauvegarder()
    h = h_de(entree)
    trame = {"t": "lu", "h": h, "mac": mac_lu(cle, h)}
    threading.Thread(target=envoyer_silencieux, args=(entree["pair"], trame), daemon=True).start()


def signaler_remis(entree):
    """Accuse réception d'un message reçu. Signé avec la clé du contact quand le message l'utilise (coffre ouvert) ;
    sinon, il part plus tard, à l'ouverture du coffre. Un message à clé manuelle (v1) n'a pas de clé partagée : accusé non signé."""
    if entree["sens"] != "recu" or entree.get("remis_envoye"):
        return
    try:
        brut = decoder(crypte_de(entree))
    except ValueError:
        return
    h = h_de(entree)
    trame = {"t": "remis", "h": h}
    if brut[0] in (2, 3):
        cle = cle_par_id(brut[1:9]) if coffre["donnees"] is not None else None
        if cle is None:
            return  # coffre verrouillé (ou clé inconnue) : on réessaie à la prochaine ouverture
        trame["mac"] = mac_remis(cle, h)
    entree["remis_envoye"] = True
    sauvegarder()
    threading.Thread(target=envoyer_silencieux, args=(entree["pair"], trame), daemon=True).start()


def signaler_remis_en_attente():
    """À l'ouverture du coffre : envoie les accusés « remis » qui n'ont pas pu être signés. Verrou pris."""
    for m in list(historique):
        if m["sens"] == "recu" and not m.get("remis_envoye"):
            signaler_remis(m)


def hex16(h):
    return isinstance(h, str) and len(h) == 16 and all(c in "0123456789abcdef" for c in h)


def traiter_trame(texte, ip):
    try:
        m = json.loads(texte)
    except ValueError:
        return
    if not isinstance(m, dict):
        return
    t, h = m.get("t"), m.get("h")
    if t in ("remis", "lu"):  # accusés de réception
        if not hex16(h):
            return
        with verrou:
            if not any(x["sens"] == "envoye" and h_de(x) == h for x in historique):
                return  # accusé pour un message inconnu
            entree = next(x for x in historique if x["sens"] == "envoye" and h_de(x) == h)
            if t == "remis" and version_message(crypte_de(entree)) not in (2, 3):
                maj_statut(h, "remis")  # clé manuelle : aucune clé partagée pour signer, accusé non signé
            elif isinstance(m.get("mac"), str) and len(m["mac"]) == 32:
                echanges["lus" if t == "lu" else "remis"][h] = m["mac"]
                sauver_echanges()
                finaliser_lus()  # sinon, validé à la prochaine ouverture du coffre
        return
    if t not in ("hello", "ack") or not pub_valide(m.get("pub")) or not isinstance(m.get("r"), str) or len(m["r"]) > 64:
        return
    pub, jeton = m["pub"], m["r"]
    if t == "hello":
        if not signature_valide(pub, m.get("sig"), transcrit_hello(jeton, pub)):
            return  # l'expéditeur ne prouve pas qu'il possède la clé privée
        retenir_profil_distant(ip, m.get("pseudo"), m.get("avatar"))
        with verrou:
            if ip in echanges["demandes"] or len(echanges["demandes"]) < MAX_DEMANDES:
                echanges["demandes"][ip] = {"pub": pub, "r": jeton, "heure": maintenant()}
                sauver_echanges()
        return
    with verrou:
        attendu = jeton in echanges["sortants"]
    if not attendu:
        return  # réponse à une demande que ce PC n'a pas faite
    wrap = m.get("wrap")
    try:
        wrap_brut = b64d(wrap)
    except (TypeError, binascii.Error, ValueError):
        return
    if not 0 < len(wrap_brut) <= 1100 or not signature_valide(pub, m.get("sig"), transcrit_ack(jeton, pub, wrap_brut)):
        return
    with verrou:
        cible = echanges["sortants"].get(jeton)
    if cible:
        retenir_profil_distant(cible["ip"], m.get("pseudo"), m.get("avatar"))
    with verrou:
        if jeton in echanges["sortants"]:
            echanges["acks"][jeton] = {"pub": pub, "wrap": wrap}
            sauver_echanges()
            finaliser_acks()


def envoyer_trame(ip, donnees):
    try:
        transmettre(ip, donnees, 5)
    except OSError as e:
        if est_relais(ip):
            raise HTTPException(502, f"Le relais n'a pas pu transmettre la demande : {getattr(e, 'detail', e)}")
        raise HTTPException(502, f"Connexion impossible à {ip}. Vérifie que le programme est "
                                 "ouvert sur ce PC et que l'adresse IP est correcte.")


# --- Relais de salle de classe (client) --------------------------------------
# Au lieu de contacter un PC par son IP, on dépose le message chiffré dans sa boîte sur un serveur relais
# (voir relais.py). Les contacts du relais ont pour adresse « relais:<id> » : tout le reste du programme (clés, accusés,
# conversations, file d'attente, envoi groupé) fonctionne sans changement, seul le transport diffère.
class ErreurRelais(OSError):
    """Le relais est injoignable (statut 0) ou a refusé la requête (statut HTTP)."""
    def __init__(self, statut, detail):
        super().__init__(detail)
        self.statut = statut
        self.detail = detail


def est_relais(adresse):
    return isinstance(adresse, str) and adresse.startswith(PREFIXE_RELAIS)


def charger_relais():
    d = lire_json(FICHIER_RELAIS, {})
    if isinstance(d, dict) and all(isinstance(d.get(k), str) and d[k] for k in ("url", "id", "token")):
        return {"url": d["url"], "id": d["id"], "token": d["token"], "salle": str(d.get("salle", ""))[:40]}
    return {}


relais_cfg = charger_relais()          # {url, id, token, salle} ou {} si aucune salle rejointe
relais_etat = {"connecte": False, "erreur": ""}
relais_membres = {}                    # annuaire en cache {id: {pseudo, avatar, en_ligne, role}}
relais_info = {"role": "eleve", "epoque": 0, "pub": None}  # mon rôle, l'époque de clé courante, la clé publique déjà publiée
verrou_salon = threading.RLock()
_sans_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # le relais est sur le réseau local : jamais via un proxy


def normaliser_url(texte):
    """« 192.168.1.10 », « 192.168.1.10:8100 » ou « http://… » -> « http://hote:port » (port 8100 par défaut), sinon None."""
    t = (texte or "").strip()
    if not t or len(t) > 200:
        return None
    if "://" not in t:
        t = "http://" + t
    u = urllib.parse.urlparse(t)
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    try:
        port = u.port or PORT_RELAIS_DEFAUT
    except ValueError:
        return None
    hote = f"[{u.hostname}]" if ":" in u.hostname else u.hostname
    return f"{u.scheme}://{hote}:{port}"


def lire_lien_relais(texte):
    """« mc-relais://hote:port/123456 » -> (url, code), sinon None."""
    m = re.fullmatch(r"\s*mc-relais://([^/\s]+)/(\d{6})\s*", texte or "")
    if not m:
        return None
    url = normaliser_url(m.group(1))
    return (url, m.group(2)) if url else None


def appel_relais(methode, chemin, corps=None, delai=5, cfg=None):
    cfg = cfg if cfg is not None else relais_cfg
    if not cfg.get("url"):
        raise ErreurRelais(0, "Aucune salle de classe rejointe.")
    donnees = json.dumps(corps).encode("utf-8") if corps is not None else None
    requete = urllib.request.Request(cfg["url"] + chemin, data=donnees, method=methode,
                                     headers={"Content-Type": "application/json", "X-Relais-Token": cfg.get("token", "")})
    try:
        with _sans_proxy.open(requete, timeout=delai) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail")
        except (ValueError, AttributeError, OSError):
            detail = None
        raise ErreurRelais(e.code, detail if isinstance(detail, str) else f"Le relais a refusé la requête ({e.code}).")
    except (urllib.error.URLError, OSError, ValueError):
        raise ErreurRelais(0, "Relais injoignable : vérifie que le serveur relais est lancé et que son adresse est correcte.")


def transmettre(adresse, texte, delai):
    """Envoie un texte (message chiffré ou trame JSON) à un contact : par le relais ou en direct (TCP). Lève OSError en cas d'échec."""
    if est_relais(adresse):
        appel_relais("POST", "/relais/envoyer", {"a": adresse[len(PREFIXE_RELAIS):], "data": texte}, delai=max(delai, 10))
        return
    with socket.create_connection((adresse, PORT_SOCKET), timeout=delai) as s:
        s.sendall(texte.encode("ascii"))


def joignable(adresse):
    """Peut-on lui envoyer maintenant ? Direct : son port est ouvert. Relais : le relais répond (il garde le message pour lui)."""
    if est_relais(adresse):
        try:
            appel_relais("GET", "/relais/ping", delai=2)
            return True
        except ErreurRelais:
            return False
    return _port_ouvert(adresse) is not None


def actualiser_membres_relais():
    """Relit l'annuaire de la salle ; retient pseudo et avatar de chaque membre. Lève ErreurRelais."""
    r = appel_relais("GET", "/relais/annuaire", delai=4)
    membres = {m["id"]: {"pseudo": nettoyer_pseudo(m.get("pseudo")), "avatar": nettoyer_avatar(m.get("avatar")),
                         "en_ligne": bool(m.get("en_ligne")), "role": m.get("role") if m.get("role") in ("admin", "createur") else "eleve"}
               for m in r.get("membres", []) if isinstance(m, dict) and isinstance(m.get("id"), str)}
    with verrou:
        relais_membres.clear()
        relais_membres.update(membres)
        if r.get("moi_role") in ("eleve", "admin", "createur"):
            relais_info["role"] = r["moi_role"]
        if relais_cfg and r.get("salle", {}).get("nom") and relais_cfg.get("salle") != str(r["salle"]["nom"])[:40]:
            relais_cfg["salle"] = str(r["salle"]["nom"])[:40]
            ecrire_json(FICHIER_RELAIS, relais_cfg)
    for mid, m in membres.items():
        if mid != relais_cfg.get("id"):
            retenir_profil_distant(PREFIXE_RELAIS + mid, m["pseudo"], m["avatar"])
    return r


def sonder_relais():
    """Un passage : récupère la boîte aux lettres, traite chaque message comme s'il arrivait en direct, puis l'acquitte."""
    r = appel_relais("GET", "/relais/boite?apres=0", delai=8)
    messages = [m for m in r.get("messages", []) if isinstance(m, dict) and isinstance(m.get("n"), int)
                and isinstance(m.get("de"), str) and isinstance(m.get("data"), str) and re.fullmatch(r"[0-9a-f]{1,32}", m["de"])]
    if not messages:
        return
    inconnu = any(PREFIXE_RELAIS + m["de"] not in profils_distants for m in messages)
    if inconnu:
        try:
            actualiser_membres_relais()  # un nouvel expéditeur : on retient son pseudo avant de traiter son message
        except ErreurRelais:
            pass
    for m in messages:
        try:
            traiter_recu(m["data"].strip(), PREFIXE_RELAIS + m["de"])
        except Exception as e:  # un message mal formé ne doit pas bloquer la boîte
            print(f"Relais : message ignoré ({e})")
    appel_relais("POST", "/relais/acquitter", {"jusqua": max(m["n"] for m in messages)}, delai=8)


# --- Salon commun chiffré -----------------------------------------------------
# Une clé AES-256 par « époque » : tirée au hasard par le créateur de la salle, puis chiffrée (RSA-OAEP) pour chaque membre avec sa clé
# publique. Le relais ne stocke que ces exemplaires chiffrés et les messages chiffrés : il ne connaît jamais la clé. Elle est renouvelée
# (époque + 1) quand un membre part ou est retiré. Chaque message lie son chiffré à l'époque et à son expéditeur (données associées).
def reinitialiser_salon():
    with verrou_salon:
        salon_cles.clear()
        relais_info.update(role="eleve", epoque=0, pub=None)


def emballer_cle_salon(cle, pub):
    cle_pub = charger_pub_rsa(pub)
    return b64e(cle_pub.encrypt(cle, OAEP)) if cle_pub is not None else None


def ouvrir_cle_salon(wrap):
    """La clé du salon contenue dans cet exemplaire, ou None (coffre fermé, exemplaire qui n'est pas pour moi)."""
    try:
        with verrou:
            if coffre["donnees"] is None:
                return None
            prive = cle_privee()
        cle = prive.decrypt(b64d(wrap), OAEP)
    except (ValueError, TypeError, KeyError, binascii.Error):
        return None
    return cle if len(cle) == 32 else None


def aad_salon(epoque, de):
    return f"salon|{epoque}|{de}".encode("utf-8")


def chiffrer_salon(contenu, epoque, moi):
    nonce = os.urandom(12)
    clair = json.dumps(contenu, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with verrou_salon:
        cle = salon_cles[epoque]
    return b64e(nonce + AESGCM(cle).encrypt(nonce, clair, aad_salon(epoque, moi)))


def dechiffrer_salon(data, epoque, de):
    """dict si lu ; None si je n'ai pas la clé de cette époque ; False si le message est illisible ou falsifié."""
    with verrou_salon:
        cle = salon_cles.get(epoque)
    if cle is None:
        return None
    try:
        brut = b64d(data)
        contenu = json.loads(AESGCM(cle).decrypt(brut[:12], brut[12:], aad_salon(epoque, de)))
    except (InvalidTag, ValueError, TypeError, binascii.Error):
        return False
    return contenu if isinstance(contenu, dict) else False


def entretenir_salon():
    """Un tour : publier ma clé publique, récupérer mes exemplaires de la clé du salon, et (admin) la distribuer ou la renouveler."""
    with verrou:
        if coffre["donnees"] is None:
            return
        pub = coffre["donnees"]["rsa_publique"]
    ann = appel_relais("GET", "/relais/annuaire", delai=4)
    moi, role, epoque = ann.get("moi"), ann.get("moi_role", "eleve"), int(ann.get("epoque") or 0)
    with verrou_salon:
        relais_info.update(role=role if role in ("eleve", "admin", "createur") else "eleve", epoque=epoque)
        deja = relais_info["pub"] == pub
    if not deja:
        appel_relais("POST", "/relais/salon/pub", {"pub": pub}, delai=5)
        with verrou_salon:
            relais_info["pub"] = pub
        return  # l'annuaire de ce tour est périmé : les admins verront ma clé publique au suivant
    r = appel_relais("GET", "/relais/salon/cles", delai=5)
    for e, wrap in (r.get("cles") or {}).items():
        try:
            e = int(e)
        except ValueError:
            continue
        with verrou_salon:
            connue = e in salon_cles
        if not connue:
            cle = ouvrir_cle_salon(wrap)
            if cle:
                with verrou_salon:
                    salon_cles[e] = cle
    if role not in ("admin", "createur"):
        return
    membres = [m for m in ann.get("membres", []) if isinstance(m, dict) and isinstance(m.get("id"), str) and isinstance(m.get("pub"), str)]

    def emballer_pour(cle, cibles):
        return {m["id"]: w for m in cibles for w in [emballer_cle_salon(cle, m["pub"])] if w}

    retraits = int(ann.get("retraits") or 0)
    if epoque == 0 or ann.get("rotation"):
        if epoque == 0 and role != "createur":
            return  # seul le créateur crée la première clé
        neuve = os.urandom(32)
        cles = emballer_pour(neuve, membres)
        if moi not in cles:
            return
        appel_relais("POST", "/relais/salon/cles", {"epoque": epoque + 1, "cles": cles, "retraits": retraits}, delai=8)
        with verrou_salon:
            salon_cles[epoque + 1] = neuve
        return
    with verrou_salon:
        courante = salon_cles.get(epoque)
    manquants = [m for m in membres if not m.get("a_cle")]
    if courante is not None and manquants:
        appel_relais("POST", "/relais/salon/cles", {"epoque": epoque, "cles": emballer_pour(courante, manquants)}, delai=8)


def thread_relais():
    dernier_annuaire = dernier_salon = 0.0
    while True:
        time.sleep(INTERVALLE_RELAIS)
        if not relais_cfg:
            relais_etat.update(connecte=False, erreur="")
            continue
        try:
            sonder_relais()
            if time.time() - dernier_annuaire > 10:
                actualiser_membres_relais()
                dernier_annuaire = time.time()
            if time.time() - dernier_salon > INTERVALLE_SALON:
                dernier_salon = time.time()
                try:
                    entretenir_salon()
                except ErreurRelais:
                    pass  # un refus (409 : la clé a déjà changé...) se réglera au tour suivant
            relais_etat.update(connecte=True, erreur="")
        except ErreurRelais as e:
            relais_etat.update(connecte=False, erreur=e.detail)
        except Exception as e:  # le thread ne doit jamais s'arrêter
            relais_etat.update(connecte=False, erreur=f"Erreur inattendue : {e}")


# --- Détection des autres PC du réseau local ---------------------------------
def _port_ouvert(ip):
    try:
        with socket.create_connection((ip, PORT_SOCKET), timeout=0.4):
            return ip
    except OSError:
        return None


def scanner_voisins():
    """Repli : teste le port 5000 sur tout le réseau /24 de ce PC (en parallèle, quelques secondes)."""
    moi = ip_locale()
    parties = moi.split(".")
    if moi.startswith("127.") or len(parties) != 4:
        return []
    prefixe = ".".join(parties[:3])
    candidats = [f"{prefixe}.{i}" for i in range(1, 255) if f"{prefixe}.{i}" != moi]
    with ThreadPoolExecutor(max_workers=64) as pool:
        return [ip for ip in pool.map(_port_ouvert, candidats) if ip]


# Détection par diffusion : on crie « qui utilise Messagerie chiffrée ? » à tout le réseau, chaque PC répond
# directement avec son nom d'ordinateur. Une seule trame, réponses en une fraction de seconde.
#   sonde   : {"t":"mc-qui","r":jeton}      réponse : {"t":"mc-ici","r":même jeton,"nom":nom du PC}
# Rien de secret n'y circule (le nom de l'ordinateur et l'adresse IP, déjà visibles sur le réseau).
def nom_du_pc():
    try:
        return "".join(c for c in socket.gethostname() if c.isprintable())[:40]
    except OSError:
        return ""


def ecouter_udp():
    try:
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        u.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        u.bind((HOTE_ECOUTE, PORT_UDP))
    except OSError:
        print(f"Port UDP {PORT_UDP} indisponible : la détection automatique ne répondra pas à ce PC.")
        return
    while True:
        try:
            donnees, adresse = u.recvfrom(1024)
            m = json.loads(donnees.decode("ascii", errors="ignore"))
            if isinstance(m, dict) and m.get("t") == "mc-qui" and isinstance(m.get("r"), str) and len(m["r"]) <= 64:
                reponse = {"t": "mc-ici", "r": m["r"], "nom": nom_du_pc(), **champs_profil()}
                u.sendto(json.dumps(reponse).encode("ascii", errors="ignore"), adresse)
        except (OSError, ValueError):
            continue


def sonder_udp(delai=1.2, profils=None):
    """Renvoie {ip: nom de l'ordinateur} pour les PC du réseau qui ont répondu à la sonde.
    Si `profils` est un dict, il reçoit aussi {ip: {pseudo, avatar}} pour ceux qui en ont un."""
    moi = ip_locale()
    cibles = {"255.255.255.255", *DIFFUSION_SUPP}
    parties = moi.split(".")
    if len(parties) == 4 and not moi.startswith("127."):
        cibles.add(".".join(parties[:3]) + ".255")
    jeton = os.urandom(8).hex()
    trouves = {}
    try:
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        u.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    except OSError:
        return trouves
    with u:
        for cible in cibles:
            try:
                u.sendto(json.dumps({"t": "mc-qui", "r": jeton}).encode("ascii"), (cible, PORT_UDP))
            except OSError:
                pass
        fin = time.monotonic() + delai
        while True:
            reste = fin - time.monotonic()
            if reste <= 0:
                break
            u.settimeout(reste)
            try:
                donnees, adresse = u.recvfrom(1024)
                m = json.loads(donnees.decode("ascii", errors="ignore"))
            except socket.timeout:
                break
            except (OSError, ValueError):
                continue
            if isinstance(m, dict) and m.get("t") == "mc-ici" and m.get("r") == jeton and adresse[0] != moi:
                nom = m.get("nom")
                trouves[adresse[0]] = "".join(c for c in nom if c.isprintable())[:40] if isinstance(nom, str) else ""
                if profils is not None:
                    p = profil_propre(m)
                    if p["pseudo"] or p["avatar"]:
                        profils[adresse[0]] = p
    return trouves


def detecter_voisins(profils=None):
    """Renvoie ({ip: nom}, méthode). Diffusion UDP d'abord (rapide) ; si personne ne répond, scan du réseau /24.
    `profils` (dict facultatif) reçoit les pseudos et avatars annoncés par les PC détectés."""
    annonces = {}
    trouves = sonder_udp(profils=annonces)
    if trouves:
        with ThreadPoolExecutor(max_workers=16) as pool:  # on vérifie que le programme écoute bien sur ces PC
            ok = {ip: nom for (ip, nom), r in zip(trouves.items(), pool.map(_port_ouvert, trouves)) if r}
        if ok:
            if profils is not None:
                profils.update({ip: p for ip, p in annonces.items() if ip in ok})
            return ok, "diffusion"
    return {ip: "" for ip in scanner_voisins()}, "scan"


# --- Réception des messages envoyés par les autres PC ------------------------
def lire_connexion(conn, adresse):
    with conn:
        conn.settimeout(5)
        donnees = bytearray()
        fin = time.monotonic() + 30  # délai total : un client lent ne bloque pas indéfiniment
        try:
            while len(donnees) <= MAX_RECU and time.monotonic() < fin:
                morceau = conn.recv(65536)
                if not morceau:
                    break
                donnees += morceau
            else:
                return  # trop gros ou trop lent
        except OSError:
            return
    traiter_recu(bytes(donnees).decode("ascii", errors="ignore").strip(), adresse[0])


def traiter_recu(texte, expediteur):
    """Traite un texte arrivé en direct (TCP) ou par le relais ; « expediteur » est une IP ou « relais:<id> »."""
    if texte.startswith("{"):  # échange de clés ou accusé de réception
        traiter_trame(texte, expediteur)
        return
    try:
        decoder(texte)  # ignore le bruit (scans de ports, données qui ne sont pas un message)
    except ValueError:
        return
    h = empreinte(texte)
    if not marquer_vu(h):
        return  # message déjà reçu (ou émis par nous) : rejeu ignoré
    ajouter("recu", texte, expediteur)
    with verrou:
        entree = next((x for x in reversed(historique) if x["sens"] == "recu" and h_de(x) == h), None)
        if entree:
            signaler_remis(entree)


def ecouter():
    try:
        serveur = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        serveur.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        serveur.bind((HOTE_ECOUTE, PORT_SOCKET))
        serveur.listen(5)
    except OSError:
        print(f"Port {PORT_SOCKET} déjà utilisé : ferme l'autre instance puis relance.")
        return
    while True:
        try:
            conn, adresse = serveur.accept()
        except OSError:
            continue
        threading.Thread(target=lire_connexion, args=(conn, adresse), daemon=True).start()


# --- API pour le front React -------------------------------------------------
PREFIXE_REP = "\x07REP:"  # une réponse est un message v2 ordinaire dont le texte commence par ce marqueur : la citation voyage chiffrée avec le message


def emballer_reponse(texte, reponse):
    """Texte à chiffrer : la citation (extrait du message d'origine) + la réponse."""
    extrait = " ".join(str(reponse.get("x", "")).split())[:140]
    if not extrait:
        return texte
    return PREFIXE_REP + json.dumps({"s": 1 if reponse.get("s") else 0, "x": extrait, "t": texte}, separators=(",", ":"), ensure_ascii=False)


def decouper_reponse(clair):
    """(texte, citation) : citation vaut None si ce n'est pas une réponse ; {"s": 1 si le message cité est de l'expéditeur, "x": extrait}."""
    if not (isinstance(clair, str) and clair.startswith(PREFIXE_REP)):
        return clair, None
    try:
        d = json.loads(clair[len(PREFIXE_REP):])
        if isinstance(d, dict) and isinstance(d.get("t"), str) and isinstance(d.get("x"), str):
            return d["t"], {"s": 1 if d.get("s") else 0, "x": d["x"][:140]}
    except ValueError:
        pass
    return clair[len(PREFIXE_REP):], None


class Envoi(BaseModel):
    ip: str
    cle: str = ""
    message: str
    nom: str = ""
    contact_cle: bool = False  # True : utiliser la clé échangée avec ce contact
    rsa_direct: bool = False   # True : chiffrer avec la clé publique importée de ce contact (v5)
    reponse: Optional[dict] = None  # réponse à un message (clé échangée seulement) : {"s": 1 si le message cité est de moi, "x": extrait}


class Dechiffrement(BaseModel):
    crypte: str = ""
    cle: str = ""
    id: int = 0  # identifiant d'une entrée de l'historique (obligatoire pour les pièces jointes)


class Fichier(BaseModel):
    ip: str
    nom_fichier: str
    type: str = "application/octet-stream"
    donnees: str  # contenu du fichier en base64
    nom: str = ""
    cle: str = ""  # clé saisie à la main : le fichier part en v4, sans échange de clés préalable


class Contact(BaseModel):
    ip: str
    name: str = ""


class Ip(BaseModel):
    ip: str


class MotDePasse(BaseModel):
    mdp: str


class Verification(BaseModel):
    ip: str
    verifie: bool


class Demo(BaseModel):
    texte: str
    cle: str


@app.get("/api/ip")
def api_ip():
    return {"ip": ip_locale()}


class Profil(BaseModel):
    pseudo: str = ""
    avatar: str = ""  # un émoji, ou 2 caractères (initiales)


@app.get("/api/profil")
def api_profil():
    with verrou:
        return dict(mon_profil)


@app.post("/api/profil")
def api_profil_maj(p: Profil):
    pseudo = p.pseudo.strip()
    if len(pseudo) > MAX_PSEUDO:
        raise HTTPException(400, f"Le pseudo est trop long ({MAX_PSEUDO} caractères maximum).")
    avatar = p.avatar.strip()
    if len(avatar) > MAX_AVATAR:
        raise HTTPException(400, "L'avatar doit être un émoji ou 2 caractères (initiales).")
    propre = profil_propre({"pseudo": pseudo, "avatar": avatar})
    if propre["pseudo"] != pseudo or propre["avatar"] != avatar:
        raise HTTPException(400, "Le pseudo et l'avatar ne peuvent contenir que des caractères imprimables (l'avatar : sans espace).")
    with verrou:
        mon_profil.update(propre)
        ecrire_json(FICHIER_PROFIL, mon_profil)
        copie = dict(mon_profil)
    if relais_cfg:  # l'annuaire de la salle montre le nouveau pseudo (sans bloquer si le relais ne répond pas)
        threading.Thread(target=lambda: _essayer(lambda: appel_relais("POST", "/relais/profil", copie)), daemon=True).start()
    return copie


@app.get("/api/decouverte")
def api_decouverte():
    annonces = {}
    noms, methode = detecter_voisins(annonces)
    with verrou:
        for ip, p in annonces.items():
            if ip in contacts:  # on ne retient que le profil des PC déjà au carnet
                retenir_profil_distant(ip, p["pseudo"], p["avatar"])
    return {"voisins": list(noms), "noms": noms, "methode": methode, "profils": annonces}


@app.get("/api/statut-contacts")
def api_statut_contacts():
    """Pour chaque contact : le programme est-il ouvert sur son PC (port 5000 joignable) ?"""
    with verrou:
        ips = [i for i in contacts if not est_relais(i)]
        par_relais = [i for i in contacts if est_relais(i)]
    statuts = {}
    if ips:
        with ThreadPoolExecutor(max_workers=32) as pool:
            resultats = list(pool.map(_port_ouvert, ips))
        statuts = {ip: r is not None for ip, r in zip(ips, resultats)}
    if par_relais:  # la présence vient de l'annuaire de la salle
        try:
            actualiser_membres_relais()
        except ErreurRelais:
            pass
        with verrou:
            for i in par_relais:
                statuts[i] = bool(relais_membres.get(i[len(PREFIXE_RELAIS):], {}).get("en_ligne"))
    return {"statuts": statuts}


@app.post("/api/envoyer")
def api_envoyer(e: Envoi):
    ip = e.ip.strip()
    message = e.message.strip()
    if not ip or not message:
        raise HTTPException(400, "Il faut une adresse IP et un message.")
    if len(message) > MAX_MESSAGE:
        raise HTTPException(400, f"Le message est trop long ({MAX_MESSAGE} caractères maximum).")
    refuser_marqueur_jeu(message)
    if e.rsa_direct:
        with verrou:
            exiger_ouvert()
            imp = coffre["donnees"].get("importees", {}).get(ip)
        if not imp:
            raise HTTPException(400, "Aucune clé publique importée pour ce contact.")
        crypte = chiffrer_v5(message, imp["pub"])
    elif e.contact_cle:
        with verrou:
            exiger_ouvert()
            k = coffre["donnees"]["cles"].get(ip)
        if not k:
            raise HTTPException(400, "Aucune clé n'a été échangée avec ce contact.")
        if e.reponse:
            message = emballer_reponse(message, e.reponse)
        crypte = chiffrer_v2(message, b64d(k["cle"]))
    else:
        if not e.cle:
            raise HTTPException(400, "Il faut une clé (ou une clé échangée avec ce contact).")
        if len(e.cle) < CLE_MIN:
            raise HTTPException(400, f"La clé doit contenir au moins {CLE_MIN} caractères.")
        crypte = chiffrer(message, e.cle)
    identifiant, statut = expedier(ip, crypte, e.nom)
    return {"chiffre": crypte, "id": identifiant, "statut": statut}


@app.get("/api/file-attente")
def api_file_attente():
    with verrou:
        return {"messages": [{"id": x["id"], "ip": x["ip"], "heure": x["heure"], "tentatives": x["tentatives"]}
                             for x in file_attente if entree_historique(x["hid"])],
                "max_tentatives": MAX_TENTATIVES}


@app.post("/api/file-attente/vider")
def api_file_attente_vider():
    """Annule tous les envois en attente : ces messages ne sont jamais partis, ils sont retirés de l'historique."""
    with verrou:
        hids = {x["hid"] for x in file_attente}
        nb = len(file_attente)
        file_attente.clear()
        sauver_file()
        if hids:
            historique[:] = [m for m in historique if not (m["id"] in hids and m.get("statut") == "attente")]
            nettoyer_blobs()
            sauvegarder()
    return {"annules": nb}


def chiffrer_pour(ip, message):
    """Chiffre un texte pour un contact : clé échangée (v2) en priorité, sinon clé publique importée (v5).
    Lève HTTPException si le coffre est fermé ou si on n'a aucune clé pour ce contact."""
    with verrou:
        exiger_ouvert()
        k = coffre["donnees"]["cles"].get(ip)
        imp = coffre["donnees"].get("importees", {}).get(ip)
    if k:
        return chiffrer_v2(message, b64d(k["cle"]))
    if imp:
        return chiffrer_v5(message, imp["pub"])
    raise HTTPException(400, "Aucune clé pour ce contact (échange de clés ou clé publique importée).")


class EnvoiGroupe(BaseModel):
    destinataires: list[str]  # adresses IP
    message: str
    fichier: bool = False     # réservé : les pièces jointes ne partent pas encore en groupe


@app.post("/api/envoyer-groupe")
def api_envoyer_groupe(g: EnvoiGroupe):
    """Envoie le même texte à plusieurs contacts. Chaque destinataire reçoit un message ordinaire (v2 ou v5),
    chiffré avec SA clé : aucun format nouveau, et il ne sait pas que c'est un envoi groupé."""
    message = g.message.strip()
    ips = list(dict.fromkeys(i.strip() for i in g.destinataires if i.strip()))  # sans doublon, ordre conservé
    if not ips:
        raise HTTPException(400, "Choisis au moins un destinataire.")
    if len(ips) > MAX_GROUPE:
        raise HTTPException(400, f"Trop de destinataires ({MAX_GROUPE} au maximum).")
    if not message:
        raise HTTPException(400, "Écris un message.")
    if len(message) > MAX_MESSAGE:
        raise HTTPException(400, f"Le message est trop long ({MAX_MESSAGE} caractères maximum).")
    refuser_marqueur_jeu(message)
    if g.fichier:
        raise HTTPException(400, "Les pièces jointes ne sont pas encore disponibles pour un envoi groupé.")
    exiger_ouvert()

    def un_envoi(ip):
        try:
            crypte = chiffrer_pour(ip, message)  # un chiffré différent par destinataire
            identifiant, statut = expedier(ip, crypte, "")
            return {"ip": ip, "statut": "attente" if statut == "attente" else "ok", "id": identifiant,
                    "message": "En file d'attente : partira dès que ce PC sera joignable." if statut == "attente" else "Envoyé."}
        except HTTPException as e:
            return {"ip": ip, "statut": "erreur", "message": str(e.detail)}
        except Exception:
            return {"ip": ip, "statut": "erreur", "message": "Envoi impossible."}

    with ThreadPoolExecutor(max_workers=min(16, len(ips))) as pool:
        envois = list(pool.map(un_envoi, ips))  # map conserve l'ordre des destinataires
    return {"envois": envois}


def vers_ce_pc(ip):
    """Vrai si l'adresse est celle de ce PC (127.x.x.x, localhost ou son adresse sur le réseau) : on peut s'écrire à soi-même."""
    return ip.startswith("127.") or ip == "localhost" or ip == ip_locale()


# --- File d'attente : messages chiffrés dont le destinataire est hors ligne -----
# Le message reste dans l'historique (statut « attente ») ; la file ne garde que de quoi le retrouver et le renvoyer.
# Un thread de fond retente toutes les INTERVALLE_FILE secondes.
def charger_file():
    d = lire_json(FICHIER_FILE, [])
    cles = {"id", "ip", "hid", "heure", "tentatives"}
    return [x for x in d if isinstance(x, dict) and cles <= x.keys() and isinstance(x["id"], int)] if isinstance(d, list) else []


file_attente = charger_file()  # [{id, ip, hid (id dans l'historique), heure, tentatives}]


def sauver_file():
    """À appeler avec le verrou pris."""
    ecrire_json(FICHIER_FILE, file_attente)


def mettre_en_file(ip, hid):
    """Ajoute un message à la file. Verrou pris. Renvoie False si la file est pleine."""
    if len(file_attente) >= MAX_FILE:
        return False
    identifiant = (max((x["id"] for x in file_attente), default=0)) + 1
    file_attente.append({"id": identifiant, "ip": ip, "hid": hid, "heure": maintenant(), "tentatives": 0})
    sauver_file()
    return True


def entree_historique(hid):
    return next((m for m in historique if m["id"] == hid), None)


def envoyer_message(ip, crypte, delai):
    """Envoi direct ou par le relais ; lève OSError si le destinataire (ou le relais) est injoignable."""
    transmettre(ip, crypte, delai)


def passage_file_attente():
    """Un passage sur la file : renvoie les messages dont le destinataire est de nouveau joignable."""
    with verrou:
        # un message effacé de l'historique n'a plus rien à envoyer
        avant = len(file_attente)
        file_attente[:] = [x for x in file_attente if entree_historique(x["hid"])]
        if len(file_attente) != avant:
            sauver_file()
        instantane = [dict(x) for x in file_attente]
    if not instantane:
        return
    with ThreadPoolExecutor(max_workers=16) as pool:
        joignables = dict(zip((x["id"] for x in instantane), pool.map(lambda x: joignable(x["ip"]), instantane)))
    for x in instantane:
        with verrou:
            entree = entree_historique(x["hid"])
            if entree is None or not any(f["id"] == x["id"] for f in file_attente):
                continue  # annulé entre-temps
            crypte = crypte_de(entree)
        reussi = False
        if joignables[x["id"]] and crypte:
            try:
                envoyer_message(x["ip"], crypte, 30)
                reussi = True
            except OSError:
                pass
        with verrou:
            courant = next((f for f in file_attente if f["id"] == x["id"]), None)
            entree = entree_historique(x["hid"])
            if courant is None:
                continue
            if reussi:
                file_attente.remove(courant)
                if entree is not None and entree.get("statut") == "attente":
                    entree["statut"] = "envoye"
                    entree["heure"] = maintenant()  # l'heure d'envoi réelle
                    sauvegarder()
            else:
                courant["tentatives"] += 1
                if courant["tentatives"] >= MAX_TENTATIVES:
                    file_attente.remove(courant)
                    if entree is not None and entree.get("statut") == "attente":
                        entree["statut"] = "echec"  # abandon : le destinataire est resté injoignable
                        sauvegarder()
            sauver_file()


def thread_file_attente():
    while True:
        time.sleep(INTERVALLE_FILE)
        try:
            passage_file_attente()
        except Exception as e:  # le thread ne doit jamais s'arrêter
            print(f"File d'attente : erreur ignorée ({e})")


def expedier(ip, crypte, nom="", delai=5):
    """Enregistre puis envoie un message chiffré. Renvoie (identifiant de l'entrée d'historique, statut).
    Si le destinataire est injoignable, le message est mis en file d'attente (statut « attente ») et partira tout seul."""
    if not vers_ce_pc(ip):  # on ne reprend jamais un message qu'on a soi-même émis (sauf s'il nous est destiné)
        marquer_vu(empreinte(crypte))
    # L'entrée est créée avant l'envoi : l'accusé de réception peut arriver aussitôt.
    identifiant = ajouter("envoye", crypte, ip, "envoye")
    statut = "envoye"
    try:
        envoyer_message(ip, crypte, delai)
    except OSError:
        with verrou:
            en_file = mettre_en_file(ip, identifiant)
            if en_file:
                entree = entree_historique(identifiant)
                if entree is not None:
                    entree["statut"] = "attente"
                    sauvegarder()
        if not en_file:
            retirer(identifiant)
            raise HTTPException(502, f"Connexion impossible à {ip} et la file d'attente est pleine ({MAX_FILE} messages). "
                                     "Vide-la ou attends que ce PC revienne en ligne.")
        statut = "attente"
    nom = nom.strip()
    if nom:  # le carnet se met à jour tout seul quand on donne un nom
        with verrou:
            contacts[ip] = nom
            ecrire_json(FICHIER_CONTACTS, contacts)
    return identifiant, statut


@app.post("/api/envoyer-fichier")
def api_envoyer_fichier(f: Fichier):
    ip = f.ip.strip()
    if not ip:
        raise HTTPException(400, "L'adresse IP est requise.")
    try:
        brut = b64d(f.donnees)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "Fichier illisible.")
    if not brut:
        raise HTTPException(400, "Le fichier est vide.")
    if len(brut) > MAX_FICHIER:
        raise HTTPException(400, f"Le fichier est trop gros ({MAX_FICHIER // 1024 // 1024} Mo maximum).")
    enveloppe = json.dumps({"n": nom_sur(f.nom_fichier), "t": f.type[:100], "d": f.donnees})
    if f.cle:
        if len(f.cle) < CLE_MIN:
            raise HTTPException(400, f"La clé doit contenir au moins {CLE_MIN} caractères.")
        crypte = chiffrer_v4(enveloppe, f.cle)
    else:
        with verrou:
            exiger_ouvert()
            k = coffre["donnees"]["cles"].get(ip)
        if not k:
            raise HTTPException(400, "Aucune clé n'a été échangée avec ce contact : "
                                     "échange les clés (onglet Contacts) ou saisis une clé pour ce fichier.")
        crypte = chiffrer_v3(enveloppe, b64d(k["cle"]))
    identifiant, statut = expedier(ip, crypte, f.nom, delai=30)
    return {"id": identifiant, "statut": statut}


def avec_version(m):
    """Entrée d'historique pour le front : le contenu des gros messages n'est jamais renvoyé."""
    sortie = {**m, "v": m.get("v") or version_message(crypte_de(m))}
    if m.get("blob"):
        sortie["crypte"] = ""
    return sortie


@app.get("/api/recus")
def api_recus(apres: int = 0):
    with verrou:
        return {"messages": [avec_version(m) for m in historique if m["sens"] == "recu" and m["id"] > apres]}


@app.get("/api/historique")
def api_historique():
    with verrou:
        purger()
        return {"entrees": [avec_version(m) for m in historique]}


@app.delete("/api/historique")
def api_vider_historique():
    with verrou:
        historique.clear()
        nettoyer_blobs()
        sauvegarder()
    return {"entrees": []}


PREFIXE_JEU = "\x07JEU:"  # un coup de jeu privé est un message v2 ordinaire dont le texte commence par ce marqueur
ID_PARTIE = re.compile(r"^[0-9a-f]{8}$")


def assainir_jeu_prive(d):
    """Événement de jeu entre deux contacts, validé champ par champ (à l'envoi ET à la réception), ou None.
    Pas de numéro de relais ici : l'ordre vient de « s » (numéro du coup, morpion) ou de la manche « r » (pierre-feuille-ciseaux)."""
    if not isinstance(d, dict) or d.get("j") not in JEUX_SALON or d.get("a") not in ACTIONS_JEU:
        return None
    if d.get("a") == "forfait":
        return None  # pas de relais pour dater un forfait entre deux contacts : seul « Abandonner » existe dans les parties privées
    g = d.get("g")
    if not (isinstance(g, str) and ID_PARTIE.match(g)):
        return None
    j, a = d["j"], d["a"]
    ev = {"j": j, "a": a, "g": g}
    if j == "pfc":
        extra = champs_pfc(a, d) if a != "coup" else None
        return {**ev, **extra} if extra is not None else None
    if a in ("engage", "revele"):
        return None
    if a in ("coup", "abandon"):
        s_ = d.get("s")
        if not (isinstance(s_, int) and not isinstance(s_, bool) and 0 <= s_ <= JEUX_SALON[j]):
            return None
        ev["s"] = s_
    if a == "coup":
        i = d.get("i")
        if not (isinstance(i, int) and not isinstance(i, bool) and 0 <= i < JEUX_SALON[j]):
            return None
        ev["i"] = i
    return ev


def evenement_jeu(clair):
    """L'événement de jeu valide contenu dans ce texte, ou None. None aussi pour un texte qui commence par le marqueur mais qui est mal
    formé : ce n'est pas un coup de jeu, c'est un message comme un autre (sinon un contact pourrait rendre un message invisible)."""
    if not (isinstance(clair, str) and clair.startswith(PREFIXE_JEU)):
        return None
    try:
        return assainir_jeu_prive(json.loads(clair[len(PREFIXE_JEU):]))
    except ValueError:
        return None


def texte_visible(clair):
    """Texte à afficher pour un message qui n'est pas un coup de jeu : un texte mal formé qui commence par le marqueur est montré
    tel quel, sans le caractère de contrôle (qui ne s'affiche pas)."""
    if isinstance(clair, str) and clair.startswith(PREFIXE_JEU):
        return clair[1:]
    return clair


def refuser_marqueur_jeu(texte):
    """Un texte saisi ne doit pas commencer par le marqueur réservé aux coups de jeu : il serait pris pour un coup chez le destinataire."""
    if isinstance(texte, str) and texte.startswith(PREFIXE_JEU):
        raise HTTPException(400, "Ce message commence par un marqueur réservé aux parties privées : change le début du texte.")


class JeuPrive(BaseModel):
    ip: str
    j: str = "morpion"
    a: str
    g: str = ""        # identifiant de la partie (vide pour un défi : il est tiré ici)
    i: Optional[int] = None
    s: Optional[int] = None
    r: Optional[int] = None
    h: str = ""
    m: str = ""
    x: str = ""


@app.post("/api/conversation/jeu")
def api_conversation_jeu(t: JeuPrive):
    """Défi, acceptation, coup, engagement, révélation ou abandon envoyé à UN contact : message v2 chiffré avec la clé échangée, rien ne passe par un relais de jeu."""
    ip = t.ip.strip()
    g = t.g if t.a != "defi" else secrets.token_hex(4)
    ev = assainir_jeu_prive({"j": t.j, "a": t.a, "g": g, "i": t.i, "s": t.s, "r": t.r, "h": t.h, "m": t.m, "x": t.x})
    if ev is None:
        raise HTTPException(400, "Événement de jeu invalide.")
    with verrou:
        exiger_ouvert()
        k = coffre["donnees"]["cles"].get(ip)
    if not k:
        raise HTTPException(400, "Échange d'abord les clés avec ce contact : les parties privées utilisent la clé échangée.")
    crypte = chiffrer_v2(PREFIXE_JEU + json.dumps(ev, separators=(",", ":")), b64d(k["cle"]))
    identifiant, statut = expedier(ip, crypte)
    return {"g": g, "id": identifiant, "statut": statut}


@app.get("/api/conversation")
def api_conversation(ip: str):
    """Fil de discussion avec un contact. Les messages à clé échangée sont lus en mémoire (jamais enregistrés)."""
    ip = ip.strip()
    with verrou:
        ouvert = coffre["donnees"] is not None
        messages, jeux = [], []
        for m in historique:
            if m["pair"] != ip:
                continue
            v, clair = m.get("v") or version_message(crypte_de(m)), None
            if (v == 2 or (v == 5 and m["sens"] == "recu")) and ouvert:
                try:
                    clair = dechiffrer(m["crypte"], "")
                    signaler_lu(m)  # lire un message équivaut à l'avoir déchiffré (sans effet en v5 : pas de clé partagée)
                except Exception:
                    clair = None
            jeu = evenement_jeu(clair)
            if jeu:  # coup de jeu valide : pas de bulle, la partie est reconstituée côté interface
                jeux.append({"id": m["id"], "sens": m["sens"], "heure": m["heure"], **jeu})
                continue
            clair, cite = decouper_reponse(texte_visible(clair))
            rep = {"moi": (cite["s"] == 1) == (m["sens"] == "envoye"), "x": cite["x"]} if cite else None
            brut_crypte = m.get("crypte") or ""
            messages.append({"id": m["id"], "sens": m["sens"], "heure": m["heure"], "rep": rep,
                             "crypte": brut_crypte[:1200] if v not in (3, 4) else "", "crypte_tronque": len(brut_crypte) > 1200,
                             "statut": m.get("statut"), "v": v, "clair": clair,
                             "taille": m.get("taille") or len(m["crypte"])})
        return {"messages": messages, "jeux": jeux, "ouvert": ouvert}


class Parametres(BaseModel):
    retention_jours: int


@app.get("/api/parametres")
def api_parametres():
    return dict(parametres)


@app.post("/api/parametres")
def api_parametres_maj(p: Parametres):
    if not 0 <= p.retention_jours <= 3650:
        raise HTTPException(400, "Durée invalide.")
    with verrou:
        parametres["retention_jours"] = p.retention_jours
        ecrire_json(FICHIER_PARAMETRES, parametres)
        purger()
    return dict(parametres)


def _essayer(f):
    try:
        f()
    except OSError:
        pass


# --- Salle de classe (relais) ------------------------------------------------
class RejoindreRelais(BaseModel):
    url: str = ""   # adresse du relais, ou lien « mc-relais://hote:port/code »
    code: str = ""  # code de salle à 6 chiffres


def etat_relais():
    with verrou:
        return {"configure": bool(relais_cfg), "url": relais_cfg.get("url", ""), "salle": relais_cfg.get("salle", ""),
                "id": relais_cfg.get("id", ""), "adresse": PREFIXE_RELAIS + relais_cfg["id"] if relais_cfg else "",
                "connecte": relais_etat["connecte"], "erreur": relais_etat["erreur"]}


@app.get("/api/relais")
def api_relais():
    return etat_relais()


@app.post("/api/relais/rejoindre")
def api_relais_rejoindre(r: RejoindreRelais):
    lien = lire_lien_relais(r.url) or lire_lien_relais(r.code)
    if lien:
        url, code = lien
    else:
        url, code = normaliser_url(r.url), "".join(r.code.split())
    if not url:
        raise HTTPException(400, "Adresse du relais invalide (exemple : 192.168.1.10:8100).")
    if not re.fullmatch(r"\d{6}", code):
        raise HTTPException(400, "Le code de la salle comporte 6 chiffres.")
    with verrou:
        profil = dict(mon_profil)
    try:
        rep_ = appel_relais("POST", "/relais/rejoindre", {"code": code, **profil}, cfg={"url": url})
    except ErreurRelais as e:
        raise HTTPException(502 if e.statut == 0 else 400, e.detail)
    if not all(isinstance(rep_.get(k), str) for k in ("id", "token")):
        raise HTTPException(502, "Réponse inattendue du relais.")
    with verrou:
        ancien = dict(relais_cfg)
        relais_cfg.clear()
        relais_cfg.update(url=url, id=rep_["id"], token=rep_["token"], salle=str(rep_.get("salle", {}).get("nom", ""))[:40])
        relais_membres.clear()
        reinitialiser_salon()
        ecrire_json(FICHIER_RELAIS, relais_cfg)
        relais_etat.update(connecte=True, erreur="")
    if ancien:  # on quitte l'ancienne salle
        _essayer(lambda: appel_relais("POST", "/relais/quitter", {}, cfg=ancien))
    return etat_relais()


@app.post("/api/relais/quitter")
def api_relais_quitter():
    with verrou:
        ancien = dict(relais_cfg)
        relais_cfg.clear()
        relais_membres.clear()
        reinitialiser_salon()
        relais_etat.update(connecte=False, erreur="")
        try:
            FICHIER_RELAIS.unlink(missing_ok=True)
        except OSError:
            ecrire_json(FICHIER_RELAIS, {})
    if ancien:
        _essayer(lambda: appel_relais("POST", "/relais/quitter", {}, cfg=ancien))
    return etat_relais()


@app.get("/api/relais/annuaire")
def api_relais_annuaire():
    """Les membres de la salle (sans moi) avec leur présence ; « contact » dit s'ils sont déjà dans mon carnet."""
    if not relais_cfg:
        raise HTTPException(400, "Rejoins d'abord une salle de classe.")
    try:
        r = actualiser_membres_relais()
    except ErreurRelais as e:
        raise HTTPException(502, e.detail)
    with verrou:
        moi = relais_cfg.get("id")
        membres = [{"adresse": PREFIXE_RELAIS + mid, "id": mid, "pseudo": m["pseudo"], "avatar": m["avatar"], "en_ligne": m["en_ligne"],
                    "role": m.get("role", "eleve"), "contact": PREFIXE_RELAIS + mid in contacts}
                   for mid, m in relais_membres.items() if mid != moi]
        mon_role = relais_info["role"]
    return {"salle": str(r.get("salle", {}).get("nom", "")), "membres": membres, "moi_role": mon_role}


# --- Salon commun de la salle (tous les membres, professeur compris) : chiffré, avec rôles et réponses ------------
class MsgSalonEnvoi(BaseModel):
    texte: str = ""
    reponse_a: Optional[dict] = None  # {n, p (pseudo de l'auteur cité), x (extrait)}
    ttl: int = 0                      # message éphémère : durée de vie en secondes (0 = normal)


class EvenementSalon(BaseModel):
    k: str                            # rx (réaction), poll (sondage), vote, jeu
    c: Optional[int] = None           # numéro du message visé (sondage, message réagi, défi)
    e: str = ""                       # emoji de la réaction
    on: bool = True                   # réaction ajoutée (True) ou retirée (False)
    q: str = ""                       # question du sondage
    o: Optional[list] = None          # options du sondage
    i: Optional[int] = None           # option votée, ou case jouée
    j: str = ""                       # jeu (morpion, pfc)
    a: str = ""                       # action de jeu : defi, accepte, coup, abandon, engage, revele
    r: Optional[int] = None           # manche (pierre-feuille-ciseaux)
    h: str = ""                       # engagement : SHA-256 du coup caché
    m: str = ""                       # coup révélé (p, f, c)
    x: str = ""                       # sel révélé
    ttl: int = 0


class CibleMsgSalon(BaseModel):
    n: int


class CibleMembreSalon(BaseModel):
    id: str = ""
    role: str = ""


REACTIONS_SALON = ("👍", "❤️", "😂", "😮", "😢", "🎉", "🔥", "👀")
JEUX_SALON = {"morpion": 9, "pfc": 0}  # jeu -> nombre de cases (morpion) ; pierre-feuille-ciseaux n'a pas de grille
ACTIONS_JEU = ("defi", "accepte", "coup", "abandon", "engage", "revele", "forfait")  # « forfait » : pierre-feuille-ciseaux du salon seulement (datée par le relais)
COUPS_PFC = ("p", "f", "c")  # pierre, feuille, ciseaux
HEX64, HEX32 = re.compile(r"^[0-9a-f]{64}$"), re.compile(r"^[0-9a-f]{32}$")
MANCHES_PFC = 10  # manches maximum d'une partie (les égalités se rejouent)


def champs_pfc(a, d):
    """Champs d'une action de pierre-feuille-ciseaux : « engage » = empreinte SHA-256 du coup caché, « revele » = coup + sel (le sel
    fait que l'empreinte ne se devine pas en essayant les 3 coups). None si mal formé."""
    r = d.get("r")
    if a in ("engage", "revele", "forfait") and not (isinstance(r, int) and not isinstance(r, bool) and 0 <= r < MANCHES_PFC):
        return None
    if a == "forfait":
        return {"r": r}  # le délai se mesure avec l'heure du relais : le moteur compare l'heure du forfait à celle des engagements
    if a == "engage":
        h = d.get("h")
        return {"r": r, "h": h} if isinstance(h, str) and HEX64.match(h) else None
    if a == "revele":
        m, x = d.get("m"), d.get("x")
        return {"r": r, "m": m, "x": x} if m in COUPS_PFC and isinstance(x, str) and HEX32.match(x) else None
    return {}


def assainir_evenement(k, d):
    """Événement du salon (réaction, sondage, vote, jeu) validé champ par champ, ou None.
    Sert à l'envoi ET à la lecture : le contenu déchiffré vient d'un autre membre, on ne lui fait jamais confiance."""
    def entier(v, bas, haut):
        return v if isinstance(v, int) and not isinstance(v, bool) and bas <= v <= haut else None
    if not isinstance(d, dict):
        return None
    if k == "rx":
        c, e = entier(d.get("c"), 1, 10**9), d.get("e")
        return {"c": c, "e": e, "on": bool(d.get("on", True))} if c and e in REACTIONS_SALON else None
    if k == "poll":
        q, o = d.get("q"), d.get("o")
        if not (isinstance(q, str) and 1 <= len(q.strip()) <= 200 and isinstance(o, list) and 2 <= len(o) <= 6
                and all(isinstance(x, str) and 1 <= len(x.strip()) <= 80 for x in o)):
            return None
        return {"q": q.strip(), "o": [x.strip() for x in o]}
    if k == "vote":
        c, i = entier(d.get("c"), 1, 10**9), entier(d.get("i"), 0, 5)
        return {"c": c, "i": i} if c and i is not None else None
    if k == "jeu":
        j, a = d.get("j"), d.get("a")
        if j not in JEUX_SALON or a not in ACTIONS_JEU:
            return None
        if a == "defi":
            return {"j": j, "a": a}
        c = entier(d.get("c"), 1, 10**9)
        if not c:
            return None
        if j == "pfc":
            extra = champs_pfc(a, d) if a != "coup" else None
            return {"j": j, "a": a, "c": c, **extra} if extra is not None else None
        if a == "coup":
            i = entier(d.get("i"), 0, JEUX_SALON[j] - 1)
            return {"j": j, "a": a, "c": c, "i": i} if i is not None else None
        return {"j": j, "a": a, "c": c} if a in ("accepte", "abandon") else None
    return None


def _exiger_salle():
    if not relais_cfg:
        raise HTTPException(400, "Rejoins d'abord une salle de classe.")


def _appel_salon(methode, chemin, corps=None, delai=6):
    try:
        return appel_relais(methode, chemin, corps, delai=delai)
    except ErreurRelais as e:
        raise HTTPException(502 if e.statut == 0 else (e.statut if e.statut in (403, 429) else 400), e.detail)


@app.get("/api/relais/salon")
def api_relais_salon(apres: int = 0):
    _exiger_salle()
    r = _appel_salon("GET", f"/relais/salon?apres={max(0, int(apres))}", delai=5)
    coffre_ = etat_coffre()
    epoque = r.get("epoque") if isinstance(r.get("epoque"), int) else 0
    with verrou_salon:
        if r.get("moi_role") in ("eleve", "admin", "createur"):
            relais_info["role"] = r["moi_role"]
        relais_info["epoque"] = epoque
        connues = sorted(salon_cles)
    if coffre_ != "ouvert":
        etat_cle = "coffre_absent" if coffre_ == "absent" else "coffre_verrouille"
    else:
        etat_cle = "ok" if epoque >= 1 and epoque in connues else "en_attente"
    with verrou:
        membres = dict(relais_membres)
        moi = relais_cfg.get("id")
    messages = []
    for m in r.get("messages", []):
        if not (isinstance(m, dict) and isinstance(m.get("n"), int) and isinstance(m.get("de"), str)
                and isinstance(m.get("epoque"), int) and isinstance(m.get("data"), str)):
            continue
        fiche = membres.get(m["de"], {})
        contenu = dechiffrer_salon(m["data"], m["epoque"], m["de"])
        item = {"n": m["n"], "de": m["de"], "heure": str(m.get("heure", "")), "moi": m["de"] == moi,
                "pseudo": fiche.get("pseudo", ""), "avatar": fiche.get("avatar", ""), "role": fiche.get("role", "eleve"), "etat": "ok"}
        if isinstance(m.get("t"), (int, float)) and not isinstance(m.get("t"), bool):
            item["t"] = float(m["t"])  # heure du relais (il date chaque événement) : sert aux délais de forfait ; posé avant le contenu, qui ne peut pas l'écraser
        if isinstance(contenu, dict) and contenu.get("k", "msg") != "msg":
            ev = assainir_evenement(contenu.get("k"), contenu)  # type inconnu ou mal formé : ignoré (compatible avec les versions futures)
            if ev is None:
                continue
            item["k"] = contenu["k"]
            item.update(ev)
            if not item["pseudo"]:
                item["pseudo"] = nettoyer_pseudo(contenu.get("u")) if isinstance(contenu.get("u"), str) else ""
        elif isinstance(contenu, dict):
            item["texte"] = str(contenu.get("t", ""))[:1000]
            if not item["pseudo"]:
                item["pseudo"] = nettoyer_pseudo(contenu.get("u")) if isinstance(contenu.get("u"), str) else ""
            rep = contenu.get("r")
            if isinstance(rep, dict) and isinstance(rep.get("n"), int):
                item["rep"] = {"n": rep["n"], "p": nettoyer_pseudo(rep.get("p")) if isinstance(rep.get("p"), str) else "",
                               "x": str(rep.get("x", ""))[:120]}
        else:
            item["etat"] = "illisible" if contenu is False else ("sans_cle" if coffre_ == "ouvert" else "verrouille")
        if isinstance(m.get("exp"), (int, float)):
            item["exp"] = m["exp"]
        messages.append(item)
    supprimes = [n for n in r.get("supprimes", []) if isinstance(n, int)]
    expires = [n for n in r.get("expires", []) if isinstance(n, int)]
    horloge = r.get("horloge") if isinstance(r.get("horloge"), (int, float)) else time.time()
    return {"messages": messages, "supprimes": supprimes, "expires": expires, "horloge": horloge, "moi": moi,
            "dernier": r.get("dernier") if isinstance(r.get("dernier"), int) else 0,
            "etat_cle": etat_cle, "cles": connues, "moi_role": relais_info["role"], "epoque": epoque}


@app.post("/api/relais/salon")
def api_relais_salon_envoyer(t: MsgSalonEnvoi):
    _exiger_salle()
    texte = t.texte.strip()
    if not texte:
        raise HTTPException(400, "Écris un message avant d'envoyer.")
    if len(texte) > 1000:
        raise HTTPException(400, "Message trop long (1000 caractères au maximum).")
    coffre_ = etat_coffre()
    if coffre_ != "ouvert":
        raise HTTPException(423, "Crée ton coffre dans l'onglet Contacts : il reçoit la clé du salon." if coffre_ == "absent" else MSG_VERROUILLE)
    with verrou_salon:
        epoques = sorted(salon_cles)
    if not epoques:
        raise HTTPException(409, "Tu n'as pas encore la clé du salon : un admin doit être connecté avec son coffre ouvert pour te l'envoyer.")
    epoque = epoques[-1]
    with verrou:
        contenu = {"t": texte, "u": mon_profil["pseudo"]}
        moi = relais_cfg["id"]
    rep = t.reponse_a
    if isinstance(rep, dict) and isinstance(rep.get("n"), int):
        contenu["r"] = {"n": rep["n"], "p": str(rep.get("p", ""))[:MAX_PSEUDO], "x": str(rep.get("x", ""))[:120]}
    data = chiffrer_salon(contenu, epoque, moi)
    return _appel_salon("POST", "/relais/salon/envoyer", {"data": data, "epoque": epoque, "ttl": _ttl_valide(t.ttl)}, delai=8)


def _ttl_valide(ttl):
    if not ttl:
        return 0
    if not 5 <= ttl <= 86400:
        raise HTTPException(400, "Durée de vie d'un message éphémère : de 5 secondes à 24 heures.")
    return int(ttl)


@app.post("/api/relais/salon/evenement")
def api_relais_salon_evenement(t: EvenementSalon):
    """Réaction, sondage, vote ou coup de jeu : un « message » du salon comme un autre (même clé AES, même relais aveugle)."""
    _exiger_salle()
    ev = assainir_evenement(t.k, t.model_dump())
    if ev is None:
        raise HTTPException(400, "Événement invalide.")
    coffre_ = etat_coffre()
    if coffre_ != "ouvert":
        raise HTTPException(423, "Crée ton coffre dans l'onglet Contacts : il reçoit la clé du salon." if coffre_ == "absent" else MSG_VERROUILLE)
    with verrou_salon:
        epoques = sorted(salon_cles)
    if not epoques:
        raise HTTPException(409, "Tu n'as pas encore la clé du salon : un admin doit être connecté avec son coffre ouvert pour te l'envoyer.")
    epoque = epoques[-1]
    with verrou:
        contenu = {"k": t.k, "u": mon_profil["pseudo"], **ev}
        moi = relais_cfg["id"]
    data = chiffrer_salon(contenu, epoque, moi)
    return _appel_salon("POST", "/relais/salon/envoyer", {"data": data, "epoque": epoque, "ttl": _ttl_valide(t.ttl)}, delai=8)


@app.post("/api/relais/salon/supprimer")
def api_relais_salon_supprimer(c: CibleMsgSalon):
    _exiger_salle()
    return _appel_salon("POST", "/relais/salon/supprimer", {"n": c.n})


@app.post("/api/relais/salon/role")
def api_relais_salon_role(c: CibleMembreSalon):
    _exiger_salle()
    return _appel_salon("POST", "/relais/salon/role", {"id": c.id, "role": c.role})


@app.post("/api/relais/salon/retirer")
def api_relais_salon_retirer(c: CibleMembreSalon):
    _exiger_salle()
    return _appel_salon("POST", "/relais/salon/retirer", {"id": c.id})


# --- Créer et héberger une salle (le PC du professeur fait tourner le relais) -------------
class CreerSalle(BaseModel):
    nom: str = ""
    rejoindre: bool = True   # le professeur entre aussi dans sa salle pour écrire aux élèves


class CibleSalle(BaseModel):
    code: str = ""
    id: str = ""


def etat_hebergement():
    import relais
    relais.preparer()
    return {"actif": relais.heberge(), "port": relais.PORT_RELAIS, "ip": relais.ip_locale(), "salles": relais.info_salles()}


def _demarrer_relais_local():
    import relais
    try:
        relais.demarrer_hebergement(int(os.environ.get("MC_PORT_RELAIS", relais.PORT_RELAIS)))
    except OSError as e:
        raise HTTPException(409, str(e))
    return relais


@app.get("/api/salle/hebergement")
def api_salle_hebergement():
    return etat_hebergement()


@app.post("/api/salle/demarrer")
def api_salle_demarrer():
    _demarrer_relais_local()
    return etat_hebergement()


@app.post("/api/salle/creer")
def api_salle_creer(c: CreerSalle):
    relais = _demarrer_relais_local()
    with relais.verrou:
        code = relais.creer_salle(c.nom)
    if c.rejoindre:
        try:
            api_relais_rejoindre(RejoindreRelais(url=f"127.0.0.1:{relais.PORT_RELAIS}", code=code))
        except HTTPException:
            pass  # la salle existe quand même : le professeur pourra la rejoindre à la main
    return {**etat_hebergement(), "code": code}


@app.post("/api/salle/nouveau-code")
def api_salle_nouveau_code(c: CibleSalle):
    import relais
    relais.renouveler_code(c.code)
    return etat_hebergement()


@app.post("/api/salle/retirer")
def api_salle_retirer(c: CibleSalle):
    import relais
    relais.retirer_eleve(c.code, c.id)
    return etat_hebergement()


def _quitter_si_local():
    """Si je suis moi-même dans une salle hébergée ici, je la quitte (sinon le relais injoignable s'afficherait en erreur)."""
    import relais
    with verrou:
        local = relais_cfg.get("url", "").startswith(("http://127.0.0.1:", "http://localhost:")) and relais_cfg.get("url", "").endswith(f":{relais.PORT_RELAIS}")
    if local:
        api_relais_quitter()


@app.post("/api/salle/supprimer")
def api_salle_supprimer(c: CibleSalle):
    import relais
    relais.supprimer_salle(c.code)
    _quitter_si_local()
    return etat_hebergement()


@app.post("/api/salle/fermer")
def api_salle_fermer():
    import relais
    _quitter_si_local()
    relais.arreter_hebergement()
    return etat_hebergement()


# --- Carnet de contacts ------------------------------------------------------
@app.get("/api/contacts")
def api_contacts():
    with verrou:
        return {"contacts": dict(contacts), "profils": {ip: dict(p) for ip, p in profils_distants.items()}}


@app.post("/api/contacts")
def api_ajouter_contact(c: Contact):
    ip, nom = c.ip.strip(), c.name.strip()
    if not ip:
        raise HTTPException(400, "L'adresse IP est requise.")
    with verrou:
        contacts[ip] = nom
        ecrire_json(FICHIER_CONTACTS, contacts)
    return {"resultat": "ok"}


@app.post("/api/supprimer-contact")
def api_supprimer_contact(c: Contact):
    ip = c.ip.strip()
    with verrou:
        contacts.pop(ip, None)
        ecrire_json(FICHIER_CONTACTS, contacts)
        if profils_distants.pop(ip, None) is not None:
            ecrire_json(FICHIER_PROFILS_DISTANTS, profils_distants)
        # La clé échangée part avec le contact (si le coffre est verrouillé, elle reste dans le coffre).
        if coffre["donnees"] is not None and coffre["donnees"]["cles"].pop(ip, None) is not None:
            sauver_coffre()
    return {"resultat": "ok"}


@app.post("/api/renommer-contact")
def api_renommer_contact(c: Contact):
    ip = c.ip.strip()
    with verrou:
        if ip in contacts:
            contacts[ip] = c.name.strip()
            ecrire_json(FICHIER_CONTACTS, contacts)
    return {"resultat": "ok"}


@app.post("/api/vider-contacts")
def api_vider_contacts():
    with verrou:
        contacts.clear()
        ecrire_json(FICHIER_CONTACTS, contacts)
        profils_distants.clear()
        ecrire_json(FICHIER_PROFILS_DISTANTS, profils_distants)
        if coffre["donnees"] is not None and coffre["donnees"]["cles"]:
            coffre["donnees"]["cles"].clear()
            sauver_coffre()
    return {"resultat": "ok"}


# --- Coffre et échange de clés -----------------------------------------------
@app.get("/api/echanges")
def api_echanges():
    """État du coffre, clés échangées, demandes reçues et demandes envoyées en attente."""
    with verrou:
        etat = etat_coffre()
        ouvert = etat == "ouvert"
        demandes = []
        for ip, d in echanges["demandes"].items():
            item = {"ip": ip, "heure": d["heure"]}
            if ouvert:
                item["code"] = code_securite(d["pub"])
            demandes.append(item)
        cles = {}
        if ouvert:
            for ip, k in coffre["donnees"]["cles"].items():
                cles[ip] = {"verifie": k["verifie"], "date": k["date"], "algo": k.get("algo", "rsa"),
                        "code": k.get("code") or code_securite(k["pub"]), **infos_pub(k.get("pub"))}
        sortants = sorted({s["ip"] for s in echanges["sortants"].values()})
        importees = {}
        if ouvert:
            for ip, i in coffre["donnees"].get("importees", {}).items():
                importees[ip] = {"date": i["date"], **infos_pub(i["pub"])}
        moi = empreinte_pub(coffre["donnees"]["rsa_publique"]) if ouvert else None  # change si ma paire est remplacée
        return {"etat": etat, "cles": cles, "demandes": demandes, "sortants": sortants, "importees": importees, "moi": moi}


def empreinte_pub(pub):
    """Empreinte d'une clé publique (DER en base64) : SHA-256, 16 premiers octets, en hexadécimal par groupes de 4."""
    h = hashlib.sha256(b64d(pub)).hexdigest()[:32].upper()
    return " ".join(h[i:i + 4] for i in range(0, 32, 4))


def pem_de(pub):
    return ("-----BEGIN PUBLIC KEY-----\n" + "\n".join(pub[i:i + 64] for i in range(0, len(pub), 64))
            + "\n-----END PUBLIC KEY-----\n")


def infos_pub(pub):
    """Ce qu'on peut montrer d'une clé publique RSA de contact : empreinte, taille et PEM ({} si ce n'est pas du RSA valide,
    par exemple une ancienne clé X25519 d'avant la migration)."""
    cle = charger_pub_rsa(pub)
    if cle is None:
        return {}
    return {"empreinte": empreinte_pub(pub), "bits": cle.key_size, "pem": pem_de(pub)}


def pub_depuis_texte(texte):
    """Clé publique collée ou lue dans un fichier (PEM, ou DER en base64 brut) -> DER en base64 validée, sinon None."""
    texte = (texte or "").strip()
    if not texte or len(texte) > 8192:
        return None
    try:
        if "BEGIN" in texte:
            cle = serialization.load_pem_public_key(texte.encode("ascii"))
        else:
            cle = serialization.load_der_public_key(b64d("".join(texte.split())))
        der = cle.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    except (binascii.Error, ValueError, UnicodeEncodeError, TypeError):
        return None
    pub = b64e(der)
    return pub if pub_valide(pub) else None


@app.get("/api/identite")
def api_identite():
    """Ma paire de clés RSA : la clé publique (celle que les contacts reçoivent) et son empreinte. Jamais la clé privée."""
    with verrou:
        exiger_ouvert()
        pub = coffre["donnees"]["rsa_publique"]
        cree = coffre["donnees"].get("rsa_date")
    cle = charger_pub_rsa(pub)
    return {"algo": "RSA", "bits": cle.key_size if cle else 0, "publique": pub, "pem": pem_de(pub),
            "cree": cree, "empreinte": empreinte_pub(pub)}


def verifier_mdp_coffre(mdp):
    """Le mot de passe redonné est-il celui du coffre ouvert ? (scrypt est lent exprès : hors du verrou)"""
    with verrou:
        exiger_ouvert()
        sel, attendu = coffre["sel"], coffre["cle"]
    if not hmac.compare_digest(deriver(mdp, sel), attendu):
        raise HTTPException(400, "Mot de passe incorrect.")


@app.post("/api/identite/privee")
def api_identite_privee(m: MotDePasse, reponse: Response):
    """Ma clé privée (PEM), uniquement si le mot de passe du coffre est redonné : elle n'apparaît jamais sans ce geste volontaire.
    Cette clé ne doit être montrée ni envoyée à personne."""
    reponse.headers["Cache-Control"] = "no-store"
    verifier_mdp_coffre(m.mdp)
    with verrou:
        exiger_ouvert()
        pem = cle_privee().private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption()).decode("ascii")
    return {"pem": pem}


# --- Clé RSA construite à partir de deux nombres premiers choisis par l'utilisateur ------------------
# Les petits nombres premiers sont refusés : n = p × q serait factorisé en quelques secondes (voir l'atelier
# « RSA pas à pas », qui montre l'attaque). Ici, p et q doivent avoir au moins 1536 bits chacun (≈ 463 chiffres).
BITS_PREMIER_MIN = RSA_MIN // 2
E_RSA = 65537


def est_premier(n, tours=40):
    """Test de Miller-Rabin : erreur possible de 4^-40 au plus."""
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(tours):
        x = pow(2 + secrets.randbelow(n - 3), d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


def lire_entier(texte, nom):
    t = "".join((texte or "").split())
    if not t.isdigit() or len(t) > 1200:
        raise HTTPException(400, f"{nom} doit être un nombre entier écrit en chiffres (sans signe ni lettres).")
    return int(t)


class Premiers(BaseModel):
    p: str
    q: str
    mdp: str


@app.post("/api/premiers/aleatoires")
def api_premiers_aleatoires():
    """Deux grands nombres premiers tirés au hasard, pour essayer la fonction ci-dessous. Ce ne sont pas ceux de ma clé."""
    nombres = rsa.generate_private_key(public_exponent=E_RSA, key_size=RSA_BITS).private_numbers()
    return {"p": str(nombres.p), "q": str(nombres.q), "bits": BITS_PREMIER_MIN}


@app.post("/api/identite/depuis-premiers")
def api_identite_depuis_premiers(c: Premiers):
    """Remplace ma paire RSA par celle que définissent p et q. Mot de passe du coffre exigé."""
    p, q = lire_entier(c.p, "p"), lire_entier(c.q, "q")
    verifier_mdp_coffre(c.mdp)
    if p == q:
        raise HTTPException(400, "p et q doivent être différents.")
    if min(p, q).bit_length() < BITS_PREMIER_MIN or (p * q).bit_length() < RSA_MIN:
        raise HTTPException(400, f"p et q sont trop petits : il faut {BITS_PREMIER_MIN} bits chacun au moins (environ 463 chiffres), "
                                 f"pour que n = p × q fasse au moins {RSA_MIN} bits. Avec de petits nombres, n se factorise en quelques secondes.")
    if abs(p - q).bit_length() < (p * q).bit_length() // 2 - 100:
        raise HTTPException(400, "p et q sont trop proches l'un de l'autre : la méthode de Fermat retrouverait la clé privée.")
    if not est_premier(p) or not est_premier(q):
        raise HTTPException(400, "p ou q n'est pas un nombre premier.")
    phi = (p - 1) * (q - 1)
    if math.gcd(E_RSA, phi) != 1:
        raise HTTPException(400, f"p − 1 ou q − 1 est divisible par {E_RSA} : choisis d'autres nombres premiers.")
    d = pow(E_RSA, -1, math.lcm(p - 1, q - 1))
    prive = rsa.RSAPrivateNumbers(p, q, d, rsa.rsa_crt_dmp1(d, p), rsa.rsa_crt_dmq1(d, q), rsa.rsa_crt_iqmp(p, q),
                                  rsa.RSAPublicNumbers(E_RSA, p * q)).private_key()
    pub = b64e(prive.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))
    with verrou:
        exiger_ouvert()
        coffre["donnees"].update(
            rsa_date=maintenant(), rsa_publique=pub,
            rsa_prive=b64e(prive.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())))
        sauver_coffre()
    return {"empreinte": empreinte_pub(pub), "bits": (p * q).bit_length()}


class ClePublique(BaseModel):
    ip: str
    name: str = ""
    pem: str


@app.post("/api/cle-publique/importer")
def api_cle_publique_importer(c: ClePublique):
    """Import manuel de la clé publique d'un contact (copier-coller ou fichier .pem), sans échange par le réseau."""
    ip = c.ip.strip()
    if not ip:
        raise HTTPException(400, "L'adresse IP du contact est requise.")
    pub = pub_depuis_texte(c.pem)
    if pub is None:
        raise HTTPException(400, f"Clé publique invalide : il faut une clé RSA d'au moins {RSA_MIN} bits (exposant 65537), "
                                 "au format PEM (-----BEGIN PUBLIC KEY-----).")
    with verrou:
        exiger_ouvert()
        if pub == coffre["donnees"]["rsa_publique"]:
            raise HTTPException(400, "C'est ta propre clé publique : importe celle de ton contact.")
        coffre["donnees"].setdefault("importees", {})[ip] = {"pub": pub, "date": maintenant()}
        sauver_coffre()
        nom = c.name.strip()
        if nom or ip not in contacts:
            contacts[ip] = nom or contacts.get(ip, "")
            ecrire_json(FICHIER_CONTACTS, contacts)
    return {"empreinte": empreinte_pub(pub)}


@app.post("/api/cle-publique/supprimer")
def api_cle_publique_supprimer(c: Ip):
    with verrou:
        exiger_ouvert()
        if coffre["donnees"].get("importees", {}).pop(c.ip.strip(), None) is not None:
            sauver_coffre()
    return {"resultat": "ok"}


@app.post("/api/coffre/creer")
def api_coffre_creer(m: MotDePasse):
    if len(m.mdp) < MDP_MIN:
        raise HTTPException(400, f"Le mot de passe doit contenir au moins {MDP_MIN} caractères.")
    with verrou:
        if etat_coffre() != "absent":
            raise HTTPException(409, "Un coffre existe déjà.")
        creer_coffre(m.mdp)
        finaliser_acks()
        finaliser_lus()
        signaler_remis_en_attente()
    return {"etat": "ouvert"}


@app.post("/api/coffre/ouvrir")
def api_coffre_ouvrir(m: MotDePasse):
    with verrou:
        if etat_coffre() == "absent":
            raise HTTPException(404, "Aucun coffre : crée-en un d'abord.")
        if etat_coffre() != "ouvert":
            ouvrir_coffre(m.mdp)
        finaliser_acks()  # termine les échanges dont la réponse est arrivée pendant le verrouillage
        finaliser_lus()   # valide les accusés « lu » et « remis » arrivés pendant le verrouillage
        signaler_remis_en_attente()  # envoie les accusés « remis » qui attendaient le coffre
    return {"etat": "ouvert"}


@app.post("/api/coffre/verrouiller")
def api_coffre_verrouiller():
    with verrou:
        verrouiller_coffre()
    return {"etat": etat_coffre()}


@app.post("/api/coffre/reinitialiser")
def api_coffre_reinitialiser():
    """Mot de passe oublié : supprime le coffre. Les clés échangées sont perdues définitivement."""
    with verrou:
        verrouiller_coffre()
        try:
            FICHIER_COFFRE.unlink(missing_ok=True)
        except OSError:
            raise HTTPException(500, "Impossible de supprimer le coffre.")
        echanges["acks"].clear()
        echanges["sortants"].clear()
        sauver_echanges()
    return {"etat": "absent"}


@app.post("/api/echange/demarrer")
def api_echange_demarrer(c: Ip):
    ip = c.ip.strip()
    if not ip:
        raise HTTPException(400, "L'adresse IP est requise.")
    with verrou:
        exiger_ouvert()
        pub = coffre["donnees"]["rsa_publique"]
        jeton = secrets.token_hex(8)
        sig = b64e(signer(transcrit_hello(jeton, pub)))
    envoyer_trame(ip, json.dumps({"t": "hello", "pub": pub, "r": jeton, "sig": sig, **champs_profil()}))
    with verrou:
        for j in [j for j, s in echanges["sortants"].items() if s["ip"] == ip]:
            del echanges["sortants"][j]  # une seule demande en attente par contact
        echanges["sortants"][jeton] = {"ip": ip, "heure": maintenant()}
        sauver_echanges()
    return {"resultat": "ok"}


@app.post("/api/echange/accepter")
def api_echange_accepter(c: Ip):
    ip = c.ip.strip()
    with verrou:
        exiger_ouvert()
        demande = echanges["demandes"].get(ip)
        if not demande:
            raise HTTPException(404, "Aucune demande de ce PC.")
        pub_distante = charger_pub_rsa(demande["pub"])
        if pub_distante is None:
            echanges["demandes"].pop(ip, None)
            sauver_echanges()
            raise HTTPException(400, "La clé publique reçue est invalide : demande supprimée.")
        cle = os.urandom(32)  # clé secrète choisie ici, envoyée chiffrée avec la clé publique du contact
        wrap = pub_distante.encrypt(cle, OAEP)
        pub = coffre["donnees"]["rsa_publique"]
        sig = signer(transcrit_ack(demande["r"], pub, wrap))
    envoyer_trame(ip, json.dumps({"t": "ack", "pub": pub, "r": demande["r"], "wrap": b64e(wrap), "sig": b64e(sig), **champs_profil()}))
    with verrou:
        enregistrer_cle(ip, cle, demande["pub"])
        sauver_coffre()
        echanges["demandes"].pop(ip, None)
        sauver_echanges()
        if ip not in contacts:  # le PC est ajouté au carnet pour qu'on puisse lui écrire
            contacts[ip] = ""
            ecrire_json(FICHIER_CONTACTS, contacts)
    return {"resultat": "ok"}


@app.post("/api/echange/refuser")
def api_echange_refuser(c: Ip):
    with verrou:
        echanges["demandes"].pop(c.ip.strip(), None)
        sauver_echanges()
    return {"resultat": "ok"}


@app.post("/api/cle/verifier")
def api_cle_verifier(v: Verification):
    with verrou:
        exiger_ouvert()
        k = coffre["donnees"]["cles"].get(v.ip.strip())
        if not k:
            raise HTTPException(404, "Aucune clé pour ce contact.")
        k["verifie"] = v.verifie
        sauver_coffre()
    return {"resultat": "ok"}


@app.post("/api/cle/revoquer")
def api_cle_revoquer(c: Ip):
    with verrou:
        exiger_ouvert()
        if coffre["donnees"]["cles"].pop(c.ip.strip(), None) is not None:
            sauver_coffre()
    return {"resultat": "ok"}


# --- Déchiffrement et démonstration ------------------------------------------
@app.post("/api/dechiffrer")
def api_dechiffrer(d: Dechiffrement):
    crypte, entree = d.crypte, None
    if d.id:
        with verrou:
            entree = next((m for m in historique if m["id"] == d.id), None)
            crypte = crypte_de(entree) if entree else ""
        if not crypte:
            raise HTTPException(404, "Message introuvable (effacé de l'historique ?).")
    try:
        brut = decoder(crypte)
    except ValueError:
        raise HTTPException(400, "Ce texte n'est pas un message chiffré valide.")
    if brut[0] in (1, 4) and not d.cle:
        raise HTTPException(400, "Saisis la clé utilisée par l'émetteur.")
    try:
        clair = dechiffrer(crypte, d.cle)
    except HTTPException:
        raise
    except LookupError:
        raise HTTPException(400, "Aucune clé échangée ne correspond à ce message (clé révoquée ou contact supprimé ?).")
    except Exception:
        raise HTTPException(400, "Impossible de déchiffrer : la clé est incorrecte ou le "
                                 "message a été modifié. Aucune partie du message n'est révélée.")
    texte_rep, cite = decouper_reponse(clair)
    if cite:
        clair = f"↩ « {cite['x']} »\n{texte_rep}"
    resultat = {"clair": "🎮 Coup de jeu (visible dans l'onglet Conversations)" if evenement_jeu(clair) else texte_visible(clair)}
    if brut[0] in (3, 4) and clair.startswith("{"):  # pièce jointe
        try:
            resultat = {"clair": "", "fichier": lire_enveloppe_fichier(clair)}
        except ValueError:
            raise HTTPException(400, "Le contenu de ce message n'est pas un fichier valide.")
    if brut[0] in (2, 3):  # déchiffré avec la clé du contact : l'émetteur reçoit un accusé « lu »
        with verrou:
            if entree is None:
                h = empreinte(crypte)
                entree = next((m for m in historique if m["sens"] == "recu" and h_de(m) == h), None)
            if entree:
                signaler_lu(entree)
    return resultat


@app.post("/api/demo")
def api_demo(d: Demo):
    """Chiffrement pas à pas avec toutes les valeurs intermédiaires (page « Comment ça marche »)."""
    texte = d.texte.strip()
    if not texte:
        raise HTTPException(400, "Écris un texte à chiffrer.")
    if len(texte) > 200:
        raise HTTPException(400, "Pour la démonstration, le texte est limité à 200 caractères.")
    if len(d.cle) < CLE_MIN:
        raise HTTPException(400, f"La clé doit contenir au moins {CLE_MIN} caractères.")
    sel, nonce = os.urandom(16), os.urandom(12)
    cle_derivee = deriver(d.cle, sel)
    sortie = AESGCM(cle_derivee).encrypt(nonce, texte.encode("utf-8"), b"v1")
    message = b64e(b"\x01" + sel + nonce + sortie)
    return {"texte_hex": texte.encode("utf-8").hex(), "sel": sel.hex(), "cle_derivee": cle_derivee.hex(),
            "nonce": nonce.hex(), "chiffre": sortie[:-16].hex(), "tag": sortie[-16:].hex(),
            "message": message, "taille": len(message)}


# ---------------------------------------------------------------------------------------------
# Mises à jour (GitHub Releases, manifeste signé Ed25519) : voir mise_a_jour.py
# ---------------------------------------------------------------------------------------------
INTERVALLE_MAJ = 6 * 3600   # secondes entre deux recherches automatiques
verrou_maj = threading.Lock()
# etat : inactif (jamais vérifié) · a_jour · disponible · telechargement · installation · erreur
etat_maj = {"etat": "inactif", "manifeste": None, "erreur": "", "erreur_verif": "", "verifie": False, "progression": 0}


def _vue_maj():
    with verrou_maj:
        m = etat_maj["manifeste"] or {}
        return {"version": mise_a_jour.VERSION, "configure": mise_a_jour.est_configure(),
                "installable": bool(getattr(sys, "frozen", False)), "etat": etat_maj["etat"],
                "nouvelle_version": m.get("version", ""), "notes": str(m.get("notes", ""))[:300],
                "erreur": etat_maj["erreur"], "erreur_verif": etat_maj["erreur_verif"],
                "verifie": etat_maj["verifie"], "progression": etat_maj["progression"],
                "page": mise_a_jour.page_releases()}


def verifier_maj():
    """Interroge GitHub. L'état n'est pas touché pendant un téléchargement ou une installation."""
    with verrou_maj:
        if etat_maj["etat"] in ("telechargement", "installation"):
            return
    try:
        m, erreur = mise_a_jour.lire_manifeste(), ""
    except mise_a_jour.MiseAJourErreur as e:
        m, erreur = None, str(e)
    with verrou_maj:
        if etat_maj["etat"] in ("telechargement", "installation"):
            return
        etat_maj["erreur_verif"] = erreur
        if erreur:
            return  # on garde l'état précédent (une version déjà annoncée reste proposée)
        etat_maj["verifie"] = True
        if mise_a_jour.est_plus_recente(m):
            etat_maj.update(etat="disponible", manifeste=m, erreur="")
        else:
            etat_maj.update(etat="a_jour", manifeste=None, erreur="")


def thread_maj():
    if not mise_a_jour.est_configure():
        return
    time.sleep(5)  # laisse le programme finir de démarrer
    while True:
        verifier_maj()
        time.sleep(INTERVALLE_MAJ)


def _installer_maj(m):
    def progression(recu, total):
        if total:
            with verrou_maj:
                etat_maj["progression"] = min(100, int(recu * 100 / total))
    try:
        chemin = mise_a_jour.telecharger(m, progression)
        with verrou_maj:
            etat_maj["etat"] = "installation"
        time.sleep(1.5)  # laisse l'interface afficher « redémarrage »
        with verrou:     # aucune écriture de données en cours pendant le remplacement
            mise_a_jour.installer_et_relancer(chemin)
    except Exception as e:
        if not isinstance(e, mise_a_jour.MiseAJourErreur):
            traceback.print_exc()
        message = str(e) if isinstance(e, mise_a_jour.MiseAJourErreur) else "Échec de la mise à jour."
        with verrou_maj:
            etat_maj.update(etat="erreur", erreur=message)


def attendre_port_libre(port, delai=20):
    """Après une mise à jour, l'ancien processus peut encore tenir ses ports quelques instants."""
    fin = time.time() + delai
    while time.time() < fin:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
        except OSError:
            return
        time.sleep(0.3)


@app.get("/api/maj")
def api_maj():
    return _vue_maj()


@app.post("/api/maj/verifier")
def api_maj_verifier():
    if mise_a_jour.est_configure():
        verifier_maj()
    return _vue_maj()


@app.post("/api/maj/installer")
def api_maj_installer():
    if not getattr(sys, "frozen", False):
        raise HTTPException(400, "La mise à jour automatique n'existe que dans l'exécutable : télécharge la nouvelle version depuis la page des versions.")
    with verrou_maj:
        if etat_maj["etat"] not in ("disponible", "erreur") or not etat_maj["manifeste"]:
            raise HTTPException(409, "Aucune mise à jour à installer.")
        m = etat_maj["manifeste"]
        etat_maj.update(etat="telechargement", erreur="", progression=0)
    threading.Thread(target=_installer_maj, args=(m,), daemon=True).start()
    return _vue_maj()


with verrou:
    purger()
    nettoyer_blobs()

if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="front")

if __name__ == "__main__":
    if "--relais" in sys.argv:  # PC de la salle : python main.py --relais [--port-relais=8100]
        import relais
        port = next((int(a.split("=", 1)[1]) for a in sys.argv if a.startswith("--port-relais=") and a.split("=", 1)[1].isdigit()), None)
        relais.lancer_relais(port)
        sys.exit(0)
    if os.environ.get("MC_RELANCE_MAJ"):  # redémarrage après une mise à jour : on attend la fin de l'ancien processus
        for port in (PORT_WEB, PORT_SOCKET):
            attendre_port_libre(port)
    threading.Thread(target=ecouter, daemon=True).start()
    threading.Thread(target=thread_relais, daemon=True).start()
    threading.Thread(target=ecouter_udp, daemon=True).start()
    threading.Thread(target=thread_file_attente, daemon=True).start()
    threading.Thread(target=thread_maj, daemon=True).start()
    nettoyage = threading.Timer(30, mise_a_jour.nettoyer_ancienne_version)  # supprime le .old de la version précédente
    nettoyage.daemon = True
    nettoyage.start()
    url = f"http://localhost:{PORT_WEB}"
    print("Messagerie chiffrée est lancée.")
    print(f"Interface : {url}")
    print("Ferme cette fenêtre pour arrêter le programme.")
    if not os.environ.get("MC_SANS_NAVIGATEUR"):
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    try:
        uvicorn.run(app, host="127.0.0.1", port=PORT_WEB, log_level="warning")
    except (OSError, SystemExit):
        print(f"\nImpossible de démarrer : le port {PORT_WEB} est déjà utilisé. "
              "Le programme est probablement déjà ouvert.")
        input("Appuie sur Entrée pour fermer.")
