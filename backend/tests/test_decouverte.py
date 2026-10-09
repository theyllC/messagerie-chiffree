"""Test : détection des PC par diffusion UDP (deux instances sur 127.0.0.1 et 127.0.0.2).
Lancer : python backend/tests/test_decouverte.py   (prérequis : pip install httpx)
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import httpx

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
ok_global = True


def lancer(nom, web, hote, extra=None):
    env = dict(os.environ, APPDATA=os.path.join(RACINE, nom), MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1", **(extra or {}))
    return subprocess.Popen([sys.executable, MAIN], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


pa = lancer("A", 8021, "127.0.0.1", {"MC_DIFFUSION": "127.0.0.2"})  # A sonde aussi 127.0.0.2 (pas de vrai réseau ici)
pb = lancer("B", 8022, "127.0.0.2")
time.sleep(4)
A = httpx.Client(base_url="http://127.0.0.1:8021", timeout=30)
try:
    t0 = time.time()
    r = A.get("/api/decouverte").json()
    check("B détecté par diffusion", "127.0.0.2" in r["voisins"], str(r))
    check("méthode : diffusion", r["methode"] == "diffusion")
    check("nom de l'ordinateur renvoyé", bool(r["noms"].get("127.0.0.2")), r["noms"].get("127.0.0.2"))
    check("rapide (moins de 3 s)", time.time() - t0 < 3, f"{time.time() - t0:.2f} s")
    check("A ne se détecte pas lui-même", "127.0.0.1" not in r["voisins"])

    # une réponse avec un mauvais jeton, ou envoyée sans sonde, ne doit rien changer ; un paquet de bruit ne plante rien
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as u:
        u.sendto(b"\xff\x00n'importe quoi", ("127.0.0.2", 5001))
        u.sendto(json.dumps({"t": "mc-qui", "r": "x" * 500}).encode(), ("127.0.0.2", 5001))
        u.settimeout(1)
        try:
            u.recvfrom(512)
            repondu = True
        except socket.timeout:
            repondu = False
    check("bruit et jeton trop long : pas de réponse", not repondu)
    check("B répond toujours après le bruit", "127.0.0.2" in A.get("/api/decouverte").json()["voisins"])

    # PC injoignable en TCP (B arrêté mais jamais en UDP) : rien d'affiché
    pb.terminate(); pb.wait()
    time.sleep(0.5)
    r2 = A.get("/api/decouverte").json()
    check("B arrêté : plus détecté", "127.0.0.2" not in r2["voisins"], str(r2))
finally:
    for p in (pa, pb):
        p.terminate()
        p.wait()
    shutil.rmtree(RACINE, ignore_errors=True)
print("TOUT OK" if ok_global else "DES ECHECS")
sys.exit(0 if ok_global else 1)
