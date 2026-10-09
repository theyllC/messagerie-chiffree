"""Test des mises à jour : signature, téléchargement, remplacement de l'exe, endpoints.
Tout tourne sur ce PC, sans réseau : le « serveur » est un dossier (adresses file://) et le
redémarrage du programme est simulé (Popen et os._exit sont remplacés).
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_maj.py
"""
import base64
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

RACINE = Path(tempfile.mkdtemp())
os.environ["APPDATA"] = str(RACINE / "appdata")          # main.py lit APPDATA à l'import
BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND.parent / "tools"))

import mise_a_jour as mj  # noqa: E402
import signer_release  # noqa: E402
import main  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ok_global = True


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


def cle_paire():
    prive = Ed25519PrivateKey.generate()
    pub = prive.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return prive, base64.b64encode(pub).decode()


def signer_manifeste(prive, version, url, sha, notes="Notes de test"):
    sig = base64.b64encode(prive.sign(f"{version}|{url}|{sha}".encode())).decode()
    return {"version": version, "url": url, "sha256": sha, "notes": notes, "signature": sig}


def publier(manifeste):
    chemin = RACINE / "version.json"
    chemin.write_text(json.dumps(manifeste), encoding="utf-8")
    return chemin


def _raises(f):
    try:
        f()
        return False
    except mj.MiseAJourErreur:
        return True


def reinitialiser():
    main.etat_maj.update(etat="inactif", manifeste=None, erreur="", erreur_verif="", verifie=False, progression=0)


C = TestClient(main.app)
prive, pub = cle_paire()
nouvel_exe = RACINE / "serveur" / "MessagerieChiffree.exe"
nouvel_exe.parent.mkdir()
nouvel_exe.write_bytes(os.urandom(300_000))
sha = hashlib.sha256(nouvel_exe.read_bytes()).hexdigest()
url_exe = nouvel_exe.as_uri()

