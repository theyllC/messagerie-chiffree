"""Test du marqueur de jeu privé \\x07JEU: à la RÉCEPTION : un message mal formé qui commence par ce marqueur ne doit pas disparaître.
Un contact malveillant n'est pas obligé d'utiliser cette application : il peut chiffrer lui-même n'importe quel texte. On simule donc
des messages reçus (déchiffrement remplacé) et on appelle les routes /api/conversation et /api/dechiffrer.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_marqueur_jeu.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

os.environ["APPDATA"] = str(Path(tempfile.mkdtemp()) / "appdata")  # main.py lit APPDATA à l'import
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ok_global = True


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


P = main.PREFIXE_JEU
valide = P + json.dumps({"j": "morpion", "a": "defi", "g": "abcd1234"}, separators=(",", ":"))
CAS = {  # texte reçu -> (coup de jeu ?, texte affiché)
    "valide": (valide, True, None),
    "json cassé": (P + '{"j": "morpion", "a": ', False, 'JEU:{"j": "morpion", "a": '),
    "pas du json": (P + "salut", False, "JEU:salut"),
    "json valide mais pas un jeu": (P + '{"x": 1}', False, 'JEU:{"x": 1}'),
    "jeu inconnu": (P + json.dumps({"j": "echecs", "a": "defi", "g": "abcd1234"}), False, 'JEU:{"j": "echecs", "a": "defi", "g": "abcd1234"}'),
    "texte ordinaire": ("bonjour", False, "bonjour"),
}

check("evenement_jeu : coup valide reconnu", isinstance(main.evenement_jeu(valide), dict))
check("evenement_jeu : texte ordinaire / None -> None", main.evenement_jeu("bonjour") is None and main.evenement_jeu(None) is None)
for nom, (texte, est_jeu, _) in CAS.items():
    check(f"evenement_jeu : {nom}", bool(main.evenement_jeu(texte)) == est_jeu)

client = TestClient(main.app)
IP = "10.9.9.9"
main.coffre["donnees"] = {"cles": {}}  # coffre « ouvert »
main.historique[:] = [
    {"id": i + 1, "pair": IP, "sens": "recu", "heure": "10:00", "crypte": "AA", "v": 2, "statut": "ok"} for i in range(len(CAS))
]
textes = [t for t, _, _ in CAS.values()]
with mock.patch.object(main, "dechiffrer", side_effect=lambda crypte, cle, _it=iter(textes): next(_it)), mock.patch.object(main, "signaler_lu"):
    r = client.get(f"/api/conversation?ip={IP}").json()
visibles = [m["clair"] for m in r["messages"]]
attendus = [aff for (_, est_jeu, aff) in CAS.values() if not est_jeu]
check("conversation : les messages mal formés restent visibles, dans l'ordre", visibles == attendus, str(visibles))
check("conversation : seul le coup valide devient un événement de jeu", [j["a"] for j in r["jeux"]] == ["defi"] and len(r["jeux"]) == 1)
check("conversation : aucun caractère de contrôle affiché", all("\x07" not in (c or "") for c in visibles))

# /api/dechiffrer : un message mal formé n'est pas annoncé « Coup de jeu »
def dechiffre(texte):
    with mock.patch.object(main, "dechiffrer", return_value=texte), mock.patch.object(main, "decoder", return_value=bytes([2]) + b"\0" * 40):
        return client.post("/api/dechiffrer", json={"crypte": "AA", "cle": ""})

r1, r2 = dechiffre(valide), dechiffre(P + "salut")
check("dechiffrer : coup valide -> libellé « Coup de jeu »", r1.status_code == 200 and "Coup de jeu" in r1.json()["clair"], r1.text[:120])
check("dechiffrer : message mal formé -> affiché tel quel", r2.status_code == 200 and r2.json()["clair"] == "JEU:salut", r2.text[:120])

print("\nTOUT EST OK" if ok_global else "\nIL Y A DES ECHECS")
sys.exit(0 if ok_global else 1)
