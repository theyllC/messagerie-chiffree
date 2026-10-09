"""Test RSA : migration d'un coffre de l'ancien format (X25519), renouvellement des clés sans perdre les
anciens messages, et rejet des trames d'échange falsifiées ou trop faibles.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_rsa.py
"""
import base64
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "main.py")
RACINE = tempfile.mkdtemp()
ok_global = True
b64 = lambda o: base64.b64encode(o).decode()  # noqa: E731


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


def trame(ip, donnees):
    with socket.create_connection((ip, 5000), timeout=5) as s:
        s.sendall(json.dumps(donnees).encode())


def der_pub(cle):
    return cle.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)


PSS = padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH)


def hello(cle, jeton="abcd", signature_ok=True):
    pub = der_pub(cle)
    sig = cle.sign(b"hello-v1|" + jeton.encode() + b"|" + pub, PSS, hashes.SHA256())
    if not signature_ok:
        sig = bytes([sig[0] ^ 1]) + sig[1:]
    return {"t": "hello", "pub": b64(pub), "r": jeton, "sig": b64(sig)}


# --- coffre de l'ancien format, avec une clé de contact et un message déjà reçu
dossier_l = os.path.join(RACINE, "L")
sous_l = os.path.join(dossier_l, "MessagerieChiffree")
os.makedirs(sous_l)
vieux_mdp = "ancien-mdp-123"
vieille_cle = os.urandom(32)
mon_x, ton_x = os.urandom(32), os.urandom(32)  # « clés publiques » X25519 brutes (seules leurs octets comptent ici)
donnees = {"prive": b64(os.urandom(32)), "publique": b64(mon_x),
           "cles": {"127.0.0.2": {"cle": b64(vieille_cle), "pub": b64(ton_x), "verifie": True, "date": "2026-10-01T10:00:00"}}}
sel = os.urandom(16)
cle_coffre = Scrypt(salt=sel, length=32, n=2**15, r=8, p=1).derive(vieux_mdp.encode())
nonce = os.urandom(12)
json.dump({"v": 1, "sel": b64(sel), "nonce": b64(nonce),
           "data": b64(AESGCM(cle_coffre).encrypt(nonce, json.dumps(donnees).encode(), b"coffre-v1"))},
          open(os.path.join(sous_l, "coffre.json"), "w"))
kid, n2 = hashlib.sha256(b"id" + vieille_cle).digest()[:8], os.urandom(12)
vieux_message = b64(b"\x02" + kid + n2 + AESGCM(vieille_cle).encrypt(n2, "Message d'avant la migration".encode(), b"v2" + kid))
json.dump([{"id": 1, "sens": "recu", "crypte": vieux_message, "pair": "127.0.0.2", "heure": "2026-10-01T10:05:00"}],
          open(os.path.join(sous_l, "historique.json"), "w"))
json.dump({"demandes": {"10.0.0.5": {"pub": b64(os.urandom(32)), "r": "xx", "heure": "2026-10-01T10:06:00"}},
           "sortants": {}, "acks": {"tok": b64(os.urandom(32))}}, open(os.path.join(sous_l, "echanges.json"), "w"))
code_attendu = " ".join(str(int.from_bytes(h[i * 4:i * 4 + 4], "big") % 100000).zfill(5)
                        for h in [hashlib.sha256(b"".join(sorted([mon_x, ton_x]))).digest()] for i in range(6))

pl = lancer(dossier_l, 8011, "127.0.0.1")
pp = lancer(os.path.join(RACINE, "P"), 8012, "127.0.0.2")
time.sleep(4)
L = httpx.Client(base_url="http://127.0.0.1:8011", timeout=60)
P = httpx.Client(base_url="http://127.0.0.1:8012", timeout=60)

