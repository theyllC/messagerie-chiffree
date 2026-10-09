"""Mises à jour authentifiées via GitHub Releases.

Principe : chaque release publie un manifeste `version.json` (version, URL de l'exe, SHA-256,
signature Ed25519). Le programme n'installe rien dont la signature ne correspond pas à la clé
publique embarquée ci-dessous : la clé privée reste chez le développeur (secret GitHub).
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# --- À configurer une seule fois ---------------------------------------------------------------
VERSION = "1.0.0"                                  # réécrit automatiquement par la CI depuis le tag
DEPOT = "theyllC/messagerie-chiffree"                     # ex. "desyy/messagerie-chiffree"
CLE_PUBLIQUE_B64 = "9HG3kslJjfU8nIkWsIZ3YQZkqNkzPkeSPIdl3A358Mw="     # affichée par : python tools/signer_release.py --generer
# -----------------------------------------------------------------------------------------------

TIMEOUT = 10                       # secondes, par opération réseau
MAX_MANIFESTE = 64 * 1024          # octets
MAX_EXE = 300 * 1024 * 1024        # octets : garde-fou contre un téléchargement sans fin


class MiseAJourErreur(Exception):
    """Erreur dont le message peut être montré tel quel à l'utilisateur."""


def est_configure() -> bool:
    """Faux tant que le dépôt et la clé publique n'ont pas été renseignés (version de développement)."""
    return "TON_COMPTE" not in DEPOT and "COLLE_ICI" not in CLE_PUBLIQUE_B64


def url_manifeste() -> str:
    return f"https://github.com/{DEPOT}/releases/latest/download/version.json"


def prefixe_autorise() -> str:
    """Le manifeste ne peut désigner qu'un fichier de ce dépôt (et en HTTPS)."""
    return f"https://github.com/{DEPOT}/releases/download/"


def page_releases() -> str:
    return f"https://github.com/{DEPOT}/releases/latest"


def _tuple(version: str) -> tuple:
    if not isinstance(version, str) or not re.fullmatch(r"v?\d+(\.\d+){0,3}", version):
        raise MiseAJourErreur("Numéro de version invalide dans le manifeste.")
    return tuple(int(x) for x in version.lstrip("v").split("."))


def est_plus_recente(manifeste: dict) -> bool:
    return _tuple(manifeste["version"]) > _tuple(VERSION)


def _message_signe(m: dict) -> bytes:
    return f"{m['version']}|{m['url']}|{m['sha256']}".encode()  # identique à tools/signer_release.py


def _signature_valide(m: dict) -> bool:
    try:
        cle = Ed25519PublicKey.from_public_bytes(base64.b64decode(CLE_PUBLIQUE_B64))
        cle.verify(base64.b64decode(m["signature"]), _message_signe(m))
        return True
    except (InvalidSignature, KeyError, ValueError, TypeError):
        return False