try:
    # ====================== 1. NON CONFIGURÉ (version de développement) ======================
    v = C.get("/api/maj").json()
    check("non configuré : configure = False, aucun état", v["configure"] is False and v["etat"] == "inactif", str(v))
    check("non configuré : vérification sans effet ni erreur", C.post("/api/maj/verifier").json()["etat"] == "inactif")
    check("hors exécutable : installation refusée (400)", C.post("/api/maj/installer").status_code == 400)

    # ====================== 2. CONFIGURATION DE TEST ======================
    mj.DEPOT, mj.CLE_PUBLIQUE_B64 = "test/depot", pub
    check("configuré après renseignement du dépôt et de la clé", mj.est_configure())

    # Le vrai script de signature produit un manifeste que le vrai module accepte
    exe_signe = RACINE / "MessagerieChiffree.exe"
    exe_signe.write_bytes(b"contenu de test")
    sortie = RACINE / "version_signee.json"
    os.environ["UPDATE_SIGNING_KEY"] = base64.b64encode(
        prive.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode()
    signer_release.signer(exe_signe, "2.0.0", "test/depot", sortie, "Notes")
    m_signe = json.loads(sortie.read_text(encoding="utf-8"))
    check("script de signature ↔ module : signature valide", mj._signature_valide(m_signe))
    check("script de signature : adresse dans le dépôt", m_signe["url"].startswith(mj.prefixe_autorise()), m_signe["url"])
    check("signature invalide si le SHA-256 est modifié", not mj._signature_valide(dict(m_signe, sha256="0" * 64)))
    check("signature invalide si l'adresse est modifiée", not mj._signature_valide(dict(m_signe, url="https://evil.example/x.exe")))
    _, autre_pub = cle_paire()
    mj.CLE_PUBLIQUE_B64 = autre_pub
    check("signature invalide avec une autre clé publique", not mj._signature_valide(m_signe))
    mj.CLE_PUBLIQUE_B64 = pub

    # Les adresses de test sont des file:// : on autorise ce préfixe pour la suite
    mj.prefixe_autorise = lambda: "file://"

    # ====================== 3. DÉTECTION D'UNE VERSION ======================
    mj.url_manifeste = lambda: publier(signer_manifeste(prive, "1.0.1", url_exe, sha)).as_uri()
    reinitialiser()
    v = C.post("/api/maj/verifier").json()
    check("version plus récente détectée", v["etat"] == "disponible" and v["nouvelle_version"] == "1.0.1" and v["notes"] == "Notes de test", str(v))

    mj.url_manifeste = lambda: publier(signer_manifeste(prive, "1.0.0", url_exe, sha)).as_uri()
    reinitialiser()
    check("même version : à jour", C.post("/api/maj/verifier").json()["etat"] == "a_jour")

    mj.url_manifeste = lambda: publier(signer_manifeste(prive, "0.9.0", url_exe, sha)).as_uri()
    reinitialiser()
    check("version plus ancienne : ignorée (pas de retour en arrière)", C.post("/api/maj/verifier").json()["etat"] == "a_jour")

    mj.url_manifeste = lambda: publier(signer_manifeste(prive, "1.10.0", url_exe, sha)).as_uri()
    reinitialiser()
    check("1.10.0 > 1.0.0 (comparaison numérique, pas alphabétique)", C.post("/api/maj/verifier").json()["etat"] == "disponible")

    # Manifeste falsifié : la version annoncée précédemment reste proposée, l'erreur est signalée
    faux = signer_manifeste(prive, "3.0.0", url_exe, sha)
    faux["sha256"] = "1" * 64
    mj.url_manifeste = lambda: publier(faux).as_uri()
    v = C.post("/api/maj/verifier").json()
    check("manifeste falsifié : refusé, état conservé", "Signature" in v["erreur_verif"] and v["nouvelle_version"] == "1.10.0", str(v))

    prive_pirate, _ = cle_paire()
    mj.url_manifeste = lambda: publier(signer_manifeste(prive_pirate, "9.9.9", url_exe, sha)).as_uri()
    reinitialiser()
    v = C.post("/api/maj/verifier").json()
    check("manifeste signé par une autre clé : refusé", v["etat"] == "inactif" and "Signature" in v["erreur_verif"], str(v))

    mj.prefixe_autorise = lambda: "https://github.com/test/depot/releases/download/"
    mj.url_manifeste = lambda: publier(signer_manifeste(prive, "9.9.9", "https://evil.example/x.exe", sha)).as_uri()
    reinitialiser()
    v = C.post("/api/maj/verifier").json()
    check("bonne signature mais adresse hors dépôt : refusé", v["etat"] == "inactif" and "non autorisée" in v["erreur_verif"], str(v))
    mj.prefixe_autorise = lambda: "file://"

    mj.url_manifeste = lambda: (RACINE / "inexistant.json").as_uri()
    reinitialiser()
    v = C.post("/api/maj/verifier").json()
    check("serveur injoignable : message clair, pas d'exception", "Impossible de joindre" in v["erreur_verif"], str(v))

    # ====================== 4. INSTALLATION (redémarrage simulé) ======================
    exe_app = RACINE / "app" / "MessagerieChiffree.exe"
    exe_app.parent.mkdir()
    exe_app.write_bytes(b"ANCIENNE VERSION")
    mj.url_manifeste = lambda: publier(signer_manifeste(prive, "2.0.0", url_exe, sha)).as_uri()
    reinitialiser()
    C.post("/api/maj/verifier")

    appels = {}
    with mock.patch.object(sys, "frozen", True, create=True), mock.patch.object(sys, "executable", str(exe_app)), \
            mock.patch.object(mj.subprocess, "Popen", side_effect=lambda *a, **k: appels.update(popen=(a, k))), \
            mock.patch.object(mj.os, "_exit", side_effect=lambda code: appels.update(sortie=code)):
        r = C.post("/api/maj/installer")
        check("installation lancée (état téléchargement)", r.status_code == 200 and r.json()["etat"] == "telechargement", r.text)
        check("deuxième clic pendant l'installation refusé (409)", C.post("/api/maj/installer").status_code == 409)
        fin = time.time() + 15
        while time.time() < fin and "sortie" not in appels:
            time.sleep(0.2)
        check("programme relancé puis ancien processus quitté", appels.get("sortie") == 0 and "popen" in appels, str(appels.keys()))
        args, kw = appels.get("popen", ((None,), {}))
        check("relance : bon exécutable", args[0][0] == str(exe_app))
        check("relance : environnement de redémarrage",
              kw.get("env", {}).get("MC_RELANCE_MAJ") == "1" and kw["env"].get("PYINSTALLER_RESET_ENVIRONMENT") == "1"
              and kw["env"].get("MC_SANS_NAVIGATEUR") == "1" and "_MEIPASS2" not in kw["env"])
        check("nouvel exe en place (contenu identique)", hashlib.sha256(exe_app.read_bytes()).hexdigest() == sha)
        ancien = exe_app.with_name(exe_app.name + ".old")
        check("ancien exe conservé en .old", ancien.exists() and ancien.read_bytes() == b"ANCIENNE VERSION")
        check("état « installation » exposé à l'interface", C.get("/api/maj").json()["etat"] == "installation")

        mj.nettoyer_ancienne_version()
        check("nettoyage du .old au démarrage suivant", not ancien.exists())

        # ---- fichier corrompu : le SHA-256 ne correspond pas, rien n'est remplacé ----
        exe_app.write_bytes(b"VERSION INTACTE")
        mauvais = signer_manifeste(prive, "2.0.0", url_exe, "2" * 64)  # signature valide, mais SHA-256 ≠ fichier
        mj.url_manifeste = lambda: publier(mauvais).as_uri()
        reinitialiser()
        C.post("/api/maj/verifier")
        appels.clear()
        C.post("/api/maj/installer")
        fin = time.time() + 15
        while time.time() < fin and C.get("/api/maj").json()["etat"] not in ("erreur", "installation"):
            time.sleep(0.2)
        v = C.get("/api/maj").json()
        check("fichier corrompu : état erreur avec message SHA-256", v["etat"] == "erreur" and "SHA-256" in v["erreur"], str(v))
        check("fichier corrompu : exe intact, pas de relance", exe_app.read_bytes() == b"VERSION INTACTE" and "popen" not in appels)

        # ---- « Réessayer » possible depuis l'état erreur ----
        mj.url_manifeste = lambda: publier(signer_manifeste(prive, "2.0.0", url_exe, sha)).as_uri()
        main.etat_maj["manifeste"] = signer_manifeste(prive, "2.0.0", url_exe, sha)
        r = C.post("/api/maj/installer")
        check("réessai accepté depuis l'état erreur", r.status_code == 200 and r.json()["etat"] == "telechargement", r.text)
        fin = time.time() + 15
        while time.time() < fin and "sortie" not in appels:
            time.sleep(0.2)
        check("réessai abouti", appels.get("sortie") == 0 and hashlib.sha256(exe_app.read_bytes()).hexdigest() == sha)

        # ---- retour arrière si la copie échoue ----
        exe_app.write_bytes(b"VERSION A PROTEGER")
        appels.clear()
        with mock.patch.object(mj.shutil, "copy2", side_effect=OSError("disque plein")):
            try:
                mj.installer_et_relancer(nouvel_exe)
                levee = False
            except mj.MiseAJourErreur:
                levee = True
        check("copie impossible : erreur levée, ancienne version remise en place",
              levee and exe_app.read_bytes() == b"VERSION A PROTEGER" and "popen" not in appels)

    # ====================== 5. ROBUSTESSE ======================
    for v in ["abc", "1.2.x", "", "1..2"]:
        check(f"numéro de version {v!r} refusé", _raises(lambda v=v: mj._tuple(v)))
finally:
    os.environ.pop("UPDATE_SIGNING_KEY", None)

print()
print("TOUS LES TESTS PASSENT" if ok_global else "DES TESTS ONT ECHOUE")
sys.exit(0 if ok_global else 1)