try:
    # --- migration
    check("coffre ancien format détecté", L.get("/api/echanges").json()["etat"] == "verrouille")
    check("anciennes demandes X25519 écartées", L.get("/api/echanges").json()["demandes"] == [])
    check("mauvais mot de passe refusé", L.post("/api/coffre/ouvrir", json={"mdp": "faux-faux-faux"}).status_code == 400)
    t0 = time.time()
    check("ouverture + migration", L.post("/api/coffre/ouvrir", json={"mdp": vieux_mdp}).status_code == 200, f"{time.time() - t0:.1f} s")
    cles = L.get("/api/echanges").json()["cles"]
    check("ancienne clé conservée, marquée X25519", cles.get("127.0.0.2", {}).get("algo") == "x25519", str(cles))
    check("code de sécurité d'origine conservé", cles["127.0.0.2"]["code"] == code_attendu)
    check("clé vérifiée restée vérifiée", cles["127.0.0.2"]["verifie"] is True)
    d = L.post("/api/dechiffrer", json={"id": 1}).json()
    check("ancien message encore lisible", d.get("clair") == "Message d'avant la migration", str(d))
    # le fichier du coffre ne contient plus d'identité X25519, mais une identité RSA
    brut = json.load(open(os.path.join(sous_l, "coffre.json")))
    contenu = json.loads(AESGCM(cle_coffre).decrypt(base64.b64decode(brut["nonce"]), base64.b64decode(brut["data"]), b"coffre-v1"))
    check("coffre réécrit avec une identité RSA", "rsa_prive" in contenu and "prive" not in contenu and "publique" not in contenu)
    L.post("/api/coffre/verrouiller")
    check("réouverture sans nouvelle migration", L.post("/api/coffre/ouvrir", json={"mdp": vieux_mdp}).status_code == 200)

    # --- « mes clés » : la clé publique et son empreinte, jamais la clé privée
    idt = L.get("/api/identite")
    check("identité : clé RSA-3072 publique", idt.status_code == 200 and idt.json()["bits"] == 3072, idt.text[:80])
    check("identité : aucune clé privée dans la réponse", "rsa_prive" not in idt.text and contenu["rsa_prive"] not in idt.text)
    check("identité : empreinte de 8 groupes", len(idt.json()["empreinte"].split()) == 8)
    L.post("/api/coffre/verrouiller")
    check("identité : coffre verrouillé -> 423", L.get("/api/identite").status_code == 423)
    L.post("/api/coffre/ouvrir", json={"mdp": vieux_mdp})
    check("identité : empreinte stable", L.get("/api/identite").json()["empreinte"] == idt.json()["empreinte"])

    # --- renouvellement : la nouvelle clé RSA remplace l'ancienne, l'ancienne reste utilisable pour lire
    P.post("/api/coffre/creer", json={"mdp": "mdp-de-P-456"})
    check("demande de passage au RSA", L.post("/api/echange/demarrer", json={"ip": "127.0.0.2"}).status_code == 200)
    attendre(lambda: P.get("/api/echanges").json()["demandes"])
    check("P accepte", P.post("/api/echange/accepter", json={"ip": "127.0.0.1"}).status_code == 200)
    cles = attendre(lambda: (lambda c: c if c.get("127.0.0.2", {}).get("algo") == "rsa" else None)(L.get("/api/echanges").json()["cles"]))
    check("clé remplacée par une clé RSA", bool(cles))
    ep = P.get("/api/echanges").json()["cles"]["127.0.0.1"]
    check("même code de sécurité des deux côtés", cles["127.0.0.2"]["code"] == ep["code"], ep["code"])
    check("nouvelle clé à vérifier", cles["127.0.0.2"]["verifie"] is False)
    check("ancien message toujours lisible après renouvellement",
          L.post("/api/dechiffrer", json={"id": 1}).json().get("clair") == "Message d'avant la migration")
    L.post("/api/envoyer", json={"ip": "127.0.0.2", "message": "Après la migration", "contact_cle": True})
    m = attendre(lambda: P.get("/api/recus?apres=0").json()["messages"])
    check("message envoyé avec la clé RSA lu par P", m and P.post("/api/dechiffrer", json={"id": m[0]["id"]}).json().get("clair") == "Après la migration")
    taille = len(json.dumps(hello(rsa.generate_private_key(65537, 3072))))
    check("trame hello de taille raisonnable", taille < 1500, f"{taille} octets")

    # --- trames falsifiées ou faibles : aucune demande ne doit apparaître
    fort = rsa.generate_private_key(65537, 3072)
    faible = rsa.generate_private_key(65537, 2048)
    P.post("/api/echange/refuser", json={"ip": "127.0.0.1"})
    nb = lambda: len(P.get("/api/echanges").json()["demandes"])  # noqa: E731
    trame("127.0.0.2", hello(faible)); time.sleep(0.8)
    check("clé RSA de 2048 bits refusée", nb() == 0)
    trame("127.0.0.2", hello(fort, signature_ok=False)); time.sleep(0.8)
    check("signature falsifiée refusée", nb() == 0)
    trame("127.0.0.2", {"t": "hello", "pub": b64(os.urandom(32)), "r": "zz", "sig": b64(os.urandom(384))}); time.sleep(0.8)
    check("clé qui n'est pas du RSA refusée", nb() == 0)
    trame("127.0.0.2", hello(fort)); time.sleep(0.8)
    check("hello valide accepté (le test est sensible)", nb() == 1)

    # --- réponse falsifiée à une vraie demande : elle ne doit pas consommer la demande
    P.post("/api/echange/refuser", json={"ip": "127.0.0.1"})
    L.post("/api/cle/revoquer", json={"ip": "127.0.0.2"})
    L.post("/api/echange/demarrer", json={"ip": "127.0.0.2"})
    jeton = next(iter(json.load(open(os.path.join(sous_l, "echanges.json")))["sortants"]))
    pirate = rsa.generate_private_key(65537, 3072)
    faux = {"t": "ack", "pub": b64(der_pub(pirate)), "r": jeton, "wrap": b64(os.urandom(384)), "sig": b64(os.urandom(384))}
    trame("127.0.0.1", faux); time.sleep(0.8)
    check("fausse réponse : aucune clé créée", "127.0.0.2" not in L.get("/api/echanges").json()["cles"])
    check("fausse réponse : la demande reste en attente", L.get("/api/echanges").json()["sortants"] == ["127.0.0.2"])
    trame("127.0.0.1", {**faux, "r": "inconnu"}); time.sleep(0.5)
    attendre(lambda: P.get("/api/echanges").json()["demandes"])
    P.post("/api/echange/accepter", json={"ip": "127.0.0.1"})
    check("la vraie réponse aboutit ensuite", bool(attendre(lambda: "127.0.0.2" in L.get("/api/echanges").json()["cles"])))
finally:
    for p in (pl, pp):
        p.terminate()
        p.wait()
    shutil.rmtree(RACINE, ignore_errors=True)

print("TOUT OK" if ok_global else "DES ECHECS")
sys.exit(0 if ok_global else 1)
