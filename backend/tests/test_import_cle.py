"""Test : page « Mes clés » (empreinte, taille, date, PEM), import manuel d'une clé publique (PEM ou base64),
et message RSA direct (v5) entre deux PC qui n'ont fait aucun échange de clés par le réseau.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_import_cle.py
"""
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import time

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
ok_global = True
MDP = "mot-de-passe-test"


def lancer(dossier, web, hote):
    env = dict(os.environ, APPDATA=dossier, MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1")
    return subprocess.Popen([sys.executable, MAIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


def attendre(fonction, delai=8):
    fin = time.time() + delai
    while time.time() < fin:
        r = fonction()
        if r:
            return r
        time.sleep(0.2)
    return None


pa = lancer(os.path.join(RACINE, "A"), 8021, "127.0.0.1")
pb = lancer(os.path.join(RACINE, "B"), 8022, "127.0.0.2")
time.sleep(4)
A = httpx.Client(base_url="http://127.0.0.1:8021", timeout=60)
B = httpx.Client(base_url="http://127.0.0.1:8022", timeout=60)

try:
    for c in (A, B):
        check("création du coffre", c.post("/api/coffre/creer", json={"mdp": MDP}).status_code == 200)
    ia, ib = A.get("/api/identite").json(), B.get("/api/identite").json()

    # --- page « Mes clés »
    check("taille de clé : 3072 bits", ia["bits"] == 3072)
    check("date de création présente", bool(ia["cree"]) and ia["cree"][:2] == "20", str(ia["cree"]))
    check("empreinte : 8 groupes de 4 caractères hexadécimaux",
          len(ia["empreinte"].split()) == 8 and all(len(g) == 4 for g in ia["empreinte"].split()))
    check("PEM bien formé", ia["pem"].startswith("-----BEGIN PUBLIC KEY-----\n") and ia["pem"].endswith("-----END PUBLIC KEY-----\n"))
    cle_pem = serialization.load_pem_public_key(ia["pem"].encode())
    check("le PEM est bien la clé publique annoncée",
          base64.b64encode(cle_pem.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).decode() == ia["publique"])
    check("aucune clé privée dans la réponse", "PRIVATE" not in str(ia) and "rsa_prive" not in str(ia))

    # --- import refusé
    def importer(client, ip, texte, nom=""):
        return client.post("/api/cle-publique/importer", json={"ip": ip, "pem": texte, "name": nom})

    check("texte quelconque refusé", importer(A, "127.0.0.2", "ceci n'est pas une clé").status_code == 400)
    faible = rsa.generate_private_key(65537, 2048).public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    check("clé RSA de 2048 bits refusée", importer(A, "127.0.0.2", faible).status_code == 400)
    check("sa propre clé refusée", importer(A, "127.0.0.2", ia["pem"]).status_code == 400)
    check("message v5 impossible sans clé importée",
          A.post("/api/envoyer", json={"ip": "127.0.0.2", "message": "x", "rsa_direct": True}).status_code == 400)

    # --- import accepté : PEM d'un côté, base64 brut de l'autre
    r = importer(A, "127.0.0.2", ib["pem"], "PC de B")
    check("import PEM accepté", r.status_code == 200 and r.json()["empreinte"] == ib["empreinte"], r.text[:80])
    r = importer(B, "127.0.0.1", ia["publique"], "PC de A")
    check("import base64 brut accepté", r.status_code == 200 and r.json()["empreinte"] == ia["empreinte"])
    imp = A.get("/api/echanges").json()["importees"]
    check("clé importée listée avec son empreinte", imp.get("127.0.0.2", {}).get("empreinte") == ib["empreinte"])
    check("contact ajouté avec son nom", A.get("/api/contacts").json().get("127.0.0.2") == "PC de B"
          or "PC de B" in str(A.get("/api/contacts").json()))

    # --- message RSA direct A -> B, sans échange réseau
    secret = "Message RSA direct, sans mot de passe partagé"
    r = A.post("/api/envoyer", json={"ip": "127.0.0.2", "message": secret, "rsa_direct": True})
    check("envoi RSA direct accepté", r.status_code == 200, r.text[:80])
    chiffre = r.json().get("chiffre", "")
    check("le chiffré ne contient pas le texte", secret not in chiffre and base64.b64decode(chiffre)[0] == 5)
    recu = attendre(lambda: B.get("/api/recus").json()["messages"])
    check("B reçoit le message en v5", bool(recu) and recu[0]["v"] == 5)
    d = B.post("/api/dechiffrer", json={"id": recu[0]["id"]})
    check("B déchiffre avec sa clé privée, sans rien saisir", d.status_code == 200 and d.json()["clair"] == secret, d.text[:80])
    check("A ne peut pas relire son propre message v5",
          A.post("/api/dechiffrer", json={"crypte": chiffre}).status_code == 400)
    c = B.get("/api/conversation", params={"ip": "127.0.0.1"}).json()
    check("conversation de B : le message v5 est lisible", any(m["clair"] == secret for m in c["messages"]))
    check("accusé « remis » revenu chez A", bool(attendre(
        lambda: any(e["statut"] == "remis" for e in A.get("/api/historique").json()["entrees"]))))

    # --- sécurité : un message v5 modifié ou verrouillé n'est pas lu
    brut = bytearray(base64.b64decode(chiffre))
    brut[-1] ^= 1
    mauvais = base64.b64encode(bytes(brut)).decode()
    check("v5 modifié : déchiffrement refusé", B.post("/api/dechiffrer", json={"crypte": mauvais}).status_code == 400)
    check("v5 tronqué : format invalide", B.post("/api/dechiffrer", json={"crypte": base64.b64encode(b"\x05\x01\x80abc").decode()}).status_code == 400)
    B.post("/api/coffre/verrouiller")
    check("coffre verrouillé : v5 illisible (423)", B.post("/api/dechiffrer", json={"crypte": chiffre}).status_code == 423)
    B.post("/api/coffre/ouvrir", json={"mdp": MDP})

    # --- suppression d'une clé importée
    A.post("/api/cle-publique/supprimer", json={"ip": "127.0.0.2"})
    check("clé importée supprimée", "127.0.0.2" not in A.get("/api/echanges").json()["importees"])
finally:
    for p in (pa, pb):
        p.terminate()
        p.wait()
    shutil.rmtree(RACINE, ignore_errors=True)

print("TOUT OK" if ok_global else "DES ECHECS")
sys.exit(0 if ok_global else 1)
