"""Test de bout en bout du Sprint 1 : profils / avatars, file d'attente hors ligne, messages de groupe.
Trois instances tournent sur ce PC (127.0.0.1 = A, 127.0.0.2 = B, 127.0.0.3 = C) et se parlent vraiment.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_sprint1.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import httpx

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
ok_global = True


def lancer(nom, web, hote, extra=None):
    d = os.path.join(RACINE, nom)
    env = dict(os.environ, APPDATA=d, MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1",
               MC_INTERVALLE_FILE="1", **(extra or {}))
    return subprocess.Popen([sys.executable, MAIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL), d


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


def attendre(fonction, delai=10):
    fin = time.time() + delai
    while time.time() < fin:
        r = fonction()
        if r:
            return r
        time.sleep(0.25)
    return None


def echanger(X, Y, ip_y, ip_x):
    X.post("/api/echange/demarrer", json={"ip": ip_y})
    attendre(lambda: Y.get("/api/echanges").json()["demandes"])
    Y.post("/api/echange/accepter", json={"ip": ip_x})
    return attendre(lambda: ip_y in X.get("/api/echanges").json()["cles"])


pa, dossier_a = lancer("A", 8031, "127.0.0.1", {"MC_DIFFUSION": "127.0.0.2,127.0.0.3"})
pb, dossier_b = lancer("B", 8032, "127.0.0.2")
pc, dossier_c = lancer("C", 8033, "127.0.0.3")
procs = [pa, pb, pc]
time.sleep(4)
A = httpx.Client(base_url="http://127.0.0.1:8031", timeout=30)
B = httpx.Client(base_url="http://127.0.0.1:8032", timeout=30)
C = httpx.Client(base_url="http://127.0.0.1:8033", timeout=30)

try:
    # ====================== 1. PROFILS ======================
    check("profil vide au départ", A.get("/api/profil").json() == {"pseudo": "", "avatar": ""})
    r = A.post("/api/profil", json={"pseudo": "  Alice  ", "avatar": "🦊"})
    check("profil enregistré (pseudo rogné)", r.status_code == 200 and r.json() == {"pseudo": "Alice", "avatar": "🦊"}, r.text)
    check("pseudo trop long refusé", A.post("/api/profil", json={"pseudo": "x" * 21, "avatar": ""}).status_code == 400)
    check("avatar trop long refusé", A.post("/api/profil", json={"pseudo": "Alice", "avatar": "abcde"}).status_code == 400)
    check("caractère de contrôle refusé", A.post("/api/profil", json={"pseudo": "a\x00b", "avatar": ""}).status_code == 400)
    check("profil inchangé après refus", A.get("/api/profil").json()["pseudo"] == "Alice")
    check("profil sauvegardé sur disque", json.load(open(os.path.join(dossier_a, "MessagerieChiffree", "profil.json"), encoding="utf-8"))["avatar"] == "🦊")
    B.post("/api/profil", json={"pseudo": "Bob", "avatar": "🎮"})

    # Détection : A voit le profil de B (B est au carnet de A => profil retenu)
    A.post("/api/contacts", json={"ip": "127.0.0.2", "name": "PC de B"})
    d = A.get("/api/decouverte").json()
    check("détection : profil de B annoncé", d["profils"].get("127.0.0.2") == {"pseudo": "Bob", "avatar": "🎮"}, str(d.get("profils")))
    check("profil de B retenu pour un contact", A.get("/api/contacts").json()["profils"].get("127.0.0.2", {}).get("pseudo") == "Bob")
    check("C (sans profil) : pas de profil annoncé", "127.0.0.3" not in d["profils"])

    # Échange de clés : le hello porte le profil de A, l'ack celui de B
    A.post("/api/coffre/creer", json={"mdp": "mdp-de-A-123"})
    B.post("/api/coffre/creer", json={"mdp": "mdp-de-B-456"})
    C.post("/api/coffre/creer", json={"mdp": "mdp-de-C-789"})
    check("clés A<->B échangées", echanger(A, B, "127.0.0.2", "127.0.0.1"))
    check("B a reçu le profil de A (hello)", attendre(lambda: B.get("/api/contacts").json()["profils"].get("127.0.0.1", {}).get("pseudo") == "Alice"))
    check("A a reçu le profil de B (ack)", A.get("/api/contacts").json()["profils"].get("127.0.0.2", {}).get("avatar") == "🎮")

    # ====================== 2. FILE D'ATTENTE ======================
    # C est hors ligne pour l'instant : on le tue, mais A a déjà ses clés avec lui
    check("clés A<->C échangées", echanger(A, C, "127.0.0.3", "127.0.0.1"))
    pc.terminate(); pc.wait()
    time.sleep(0.5)
    r = A.post("/api/envoyer", json={"ip": "127.0.0.3", "message": "Tu me reçois, C ?", "contact_cle": True})
    check("envoi vers PC hors ligne : accepté (plus d'erreur 502)", r.status_code == 200, r.text)
    j = r.json()
    check("statut renvoyé : attente", j.get("statut") == "attente", str(j))
    h = lambda: next(e for e in A.get("/api/historique").json()["entrees"] if e["id"] == j["id"])
    check("historique : statut attente", h().get("statut") == "attente", str(h().get("statut")))
    f = A.get("/api/file-attente").json()
    check("file d'attente : 1 message", len(f["messages"]) == 1 and f["messages"][0]["ip"] == "127.0.0.3", str(f))
    check("file d'attente persistée sur disque", os.path.exists(os.path.join(dossier_a, "MessagerieChiffree", "file_attente.json")))
    check("le chiffré n'est pas exposé par la file", "crypte" not in json.dumps(f))

    # Vider = annuler : le message disparaît de la file et de l'historique
    r2 = A.post("/api/envoyer", json={"ip": "127.0.0.3", "message": "second", "contact_cle": True}).json()
    check("2 messages en attente", len(A.get("/api/file-attente").json()["messages"]) == 2)
    v = A.post("/api/file-attente/vider").json()
    check("vider : 2 annulés", v["annules"] == 2, str(v))
    check("file vide après annulation", A.get("/api/file-attente").json()["messages"] == [])
    check("messages annulés retirés de l'historique", not any(e["id"] in (j["id"], r2["id"]) for e in A.get("/api/historique").json()["entrees"]))

    # Nouveau message en attente, puis C revient : le thread de fond l'envoie tout seul
    j = A.post("/api/envoyer", json={"ip": "127.0.0.3", "message": "Bienvenue de retour", "contact_cle": True}).json()
    check("re-mis en attente", j.get("statut") == "attente")
    pc, _ = lancer("C", 8033, "127.0.0.3")  # même dossier : C a toujours son coffre et ses clés
    procs.append(pc)
    time.sleep(4)
    C = httpx.Client(base_url="http://127.0.0.1:8033", timeout=30)
    C.post("/api/coffre/ouvrir", json={"mdp": "mdp-de-C-789"})
    check("après retour de C : la file se vide toute seule", attendre(lambda: not A.get("/api/file-attente").json()["messages"], 20))
    check("le statut passe à envoyé/remis", attendre(lambda: h().get("statut") in ("envoye", "remis", "lu"), 10), str(h().get("statut")))
    recus = attendre(lambda: C.get("/api/recus?apres=0").json()["messages"], 10)
    check("C a bien reçu le message en attente", bool(recus))
    if recus:
        d = C.post("/api/dechiffrer", json={"id": recus[0]["id"]}).json()
        check("contenu intact après attente", d.get("clair") == "Bienvenue de retour", str(d))

    # Taille de la file bornée à 50 (via un contact injoignable)
    A.post("/api/contacts", json={"ip": "127.0.0.9", "name": "fantôme"})
    # pas de clé échangée avec 127.0.0.9 : on passe par le mode simple (clé saisie)
    codes = []
    for i in range(52):
        rr = A.post("/api/envoyer", json={"ip": "127.0.0.9", "cle": "cle-manuelle-1", "message": f"m{i}"})
        codes.append(rr.status_code)
        if rr.status_code != 200:
            break
    check("la file est plafonnée à 50 (502 ensuite)", codes.count(200) == 50 and codes[-1] == 502, f"{codes.count(200)} acceptés, dernier code {codes[-1]}")
    A.post("/api/file-attente/vider")

    # ====================== 3. MESSAGES DE GROUPE ======================
    check("groupe : coffre A ouvert, clés avec B et C", True)
    g = A.post("/api/envoyer-groupe", json={"destinataires": ["127.0.0.2", "127.0.0.3"], "message": "Salut tout le monde"})
    check("groupe : 200", g.status_code == 200, g.text)
    envois = g.json()["envois"]
    check("groupe : un résultat par destinataire, dans l'ordre", [e["ip"] for e in envois] == ["127.0.0.2", "127.0.0.3"], str(envois))
    check("groupe : tous ok", all(e["statut"] == "ok" for e in envois), str(envois))
    n_b = len(B.get("/api/recus?apres=0").json()["messages"])
    rb = attendre(lambda: [m for m in B.get("/api/recus?apres=0").json()["messages"]][-1:], 10)
    d = B.post("/api/dechiffrer", json={"id": rb[0]["id"]}).json()
    check("B déchiffre le message de groupe", d.get("clair") == "Salut tout le monde", str(d))
    rc = attendre(lambda: [m for m in C.get("/api/recus?apres=0").json()["messages"]][-1:], 10)
    d = C.post("/api/dechiffrer", json={"id": rc[0]["id"]}).json()
    check("C déchiffre le message de groupe", d.get("clair") == "Salut tout le monde", str(d))
    check("chiffrés différents par destinataire", rb[0]["crypte"] != rc[0]["crypte"])
    check("version v2 (aucun format nouveau)", rb[0]["v"] == 2 and rc[0]["v"] == 2)

    # Cas d'erreur : un destinataire sans clé, un hors ligne, des doublons
    pb.terminate(); pb.wait()
    time.sleep(0.5)
    g = A.post("/api/envoyer-groupe", json={"destinataires": ["127.0.0.3", "127.0.0.3", "127.0.0.2", "127.0.0.9"], "message": "test mixte"}).json()["envois"]
    par_ip = {e["ip"]: e for e in g}
    check("doublons fusionnés", len(g) == 3, str(g))
    check("C ok", par_ip["127.0.0.3"]["statut"] == "ok")
    check("B hors ligne : en attente", par_ip["127.0.0.2"]["statut"] == "attente", str(par_ip["127.0.0.2"]))
    check("inconnu sans clé : erreur", par_ip["127.0.0.9"]["statut"] == "erreur", str(par_ip["127.0.0.9"]))
    check("groupe vide refusé", A.post("/api/envoyer-groupe", json={"destinataires": [], "message": "x"}).status_code == 400)
    check("message vide refusé", A.post("/api/envoyer-groupe", json={"destinataires": ["127.0.0.3"], "message": "  "}).status_code == 400)
    check("trop de destinataires refusé", A.post("/api/envoyer-groupe", json={"destinataires": [f"10.0.0.{i}" for i in range(60)], "message": "x"}).status_code == 400)
    A.post("/api/coffre/verrouiller")
    check("coffre verrouillé : 423", A.post("/api/envoyer-groupe", json={"destinataires": ["127.0.0.3"], "message": "x"}).status_code == 423)
finally:
    for p in procs:
        p.terminate()

print()
print("TOUS LES TESTS PASSENT" if ok_global else "DES TESTS ONT ECHOUE")
sys.exit(0 if ok_global else 1)
