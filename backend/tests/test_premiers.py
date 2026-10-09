"""Test : clé RSA créée à partir de deux nombres premiers choisis (refus des petits nombres, des composés, du mauvais mot de passe).
Lancer : python backend/tests/test_premiers.py
"""
import os, shutil, subprocess, sys, tempfile, time
import httpx

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
MDP = "mot-de-passe-test"
ok_global = True


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


env = dict(os.environ, APPDATA=RACINE, MC_PORT_WEB="8041", MC_HOTE="127.0.0.1", MC_SANS_NAVIGATEUR="1")
proc = subprocess.Popen([sys.executable, MAIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)
C = httpx.Client(base_url="http://127.0.0.1:8041", timeout=120)
try:
    C.post("/api/coffre/creer", json={"mdp": MDP})
    avant = C.get("/api/identite").json()

    def creer(p, q, mdp=MDP):
        return C.post("/api/identite/depuis-premiers", json={"p": str(p), "q": str(q), "mdp": mdp})

    check("petits premiers refusés", creer(61, 53).status_code == 400)
    check("texte refusé", creer("abc", "12").status_code == 400)
    pr = C.post("/api/premiers/aleatoires").json()
    p, q = int(pr["p"]), int(pr["q"])
    check("premiers aléatoires : 1536 bits", p.bit_length() == 1536 and q.bit_length() == 1536)
    check("p == q refusé", creer(p, p).status_code == 400)
    check("composé refusé", creer(p + 1, q).status_code == 400)
    check("mauvais mot de passe refusé", creer(p, q, "mauvais-mdp-xx").status_code == 400)
    check("la clé n'a pas changé après les refus", C.get("/api/identite").json()["empreinte"] == avant["empreinte"])
    r = creer(p, q)
    check("p et q valides acceptés", r.status_code == 200, r.text[:120])
    apres = C.get("/api/identite").json()
    check("nouvelle clé : empreinte changée, 3072 bits", apres["empreinte"] != avant["empreinte"] and apres["bits"] == 3072)
    check("api/echanges.moi suit la nouvelle empreinte", C.get("/api/echanges").json()["moi"] == apres["empreinte"])
    # la nouvelle clé fonctionne : RSA direct vers soi-même (importer sa propre clé est refusé), donc on vérifie la clé privée
    pem = C.post("/api/identite/privee", json={"mdp": MDP}).json()["pem"]
    from cryptography.hazmat.primitives import serialization
    n = serialization.load_pem_private_key(pem.encode(), password=None).private_numbers()
    check("la clé privée stockée est bien (p, q)", {n.p, n.q} == {p, q})
finally:
    proc.terminate()
    shutil.rmtree(RACINE, ignore_errors=True)
print("TOUT OK" if ok_global else "DES ECHECS")
sys.exit(0 if ok_global else 1)
