"""Test : clé publique du contact visible (/api/echanges) et clé privée révélée seulement avec le mot de passe du coffre.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_cles_affichage.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

import httpx
from cryptography.hazmat.primitives import serialization

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
MDP = "mot-de-passe-test"
ok_global = True


def lancer(dossier, web, hote):
    env = dict(os.environ, APPDATA=dossier, MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1")
    return subprocess.Popen([sys.executable, MAIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


def attendre(f, delai=10):
    fin = time.time() + delai
    while time.time() < fin:
        r = f()
        if r:
            return r
        time.sleep(0.2)
    return None


pa = lancer(os.path.join(RACINE, "A"), 8031, "127.0.0.1")
pb = lancer(os.path.join(RACINE, "B"), 8032, "127.0.0.2")
time.sleep(4)
A = httpx.Client(base_url="http://127.0.0.1:8031", timeout=60)
B = httpx.Client(base_url="http://127.0.0.1:8032", timeout=60)
try:
    check("clé privée refusée sans coffre", A.post("/api/identite/privee", json={"mdp": MDP}).status_code in (423, 404, 400))
    for c in (A, B):
        c.post("/api/coffre/creer", json={"mdp": MDP})
    r = A.post("/api/identite/privee", json={"mdp": "mauvais-mot-de-passe"})
    check("mauvais mot de passe : 400", r.status_code == 400 and "PRIVATE" not in r.text)
    r = A.post("/api/identite/privee", json={"mdp": MDP})
    check("bon mot de passe : 200, no-store", r.status_code == 200 and r.headers.get("cache-control") == "no-store")
    pem = r.json()["pem"]
    prive = serialization.load_pem_private_key(pem.encode(), password=None)
    pub_der = prive.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    import base64
    check("la clé privée correspond à la clé publique affichée", base64.b64encode(pub_der).decode() == A.get("/api/identite").json()["publique"])
    check("/api/identite ne contient toujours pas la clé privée", "PRIVATE" not in A.get("/api/identite").text)

    # échange de clés A -> B, puis chaque PC voit la clé publique de l'autre
    A.post("/api/echange/demarrer", json={"ip": "127.0.0.2"})
    attendre(lambda: B.get("/api/echanges").json()["demandes"])
    B.post("/api/echange/accepter", json={"ip": "127.0.0.1"})
    ea = attendre(lambda: A.get("/api/echanges").json()["cles"].get("127.0.0.2"))
    eb = B.get("/api/echanges").json()["cles"].get("127.0.0.1")
    ib, ia = B.get("/api/identite").json(), A.get("/api/identite").json()
    check("A voit la clé publique de B (PEM + empreinte)", ea and ea.get("pem") == ib["pem"] and ea.get("empreinte") == ib["empreinte"])
    check("B voit la clé publique de A", eb and eb.get("pem") == ia["pem"] and eb.get("empreinte") == ia["empreinte"])
    check("taille indiquée", ea and ea.get("bits") == 3072)
    A.post("/api/coffre/verrouiller")
    check("coffre verrouillé : clé privée refusée (423)", A.post("/api/identite/privee", json={"mdp": MDP}).status_code == 423)
finally:
    for p in (pa, pb):
        p.terminate()
    shutil.rmtree(RACINE, ignore_errors=True)
print("TOUT OK" if ok_global else "DES ECHECS")
sys.exit(0 if ok_global else 1)
