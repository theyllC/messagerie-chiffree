"""Test du salon commun chiffré de la salle de classe : un relais, un créateur (P), des élèves (A, B, C).
Vérifie : chiffrement de bout en bout (le relais ne lit rien), rôles et droits (créateur / admin / élève), réponses, suppression,
renouvellement de la clé quand on retire un membre, arrivée tardive, verrouillage du coffre.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_salon.py
"""
import os
import subprocess
import sys
import tempfile
import time

import httpx

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
CODE = "515151"
URL_RELAIS = "http://127.0.0.1:8110"
MDP = "mot-de-passe-123"
ok_global = True


def lancer(nom, web, args=()):
    env = dict(os.environ, APPDATA=os.path.join(RACINE, nom), MC_PORT_WEB=str(web), MC_HOTE="127.0.0.1", MC_SANS_NAVIGATEUR="1",
               MC_INTERVALLE_RELAIS="0.4", MC_INTERVALLE_SALON="0.6", MC_INTERVALLE_FILE="1", MC_PORT_RELAIS="8110", MC_CODE_SALLE=CODE,
               MC_HOTE_RELAIS="127.0.0.1", MC_PORT_SOCKET=str(5200 + web % 100), MC_PORT_UDP=str(5300 + web % 100))
    return subprocess.Popen([sys.executable, MAIN, *args], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


def attendre(f, delai=15):
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


procs = {"R": lancer("R", 8191, ["--relais"]), "P": lancer("P", 8192), "A": lancer("A", 8193), "B": lancer("B", 8194), "C": lancer("C", 8195)}
time.sleep(4)
R = httpx.Client(base_url=URL_RELAIS, timeout=30)
P, A, B, C = (httpx.Client(base_url=f"http://127.0.0.1:{p}", timeout=60) for p in (8192, 8193, 8194, 8195))


def salon(X, apres=0):
    return X.get(f"/api/relais/salon?apres={apres}").json()


def textes(X):
    return {m["n"]: m for m in salon(X)["messages"]}


def cle_ok(X, epoque=None):
    d = salon(X)
    return d if d["etat_cle"] == "ok" and (epoque is None or d["epoque"] == epoque) else None


def mon_id(X):
    return X.get("/api/relais").json()["id"]


try:
    check("sans jeton : routes du salon refusées", all(R.request(m, u, **k).status_code == 401 for m, u, k in [
        ("GET", "/relais/salon", {}), ("POST", "/relais/salon/envoyer", {"json": {"data": "x", "epoque": 1}}),
        ("GET", "/relais/salon/cles", {}), ("POST", "/relais/salon/role", {"json": {"id": "x", "role": "admin"}})]))
    check("client sans salle : 400", A.get("/api/relais/salon").status_code == 400)

    # ------------------------------------------------------------------ rejoindre (le créateur d'abord) + coffres
    for X, nom in ((P, "Prof"), (A, "Alice"), (B, "Bob")):
        X.post("/api/profil", json={"pseudo": nom, "avatar": ""})
        X.post("/api/coffre/creer", json={"mdp": MDP})
        check(f"{nom} rejoint la salle", X.post("/api/relais/rejoindre", json={"url": URL_RELAIS, "code": CODE}).status_code == 200)
    ann = attendre(lambda: (lambda d: d if len(d["membres"]) == 2 else None)(P.get("/api/relais/annuaire").json()))
    id_p, id_a, id_b = mon_id(P), mon_id(A), mon_id(B)
    check("le premier à rejoindre depuis le PC du relais est le créateur", ann and ann["moi_role"] == "createur", str(ann and ann["moi_role"]))
    check("les suivants sont élèves", ann and {m["id"]: m["role"] for m in ann["membres"]} == {id_a: "eleve", id_b: "eleve"})
    check("l'élève voit le créateur dans l'annuaire", attendre(lambda: {m["id"]: m["role"] for m in A.get("/api/relais/annuaire").json()["membres"]}.get(id_p) == "createur"))

    # ------------------------------------------------------------------ clés distribuées automatiquement
    check("le créateur obtient la clé du salon (époque 1)", attendre(lambda: cle_ok(P, 1)))
    check("Alice reçoit la clé sans rien faire", attendre(lambda: cle_ok(A, 1)))
    check("Bob reçoit la clé sans rien faire", attendre(lambda: cle_ok(B, 1)))

    # ------------------------------------------------------------------ messages, réponses
    check("message vide refusé", A.post("/api/relais/salon", json={"texte": "  "}).status_code == 400)
    check("message trop long refusé", A.post("/api/relais/salon", json={"texte": "a" * 1001}).status_code == 400)
    P.post("/api/relais/salon", json={"texte": "Bienvenue, ouvrez le TP 3"})
    na = A.post("/api/relais/salon", json={"texte": "Bonjour la classe <b>é</b>"}).json()["n"]
    nb = B.post("/api/relais/salon", json={"texte": "Moi aussi !", "reponse_a": {"n": na, "p": "Alice", "x": "Bonjour la classe"}}).json()["n"]
    for X, nom in ((P, "prof"), (A, "Alice"), (B, "Bob")):
        d = attendre(lambda: (lambda d: d if len(d["messages"]) == 3 else None)(salon(X)))
        ms = {m["texte"]: m for m in d["messages"]} if d else {}
        check(f"{nom} lit les 3 messages", set(ms) == {"Bienvenue, ouvrez le TP 3", "Bonjour la classe <b>é</b>", "Moi aussi !"}, str(list(ms)))
        check(f"{nom} : un seul message est « moi »", d and sum(m["moi"] for m in d["messages"]) == 1)
    d = salon(P)
    rep = next(m for m in d["messages"] if m["texte"] == "Moi aussi !")
    check("la réponse porte la citation (n, auteur, extrait)", rep.get("rep") == {"n": na, "p": "Alice", "x": "Bonjour la classe"}, str(rep.get("rep")))
    check("le pseudo vient de l'annuaire", {m["pseudo"] for m in d["messages"]} == {"Prof", "Alice", "Bob"})
    check("rôle de l'auteur fourni (créateur)", next(m for m in d["messages"] if m["texte"].startswith("Bienvenue"))["role"] == "createur")
    check("lecture incrémentale", salon(A, nb)["messages"] == [])

    # ------------------------------------------------------------------ le relais ne lit rien
    time.sleep(6.5)  # le relais écrit son état sur disque toutes les 5 s
    chemin = os.path.join(RACINE, "R", "MessagerieChiffree", "relais", "etat.json")
    brut = open(chemin, encoding="utf-8").read() if os.path.exists(chemin) else ""
    check("état du relais écrit sur disque", "salon" in brut and "cles" in brut)
    check("le relais n'a aucun texte en clair (messages, citation, pseudo cité)", not any(x in brut for x in ("Bienvenue", "Bonjour la classe", "Moi aussi", "TP 3")))

    # ------------------------------------------------------------------ suppression
    check("un élève ne supprime pas le message d'un autre", B.post("/api/relais/salon/supprimer", json={"n": 1}).status_code == 403)
    check("un auteur supprime son message", A.post("/api/relais/salon/supprimer", json={"n": na}).status_code == 200)
    d = attendre(lambda: (lambda d: d if na in d["supprimes"] else None)(salon(B)))
    check("les autres voient qu'il est supprimé (et plus son contenu)", d and all(m["n"] != na for m in d["messages"]))
    check("le créateur supprime le message d'un élève", P.post("/api/relais/salon/supprimer", json={"n": nb}).status_code == 200)

    # ------------------------------------------------------------------ rôles
    check("un élève ne nomme pas d'admin", B.post("/api/relais/salon/role", json={"id": id_a, "role": "admin"}).status_code == 403)
    check("un élève ne retire personne", B.post("/api/relais/salon/retirer", json={"id": id_a}).status_code == 403)
    check("le créateur nomme Alice admin", P.post("/api/relais/salon/role", json={"id": id_a, "role": "admin"}).status_code == 200)
    check("Alice se voit admin", attendre(lambda: salon(A)["moi_role"] == "admin"))
    check("un admin ne nomme pas d'autre admin", A.post("/api/relais/salon/role", json={"id": id_b, "role": "admin"}).status_code == 403)
    check("un admin ne retire pas le créateur", A.post("/api/relais/salon/retirer", json={"id": id_p}).status_code == 403)
    check("le créateur ne peut pas se rétrograder", P.post("/api/relais/salon/role", json={"id": id_p, "role": "eleve"}).status_code == 400)
    check("l'admin supprime le message d'un autre", P.post("/api/relais/salon", json={"texte": "à effacer"}).status_code == 200
          and A.post("/api/relais/salon/supprimer", json={"n": max(m["n"] for m in salon(A)["messages"])}).status_code == 200)

    # ------------------------------------------------------------------ retrait → nouvelle clé
    check("l'admin retire Bob de la salle", A.post("/api/relais/salon/retirer", json={"id": id_b}).status_code == 200)
    check("Bob n'a plus accès au salon", B.get("/api/relais/salon").status_code in (400, 502))
    check("la clé est renouvelée (époque 2) côté créateur", attendre(lambda: cle_ok(P, 2)))
    check("la clé est renouvelée (époque 2) côté admin", attendre(lambda: cle_ok(A, 2)))
    A.post("/api/relais/salon", json={"texte": "Message après le départ de Bob"})
    d = attendre(lambda: (lambda d: d if any(m.get("texte") == "Message après le départ de Bob" for m in d["messages"]) else None)(salon(P)))
    check("le créateur lit un message de la nouvelle époque", bool(d))
    check("le créateur relit toujours les anciens (époque 1)", d and any(m.get("texte") == "Bienvenue, ouvrez le TP 3" for m in d["messages"]))

    # ------------------------------------------------------------------ arrivée tardive : pas d'accès à l'historique
    C.post("/api/profil", json={"pseudo": "Carla", "avatar": ""})
    C.post("/api/coffre/creer", json={"mdp": MDP})
    check("Carla rejoint après le renouvellement", C.post("/api/relais/rejoindre", json={"url": URL_RELAIS, "code": CODE}).status_code == 200)
    check("Carla reçoit la clé courante (époque 2)", attendre(lambda: cle_ok(C, 2)))
    dc = salon(C)
    etats = {m["etat"] for m in dc["messages"]}
    check("Carla lit le nouveau message mais pas l'historique d'avant son arrivée", "ok" in etats and "sans_cle" in etats, str(etats))
    check("Carla reste simple élève", C.get("/api/relais/annuaire").json()["moi_role"] == "eleve")

    # ------------------------------------------------------------------ coffre verrouillé
    A.post("/api/coffre/verrouiller")
    d = salon(A)
    check("coffre verrouillé : le salon l'indique", d["etat_cle"] == "coffre_verrouille")
    check("coffre verrouillé : aucun texte lisible", all(m["etat"] == "verrouille" and "texte" not in m for m in d["messages"]))
    check("coffre verrouillé : envoi refusé", A.post("/api/relais/salon", json={"texte": "x"}).status_code == 423)
    A.post("/api/coffre/ouvrir", json={"mdp": MDP})
    check("coffre rouvert : le salon redevient lisible", attendre(lambda: cle_ok(A, 2)))
    check("coffre rouvert : l'historique ancien aussi", attendre(lambda: any(m.get("texte") == "Bienvenue, ouvrez le TP 3" for m in salon(A)["messages"])))
finally:
    for p in procs.values():
        p.terminate()
print("\nTOUT EST OK" if ok_global else "\nIL Y A DES ECHECS")
sys.exit(0 if ok_global else 1)
