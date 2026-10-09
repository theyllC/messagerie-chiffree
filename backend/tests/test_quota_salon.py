"""Test du quota d'envois dans le salon, côté relais : 20 événements par membre et par 10 s.
Le relais est appelé en direct (sans réseau) et son horloge de quota est simulée.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_quota_salon.py
"""
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

os.environ["APPDATA"] = str(Path(tempfile.mkdtemp()) / "appdata")  # relais.py lit APPDATA à l'import
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import relais  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ok_global = True


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


CODE = "123456"
JETONS = {"alice": "jeton-alice", "bob": "jeton-bob"}
relais.salles[CODE] = {"nom": "Classe", "cree": "x", "epoque": 1, "salon": [], "salon_n": 0,
                       "membres": {m: {"pseudo": m, "avatar": "", "hash": relais.hash_jeton(j), "vu": 0, "role": "eleve"} for m, j in JETONS.items()}}
c = TestClient(relais.relais_app)
horloge = [1000.0]


def envoyer(qui, ttl=0):
    return c.post("/relais/salon/envoyer", json={"data": "AAAA", "epoque": 1, "ttl": ttl}, headers={"X-Relais-Token": JETONS[qui]})


with mock.patch.object(relais, "_maintenant_quota", lambda: horloge[0]):
    codes = [envoyer("alice").status_code for _ in range(relais.QUOTA_SALON)]
    check(f"les {relais.QUOTA_SALON} premiers envois passent", codes == [200] * relais.QUOTA_SALON, str(set(codes)))
    r = envoyer("alice")
    check("l'envoi suivant est refusé (429) avec un message clair et Retry-After", r.status_code == 429 and "attends 10 s" in r.json()["detail"] and r.headers["retry-after"] == "10", r.text[:120])
    check("les envois refusés ne sont pas publiés dans le salon", len(relais.salles[CODE]["salon"]) == relais.QUOTA_SALON)
    check("les envois refusés ne prolongent pas le blocage", [envoyer("alice").status_code for _ in range(5)] == [429] * 5)
    check("un autre membre n'est pas gêné (quota par membre)", envoyer("bob").status_code == 200)
    horloge[0] += relais.FENETRE_QUOTA - 1
    check("toujours bloqué juste avant la fin de la fenêtre", envoyer("alice").status_code == 429)
    horloge[0] += 1.5
    check("reprise dès que la fenêtre est écoulée", envoyer("alice").status_code == 200)
    horloge[0] += relais.FENETRE_QUOTA + 1
    check("fenêtre glissante : un rythme lent n'est jamais bloqué", all((horloge.__setitem__(0, horloge[0] + 1), envoyer("bob").status_code)[1] == 200 for _ in range(60)))
    # un membre retiré puis revenu repart de zéro
    for _ in range(relais.QUOTA_SALON):
        envoyer("alice")
    check("alice est de nouveau bloquée", envoyer("alice").status_code == 429)
    with relais.verrou:
        relais.retirer_membre(CODE, "alice")
    check("le compteur d'un membre retiré est effacé", (CODE, "alice") not in relais.envois_salon)
    r = envoyer("alice")
    check("un jeton retiré reste refusé (401), pas 429", r.status_code == 401)
    check("les erreurs de validation ne comptent pas dans le quota", c.post("/relais/salon/envoyer", json={"data": "", "epoque": 1}, headers={"X-Relais-Token": JETONS["bob"]}).status_code == 400)
    check("rien d'autre que /salon/envoyer n'est limité (lecture)", c.get("/relais/salon", headers={"X-Relais-Token": JETONS["bob"]}).status_code == 200)

print("\nTOUT EST OK" if ok_global else "\nIL Y A DES ECHECS")
sys.exit(0 if ok_global else 1)