def lire_manifeste() -> dict:
    """Télécharge et contrôle le manifeste (signature, adresse, formats). Lève MiseAJourErreur sinon."""
    if not est_configure():
        raise MiseAJourErreur("Les mises à jour ne sont pas configurées dans cette version.")
    try:
        with urllib.request.urlopen(url_manifeste(), timeout=TIMEOUT) as r:
            brut = r.read(MAX_MANIFESTE + 1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise MiseAJourErreur("Aucune version n'est publiée pour l'instant.") from None
        raise MiseAJourErreur(f"Serveur de mises à jour indisponible (code {e.code}).") from None
    except OSError:  # URLError, délai dépassé, hors ligne…
        raise MiseAJourErreur("Impossible de joindre le serveur de mises à jour (hors ligne ?).") from None
    if len(brut) > MAX_MANIFESTE:
        raise MiseAJourErreur("Manifeste de mise à jour trop volumineux.")
    try:
        m = json.loads(brut)
    except ValueError:
        raise MiseAJourErreur("Manifeste de mise à jour illisible.") from None
    if not isinstance(m, dict) or not all(isinstance(m.get(k), str) for k in ("version", "url", "sha256", "signature")):
        raise MiseAJourErreur("Manifeste de mise à jour incomplet.")
    if not _signature_valide(m):
        raise MiseAJourErreur("Signature du manifeste invalide : mise à jour ignorée.")
    if not m["url"].startswith(prefixe_autorise()):
        raise MiseAJourErreur("Adresse de téléchargement non autorisée : mise à jour ignorée.")
    if not re.fullmatch(r"[0-9a-f]{64}", m["sha256"]):
        raise MiseAJourErreur("Empreinte SHA-256 invalide dans le manifeste.")
    _tuple(m["version"])
    if not isinstance(m.get("notes", ""), str):
        m["notes"] = ""
    return m


def verifier_mise_a_jour() -> Optional[dict]:
    """Le manifeste s'il existe une version plus récente et authentique, sinon None (jamais d'exception)."""
    try:
        m = lire_manifeste()
        return m if est_plus_recente(m) else None
    except MiseAJourErreur:
        return None


def _sha256_fichier(chemin: Path) -> str:
    h = hashlib.sha256()
    with open(chemin, "rb") as f:
        while bloc := f.read(1 << 20):
            h.update(bloc)
    return h.hexdigest()


def telecharger(m: dict, progression: Optional[Callable[[int, int], None]] = None) -> Path:
    """Télécharge le nouvel exe et vérifie son SHA-256. Lève MiseAJourErreur si le fichier est refusé."""
    dossier = Path(tempfile.mkdtemp(prefix="maj_"))
    cible = dossier / "nouvelle_version.exe"
    h = hashlib.sha256()
    recu = 0
    try:
        with urllib.request.urlopen(m["url"], timeout=TIMEOUT) as r, open(cible, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            while bloc := r.read(1 << 20):
                recu += len(bloc)
                if recu > MAX_EXE:
                    raise MiseAJourErreur("Fichier de mise à jour anormalement gros : refusé.")
                h.update(bloc)
                f.write(bloc)
                if progression:
                    progression(recu, total)
    except MiseAJourErreur:
        shutil.rmtree(dossier, ignore_errors=True)
        raise
    except OSError:
        shutil.rmtree(dossier, ignore_errors=True)
        raise MiseAJourErreur("Téléchargement interrompu : réessaie dans un instant.") from None
    if h.hexdigest() != m["sha256"]:
        shutil.rmtree(dossier, ignore_errors=True)
        raise MiseAJourErreur("Empreinte SHA-256 invalide : le fichier téléchargé est refusé.")
    return cible


def installer_et_relancer(nouvel_exe: Path) -> None:
    """Remplace l'exe en cours (l'ancien devient .old), relance le programme puis quitte ce processus.

    Windows interdit d'écraser un exe en cours d'exécution mais autorise à le renommer.
    En cas de problème, l'ancienne version est remise en place et une MiseAJourErreur est levée.
    """
    if not getattr(sys, "frozen", False):
        raise MiseAJourErreur("La mise à jour automatique n'existe que dans l'exécutable.")
    exe = Path(sys.executable)
    ancien = exe.with_name(exe.name + ".old")
    try:
        ancien.unlink(missing_ok=True)
    except OSError:
        pass
    try:
        exe.rename(ancien)
    except OSError:
        raise MiseAJourErreur("Impossible de remplacer le programme (dossier protégé ou fichier verrouillé).") from None
    try:
        shutil.copy2(nouvel_exe, exe)
        if _sha256_fichier(exe) != _sha256_fichier(nouvel_exe):
            raise OSError("copie incomplète")
    except Exception:
        try:
            os.replace(ancien, exe)  # retour arrière
        except OSError:
            pass
        raise MiseAJourErreur("Installation impossible : l'ancienne version est conservée.") from None
    shutil.rmtree(Path(nouvel_exe).parent, ignore_errors=True)
    env = dict(os.environ, PYINSTALLER_RESET_ENVIRONMENT="1", MC_RELANCE_MAJ="1", MC_SANS_NAVIGATEUR="1")
    env.pop("_MEIPASS2", None)
    subprocess.Popen([str(exe), *sys.argv[1:]], env=env, close_fds=True)
    os._exit(0)


def nettoyer_ancienne_version() -> None:
    """Supprime le .old laissé par la mise à jour précédente (ignoré s'il est encore utilisé)."""
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable)
        try:
            exe.with_name(exe.name + ".old").unlink(missing_ok=True)
        except OSError:
            pass
