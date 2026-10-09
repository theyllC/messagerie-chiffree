"""Test de bout en bout : accusés de réception, anti-rejeu, pièces jointes, conversation, conservation.
Deux instances du programme tournent sur ce PC (127.0.0.1 et 127.0.0.2) et se parlent vraiment.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_accuses_fichiers.py
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta

import httpx

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
ok_global = True


def lancer(nom, web, hote, dossier=None):
    d = dossier or os.path.join(RACINE, nom)
    env = dict(os.environ, APPDATA=d, MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1")
    return subprocess.Popen([sys.executable, MAIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL), d


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


def attendre(fonction, delai=6):
    fin = time.time() + delai
    while time.time() < fin:
        r = fonction()
        if r:
            return r
        time.sleep(0.2)
    return None


def trame_brute(ip, octets):
    with socket.create_connection((ip, 5000), timeout=5) as s:
        s.sendall(octets)


def b64(octets):
    return base64.b64encode(octets).decode()


pa, dossier_a = lancer("A", 8001, "127.0.0.1")
pb, dossier_b = lancer("B", 8002, "127.0.0.2")
time.sleep(4)
A = httpx.Client(base_url="http://127.0.0.1:8001", timeout=30)
B = httpx.Client(base_url="http://127.0.0.1:8002", timeout=30)

try:
    # --- mise en place : coffres et clés échangées
    A.post("/api/coffre/creer", json={"mdp": "mdp-de-A-123"})
    B.post("/api/coffre/creer", json={"mdp": "mdp-de-B-456"})
    A.post("/api/echange/demarrer", json={"ip": "127.0.0.2"})
    attendre(lambda: B.get("/api/echanges").json()["demandes"])
    B.post("/api/echange/accepter", json={"ip": "127.0.0.1"})
    check("clés échangées", attendre(lambda: "127.0.0.2" in A.get("/api/echanges").json()["cles"]))

    def entree_a(identifiant):
        return next(e for e in A.get("/api/historique").json()["entrees"] if e["id"] == identifiant)

    # --- accusés de réception : envoyé -> remis -> lu
    r = A.post("/api/envoyer", json={"ip": "127.0.0.2", "message": "Bonjour B", "contact_cle": True}).json()
    check("l'envoi renvoie l'identifiant", "id" in r)
    check("statut 'remis' dès la réception", attendre(lambda: entree_a(r["id"]).get("statut") == "remis"), entree_a(r["id"]).get("statut"))
    recu = B.get("/api/recus?apres=0").json()["messages"][0]
    check("pas encore 'lu' avant déchiffrement", entree_a(r["id"]).get("statut") == "remis")
    d = B.post("/api/dechiffrer", json={"id": recu["id"]}).json()
    check("B déchiffre par identifiant", d.get("clair") == "Bonjour B", str(d))
    check("statut 'lu' après déchiffrement", attendre(lambda: entree_a(r["id"]).get("statut") == "lu"), entree_a(r["id"]).get("statut"))

    # --- faux accusé « lu » (MAC invalide) ignoré
    r2 = A.post("/api/envoyer", json={"ip": "127.0.0.2", "message": "Deuxième", "contact_cle": True}).json()
    attendre(lambda: entree_a(r2["id"]).get("statut") == "remis")
    h2 = entree_a(r2["id"])["h"]
    trame_brute("127.0.0.1", json.dumps({"t": "lu", "h": h2, "mac": "0" * 32}).encode())
    time.sleep(1)
    check("faux accusé 'lu' ignoré", entree_a(r2["id"]).get("statut") == "remis")

    # --- accusé « remis » signé : B coffre verrouillé -> pas d'accusé ; un faux accusé ne passe pas ; réouverture -> remis
    B.post("/api/coffre/verrouiller")
    r3 = A.post("/api/envoyer", json={"ip": "127.0.0.2", "message": "Troisième", "contact_cle": True}).json()
    time.sleep(1.5)
    h3 = entree_a(r3["id"])["h"]
    check("coffre de B verrouillé : pas encore 'remis'", entree_a(r3["id"]).get("statut") == "envoye", str(entree_a(r3["id"]).get("statut")))
    trame_brute("127.0.0.1", json.dumps({"t": "remis", "h": h3}).encode())
    trame_brute("127.0.0.1", json.dumps({"t": "remis", "h": h3, "mac": "0" * 32}).encode())
    time.sleep(0.8)
    check("faux accusé 'remis' (sans signature / MAC faux) ignoré", entree_a(r3["id"]).get("statut") == "envoye")
    B.post("/api/coffre/ouvrir", json={"mdp": "mdp-de-B-456"})
    check("accusé 'remis' signé envoyé à la réouverture", attendre(lambda: entree_a(r3["id"]).get("statut") == "remis"), str(entree_a(r3["id"]).get("statut")))

    # --- coffre verrouillé : l'accusé « lu » attend l'ouverture
    A.post("/api/coffre/verrouiller")
    recu2 = B.get("/api/recus?apres=0").json()["messages"][1]
    B.post("/api/dechiffrer", json={"id": recu2["id"]})
    time.sleep(1.5)
    A.post("/api/coffre/ouvrir", json={"mdp": "mdp-de-A-123"})
    check("accusé 'lu' validé après réouverture", attendre(lambda: entree_a(r2["id"]).get("statut") == "lu"))

    # --- s'écrire à soi-même (adresse 127.0.0.1) : le message doit arriver, une seule fois
    A.post("/api/envoyer", json={"ip": "127.0.0.1", "message": "Note à moi-même", "cle": "motdepasse123"})
    soi = attendre(lambda: [m for m in A.get("/api/recus?apres=0").json()["messages"] if m["pair"] == "127.0.0.1"])
    check("message envoyé à soi-même reçu", bool(soi))
    check("lisible avec la clé", bool(soi) and A.post("/api/dechiffrer", json={"id": soi[0]["id"], "cle": "motdepasse123"}).json().get("clair") == "Note à moi-même")
    capture_soi = next(e["crypte"] for e in A.get("/api/historique").json()["entrees"] if e["sens"] == "envoye" and e["pair"] == "127.0.0.1")
    trame_brute("127.0.0.1", capture_soi.encode())
    time.sleep(0.8)
    check("rejeu du message à soi-même ignoré", len([m for m in A.get("/api/recus?apres=0").json()["messages"] if m["pair"] == "127.0.0.1"]) == 1)

    # --- anti-rejeu : le même message capturé puis renvoyé n'est pas gardé deux fois
    avant = len(B.get("/api/recus?apres=0").json()["messages"])
    capture = A.get("/api/historique").json()["entrees"][0]["crypte"]
    trame_brute("127.0.0.2", capture.encode())
    trame_brute("127.0.0.2", capture.encode())
    time.sleep(1)
    check("rejeu ignoré", len(B.get("/api/recus?apres=0").json()["messages"]) == avant)

    # --- pièces jointes
    contenu = os.urandom(150 * 1024)
    r3 = A.post("/api/envoyer-fichier", json={"ip": "127.0.0.2", "nom_fichier": "..\\..\\dossier/ra<p>port.bin",
                                              "type": "application/octet-stream", "donnees": b64(contenu), "nom": "Bob"})
    check("envoi de fichier", r3.status_code == 200, r3.text[:80])
    mf = attendre(lambda: [m for m in B.get("/api/recus?apres=0").json()["messages"] if m["v"] == 3])
    check("B reçoit un message v3", bool(mf))
    mf = mf[0]
    check("gros message : contenu absent de la liste", mf["crypte"] == "" and mf.get("blob") is True)
    taille_historique = os.path.getsize(os.path.join(dossier_b, "MessagerieChiffree", "historique.json"))
    check("historique.json reste petit", taille_historique < 5000, f"{taille_historique} octets")
    check("fichier chiffré rangé à part", len(os.listdir(os.path.join(dossier_b, "MessagerieChiffree", "fichiers"))) == 1)
    f = B.post("/api/dechiffrer", json={"id": mf["id"]}).json().get("fichier", {})
    check("fichier identique après déchiffrement", base64.b64decode(f.get("donnees", "")) == contenu)
    check("nom nettoyé", f.get("nom") == "rapport.bin", f.get("nom"))
    check("statut 'lu' pour le fichier", attendre(lambda: entree_a(r3.json()["id"]).get("statut") == "lu"))
    check("fichier trop gros refusé",
          A.post("/api/envoyer-fichier", json={"ip": "127.0.0.2", "nom_fichier": "g.bin", "donnees": b64(os.urandom(2 * 1024 * 1024 + 1))}).status_code == 400)
    check("fichier sans clé échangée refusé",
          A.post("/api/envoyer-fichier", json={"ip": "127.0.0.9", "nom_fichier": "x.txt", "donnees": b64(b"x")}).status_code == 400)
    # --- fichier protégé par une clé saisie (v4) : aucun échange de clés nécessaire, vérifié aussi coffre de B verrouillé
    contenu = os.urandom(5000)
    B.post("/api/coffre/verrouiller")
    check("clé de fichier trop courte refusée",
          A.post("/api/envoyer-fichier", json={"ip": "127.0.0.2", "nom_fichier": "c.bin", "donnees": b64(contenu), "cle": "court"}).status_code == 400)
    r4 = A.post("/api/envoyer-fichier", json={"ip": "127.0.0.2", "nom_fichier": "../secret.bin", "donnees": b64(contenu), "cle": "mot-de-passe-fichier"})
    check("envoi d'un fichier avec clé saisie", r4.status_code == 200, r4.text)
    m4 = attendre(lambda: [m for m in B.get("/api/recus?apres=0").json()["messages"] if m["v"] == 4])
    check("B reçoit un message v4", bool(m4))
    check("v4 : mauvaise clé refusée", B.post("/api/dechiffrer", json={"id": m4[0]["id"], "cle": "mauvaise-cle-123"}).status_code == 400)
    check("v4 : clé absente refusée", B.post("/api/dechiffrer", json={"id": m4[0]["id"]}).status_code == 400)
    d4 = B.post("/api/dechiffrer", json={"id": m4[0]["id"], "cle": "mot-de-passe-fichier"}).json()
    check("v4 : fichier identique, coffre verrouillé", d4.get("fichier", {}).get("donnees") == b64(contenu))
    check("v4 : nom nettoyé", d4.get("fichier", {}).get("nom") == "secret.bin")
    check("v4 : statut 'remis' (accusé non signé, pas de clé partagée)", attendre(lambda: entree_a(r4.json()["id"]).get("statut") == "remis"))
    B.post("/api/coffre/ouvrir", json={"mdp": "mdp-de-B-456"})
    check("déchiffrer un id inconnu", B.post("/api/dechiffrer", json={"id": 99999}).status_code == 404)

    # --- conversation
    conv = B.get("/api/conversation?ip=127.0.0.1").json()
    textes = [m["clair"] for m in conv["messages"] if m["v"] == 2]
    check("conversation : textes lisibles", textes == ["Bonjour B", "Deuxième", "Troisième"], str(textes))
    check("conversation : fichier listé sans contenu", any(m["v"] == 3 and m["clair"] is None and m["taille"] > 100000 for m in conv["messages"]))

    # --- réglage de conservation
    check("conservation : valeur enregistrée", A.post("/api/parametres", json={"retention_jours": 7}).json()["retention_jours"] == 7)
    check("conservation : valeur absurde refusée", A.post("/api/parametres", json={"retention_jours": 9999}).status_code == 400)

    # --- vider l'historique supprime aussi les fichiers
    B.delete("/api/historique")
    check("fichiers supprimés avec l'historique", not os.listdir(os.path.join(dossier_b, "MessagerieChiffree", "fichiers")))
finally:
    for p in (pa, pb):
        p.terminate()
        p.wait()

# --- purge automatique : un vieux message et son fichier disparaissent au démarrage
try:
    dossier_c = os.path.join(RACINE, "C")
    sous = os.path.join(dossier_c, "MessagerieChiffree")
    os.makedirs(os.path.join(sous, "fichiers"))
    vieux, recent = (datetime.now() - timedelta(days=40)).isoformat(timespec="seconds"), datetime.now().isoformat(timespec="seconds")
    base = {"sens": "recu", "pair": "1.2.3.4", "crypte": ""}
    json.dump([{**base, "id": 1, "heure": vieux, "h": "a" * 16, "blob": True}, {**base, "id": 2, "heure": recent, "h": "b" * 16, "blob": True}],
              open(os.path.join(sous, "historique.json"), "w"))
    json.dump({"retention_jours": 30}, open(os.path.join(sous, "parametres.json"), "w"))
    for h in ("a" * 16, "b" * 16):
        open(os.path.join(sous, "fichiers", f"{h}.txt"), "w").write("x")
    pc, _ = lancer("C", 8003, "127.0.0.3", dossier_c)
    time.sleep(3)
    ids = [e["id"] for e in httpx.get("http://127.0.0.1:8003/api/historique", timeout=10).json()["entrees"]]
    check("purge : seul le message récent reste", ids == [2], str(ids))
    check("purge : fichier du vieux message supprimé", os.listdir(os.path.join(sous, "fichiers")) == ["b" * 16 + ".txt"])
    pc.terminate()
    pc.wait()
finally:
    shutil.rmtree(RACINE, ignore_errors=True)

print("TOUT OK" if ok_global else "DES ECHECS")
sys.exit(0 if ok_global else 1)
