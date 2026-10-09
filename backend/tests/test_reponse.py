"""Test des réponses à un message : deux instances échangent leurs clés, A écrit, B répond en citant, puis A relit.
Vérifie : la citation voyage dans le message chiffré (rien en clair dans l'historique stocké), le sens « moi » est correct des deux côtés,
la liste de messages ne montre jamais le marqueur brut, l'historique/Recevoir affiche une citation lisible.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_reponse.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

import httpx

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
S = tempfile.mkdtemp()
ok_global = True


def lancer(nom, web, hote):
    d = f"{S}/ap_{nom}"
    shutil.rmtree(d, ignore_errors=True)
    env = dict(os.environ, APPDATA=d, MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1")
    return subprocess.Popen([sys.executable, MAIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL), d


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


def attendre(f, delai=10):
    fin = time.time() + delai
    while time.time() < fin:
        try:
            r = f()
        except Exception:
            r = None
        if r:
            return r
        time.sleep(0.25)
    return None


pa, da = lancer("A", 8031, "127.0.0.1")
pb, db = lancer("B", 8032, "127.0.0.2")
time.sleep(4)
A = httpx.Client(base_url="http://127.0.0.1:8031", timeout=20)
B = httpx.Client(base_url="http://127.0.0.1:8032", timeout=20)
IPA, IPB = "127.0.0.1", "127.0.0.2"


def messages(X, *ips):
    """Sur un seul PC, A range les messages reçus de B sous 127.0.0.1 (voir test_jeu_prive) : on regroupe les deux fils."""
    tous = [m for ip in ips for m in X.get(f"/api/conversation?ip={ip}").json()["messages"]]
    return sorted(tous, key=lambda m: m["id"])


try:
    A.post("/api/coffre/creer", json={"mdp": "mdp-de-A-123"})
    B.post("/api/coffre/creer", json={"mdp": "mdp-de-B-456"})
    A.post("/api/echange/demarrer", json={"ip": IPB})
    attendre(lambda: B.get("/api/echanges").json()["demandes"])
    B.post("/api/echange/accepter", json={"ip": IPA})
    check("clés échangées", attendre(lambda: IPB in A.get("/api/echanges").json()["cles"] and IPA in B.get("/api/echanges").json()["cles"]))

    A.post("/api/envoyer", json={"ip": IPB, "message": "On se retrouve à quelle heure demain ?", "contact_cle": True})
    attendre(lambda: any(m["clair"] for m in messages(B, IPA)))
    # B répond en citant le message de A (le message cité est de A, donc « pas de moi » pour B)
    r = B.post("/api/envoyer", json={"ip": IPA, "message": "À 9 h devant l'école", "contact_cle": True,
                                    "reponse": {"s": 0, "x": "On se retrouve à quelle heure demain ?"}})
    check("réponse envoyée", r.status_code == 200, r.text[:80])
    ma = attendre(lambda: [m for m in messages(A, IPB, IPA) if m.get("rep")])
    check("A reçoit la réponse avec sa citation", bool(ma))
    if ma:
        m = ma[-1]
        check("texte de la réponse sans marqueur", m["clair"] == "À 9 h devant l'école", repr(m["clair"]))
        check("citation correcte", m["rep"]["x"] == "On se retrouve à quelle heure demain ?")
        check("côté A, le message cité est le sien (moi = vrai)", m["rep"]["moi"] is True)
    mb = [m for m in messages(B, IPA) if m.get("rep")]
    check("côté B, sa propre réponse cite l'autre (moi = faux)", bool(mb) and mb[-1]["rep"]["moi"] is False)
    check("aucun marqueur brut dans les textes", all("\x07" not in (m["clair"] or "") for m in messages(A, IPB, IPA) + messages(B, IPA)))

    # Rien en clair dans l'historique stocké
    brut = open(f"{da}/MessagerieChiffree/historique.json", encoding="utf-8").read() + open(f"{db}/MessagerieChiffree/historique.json", encoding="utf-8").read()
    check("citation absente du fichier d'historique", "quelle heure demain" not in brut and "devant l'école" not in brut)

    # Historique / Recevoir : citation lisible
    hist = A.get("/api/historique").json()["entrees"]
    recu = next((e for e in hist if e["sens"] == "recu" and e.get("pair") in (IPB, IPA)), None)
    if recu:
        d = A.post("/api/dechiffrer", json={"id": recu["id"], "cle": ""}).json()
        check("Historique affiche la citation lisible", "↩" in d["clair"] and "À 9 h" in d["clair"], d["clair"][:60])

    # Réponse refusée sans clé échangée : le champ est ignoré pour une clé saisie (message normal)
    r = A.post("/api/envoyer", json={"ip": IPB, "message": "texte simple", "cle": "cle-manuelle-1", "reponse": {"s": 1, "x": "x"}})
    check("clé saisie : réponse ignorée, message normal", r.status_code == 200)
finally:
    for p in (pa, pb):
        p.terminate()
    shutil.rmtree(S, ignore_errors=True)
print("\nTOUT EST OK" if ok_global else "\nDES TESTS ONT ÉCHOUÉ")
sys.exit(0 if ok_global else 1)
