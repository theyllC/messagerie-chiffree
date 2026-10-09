"""Test des parties privées (morpion 1 contre 1) : deux instances échangent leurs clés puis jouent par messages chiffrés.
Vérifie : les coups sont des messages v2 invisibles dans le fil (pas de JSON brut), la partie se reconstitue des deux côtés,
validation à l'envoi, refus sans clé échangée, contenu illisible hors coffre, et rien en clair dans l'historique stocké.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_jeu_prive.py
"""
import hashlib
import json
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


pa, da = lancer("A", 8021, "127.0.0.1")
pb, db = lancer("B", 8022, "127.0.0.2")
time.sleep(4)
A = httpx.Client(base_url="http://127.0.0.1:8021", timeout=20)
B = httpx.Client(base_url="http://127.0.0.1:8022", timeout=20)
IPA, IPB = "127.0.0.1", "127.0.0.2"


def conv(X, ip):
    return X.get(f"/api/conversation?ip={ip}").json()


def jeux_de(X, ip, ip_boucle=None):
    """Événements de jeu avec ce contact. Sur un seul PC, l'autre instance se connecte depuis 127.0.0.1 : A range donc les messages
    reçus de B sous sa propre adresse (ip_boucle). Sur un vrai réseau, chacun a sa propre IP et cette étape ne sert à rien."""
    tous = conv(X, ip)["jeux"] + (conv(X, ip_boucle)["jeux"] if ip_boucle else [])
    return sorted(tous, key=lambda e: e["id"])


def jeu(X, ip, **corps):
    return X.post("/api/conversation/jeu", json={"ip": ip, "j": "morpion", **corps})


try:
    A.post("/api/coffre/creer", json={"mdp": "mdp-de-A-123"})
    B.post("/api/coffre/creer", json={"mdp": "mdp-de-B-456"})
    check("défi refusé sans clé échangée", jeu(A, IPB, a="defi").status_code == 400)
    A.post("/api/echange/demarrer", json={"ip": IPB})
    attendre(lambda: B.get("/api/echanges").json()["demandes"])
    B.post("/api/echange/accepter", json={"ip": IPA})
    check("clés échangées", attendre(lambda: IPB in A.get("/api/echanges").json()["cles"] and IPA in B.get("/api/echanges").json()["cles"]))

    r = jeu(A, IPB, a="defi")
    check("A lance un défi", r.status_code == 200, r.text[:80])
    g = r.json()["g"]
    check("identifiant de partie tiré par le serveur (8 hex)", len(g) == 8 and all(c in "0123456789abcdef" for c in g))
    d = attendre(lambda: (lambda c: c if len(c["jeux"]) == 1 else None)(conv(B, IPA)))
    check("B reçoit le défi, déchiffré, sans bulle de texte", d and d["jeux"][0]["a"] == "defi" and d["jeux"][0]["g"] == g and d["jeux"][0]["sens"] == "recu" and d["messages"] == [], str(d))

    check("coup hors grille refusé", jeu(A, IPB, a="coup", g=g, i=9, s=0).status_code == 400)
    check("coup sans numéro refusé", jeu(A, IPB, a="coup", g=g, i=1).status_code == 400)
    check("partie inconnue (identifiant mal formé) refusée", jeu(A, IPB, a="coup", g="zz", i=1, s=0).status_code == 400)
    check("jeu inconnu refusé", A.post("/api/conversation/jeu", json={"ip": IPB, "j": "echecs", "a": "defi"}).status_code == 400)

    jeu(B, IPA, a="accepte", g=g)
    for X, ip, i, s in ((A, IPB, 0, 0), (B, IPA, 3, 1), (A, IPB, 1, 2), (B, IPA, 4, 3), (A, IPB, 2, 4)):
        check(f"coup s={s} envoyé", jeu(X, ip, a="coup", g=g, i=i, s=s).status_code == 200)
    ja = lambda: jeux_de(A, IPB, IPA)
    jb = lambda: jeux_de(B, IPA)
    check("A et B voient les 7 événements de la partie", attendre(lambda: len(ja()) == 7 and len(jb()) == 7), f"{len(ja())}/{len(jb())}")
    ca, cb = conv(A, IPB), conv(B, IPA)
    coups = lambda L: [e for e in L if e["a"] == "coup"]
    check("côté B : ses coups sont « envoye », ceux de A « recu » (ordre d'arrivée = ordre de jeu)", [e["sens"] for e in coups(jb())] == ["recu", "envoye", "recu", "envoye", "recu"])
    check("côté A : l'inverse", sorted([e["sens"] for e in coups(ja())]) == sorted(["envoye", "recu", "envoye", "recu", "envoye"]) and sum(e["sens"] == "envoye" for e in coups(ja())) == 3)
    check("les coups portent la bonne case et le bon numéro (des deux côtés)", all(sorted((e["s"], e["i"]) for e in coups(L())) == [(0, 0), (1, 3), (2, 1), (3, 4), (4, 2)] for L in (ja, jb)))
    check("aucun JSON de jeu dans les bulles de texte", ca["messages"] == [] and cb["messages"] == [])

    A.post("/api/envoyer", json={"ip": IPB, "message": "gg !", "contact_cle": True})
    check("un vrai message passe toujours dans le fil", attendre(lambda: [m["clair"] for m in conv(B, IPA)["messages"]] == ["gg !"]))

    # Un texte saisi ne peut pas se faire passer pour un coup de jeu (il serait invisible chez le destinataire)
    faux = "\x07JEU:" + json.dumps({"j": "morpion", "a": "defi", "g": "abcd1234"})
    check("envoi normal d'un texte commençant par le marqueur de jeu refusé (clé échangée)",
          A.post("/api/envoyer", json={"ip": IPB, "message": faux, "contact_cle": True}).status_code == 400)
    check("même refus avec des espaces avant le marqueur (le texte est nettoyé avant l'envoi)",
          A.post("/api/envoyer", json={"ip": IPB, "message": "  \n" + faux, "contact_cle": True}).status_code == 400)
    check("même refus avec une clé saisie à la main",
          A.post("/api/envoyer", json={"ip": IPB, "message": "\x07JEU:{", "cle": "une-cle-assez-longue"}).status_code == 400)
    check("même refus pour un envoi groupé", A.post("/api/envoyer-groupe", json={"destinataires": [IPB], "message": faux}).status_code == 400)
    check("le marqueur au milieu d'un texte reste permis", A.post("/api/envoyer", json={"ip": IPB, "message": "voici \x07JEU: au milieu", "contact_cle": True}).status_code == 200)
    time.sleep(1)
    check("rien n'est parti pour les textes refusés", all(not (m["clair"] or "").startswith("\x07JEU:") for m in conv(B, IPA)["messages"]))


    # ------------------------------------------------------------------ pierre-feuille-ciseaux avec engagement
    check("engagement mal formé refusé", jeu(A, IPB, j="pfc", a="engage", g=g, r=0, h="abc").status_code == 400)
    check("révélation avec un coup inconnu refusée", jeu(A, IPB, j="pfc", a="revele", g=g, r=0, m="z", x="0" * 32).status_code == 400)
    check("manche hors limite refusée", jeu(A, IPB, j="pfc", a="engage", g=g, r=10, h="0" * 64).status_code == 400)
    check("sel trop court refusé", jeu(A, IPB, j="pfc", a="revele", g=g, r=0, m="p", x="00").status_code == 400)
    check("un coup de morpion ne s'applique pas à pfc", jeu(A, IPB, j="pfc", a="coup", g=g, i=1, s=0).status_code == 400)
    check("engagement refusé pour le morpion", jeu(A, IPB, j="morpion", a="engage", g=g, r=0, h="0" * 64).status_code == 400)
    A.get("/api/conversation?ip=" + IPB)
    B.post("/api/coffre/ouvrir", json={"mdp": "mdp-de-B-456"})
    r = jeu(A, IPB, j="pfc", a="defi")
    check("A lance un défi pierre-feuille-ciseaux", r.status_code == 200)
    gp = r.json()["g"]
    jeu(B, IPA, j="pfc", a="accepte", g=gp)
    H = lambda r_, cote, coup, sel: hashlib.sha256(f"{gp}|{r_}|{cote}|{coup}|{sel}".encode()).hexdigest()  # même format que le moteur JavaScript
    sels = {("a", 0): "a1" * 16, ("b", 0): "b2" * 16, ("a", 1): "c3" * 16, ("b", 1): "d4" * 16}
    manches = [(0, "p", "c"), (1, "f", "p")]  # A gagne les deux : pierre > ciseaux, feuille > pierre
    for r_, ca, cb_ in manches:
        check(f"manche {r_} : A s'engage", jeu(A, IPB, j="pfc", a="engage", g=gp, r=r_, h=H(r_, "x", ca, sels[("a", r_)])).status_code == 200)
        check(f"manche {r_} : B s'engage", jeu(B, IPA, j="pfc", a="engage", g=gp, r=r_, h=H(r_, "o", cb_, sels[("b", r_)])).status_code == 200)
        check(f"manche {r_} : A révèle", jeu(A, IPB, j="pfc", a="revele", g=gp, r=r_, m=ca, x=sels[("a", r_)]).status_code == 200)
        check(f"manche {r_} : B révèle", jeu(B, IPA, j="pfc", a="revele", g=gp, r=r_, m=cb_, x=sels[("b", r_)]).status_code == 200)
    attendre(lambda: len([e for e in jeux_de(B, IPA) if e.get("g") == gp]) == 10 and len([e for e in jeux_de(A, IPB, IPA) if e.get("g") == gp]) == 10)
    check("A et B ont reçu les 10 événements de la partie", len([e for e in jeux_de(B, IPA) if e.get("g") == gp]) == 10 and len([e for e in jeux_de(A, IPB, IPA) if e.get("g") == gp]) == 10)
    check("les engagements sont des empreintes de 64 caractères hexadécimaux (le coup n'est pas dans le message avant la révélation)",
          all(len(e["h"]) == 64 for e in jeux_de(B, IPA) if e["a"] == "engage" and e["g"] == gp))
    node = shutil.which("node")
    if node:
        moteur = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "frontend", "tests", "rejouer.mjs")
        for qui, X, evs in (("B", B, jeux_de(B, IPA)), ("A", A, jeux_de(A, IPB, IPA))):
            sortie = subprocess.run([node, moteur], input=json.dumps(evs), capture_output=True, text=True, timeout=30)
            parties = {p["n"]: p for p in json.loads(sortie.stdout)} if sortie.returncode == 0 else {}
            p = parties.get(gp, {})
            check(f"{qui} : le moteur JS vérifie les engagements calculés en Python et donne la victoire à A (2-0)",
                  p.get("etat") == "fini" and p.get("gagnant") == "x" and p.get("points") == {"x": 2, "o": 0} and not p.get("motif"), sortie.stderr[:200] or str(p.get("points")))
    else:
        print("(node absent : rejeu du moteur JavaScript ignoré)")

    # Historique / Recevoir : pas de JSON brut
    recu = next(m for m in B.get("/api/recus?apres=0").json()["messages"])
    clair = B.post("/api/dechiffrer", json={"crypte": recu["crypte"]}).json()["clair"]
    check("Recevoir/Historique n'affichent pas le JSON brut", "JEU" not in clair and "morpion" not in clair and "defi" not in clair, clair)

    # Confidentialité : rien en clair sur le disque
    time.sleep(1)
    stocke = ""
    for racine, _, fichiers in os.walk(da):
        for f in fichiers:
            if f.endswith(".json") and f != "coffre.json":
                stocke += open(os.path.join(racine, f), encoding="utf-8", errors="ignore").read()
    check("historique stocké : ni « morpion » ni « coup » en clair", stocke and "morpion" not in stocke and '"coup"' not in stocke)

    # Coffre verrouillé : coups illisibles
    B.post("/api/coffre/verrouiller")
    c = conv(B, IPA)
    check("coffre verrouillé : aucun coup lisible, pas de JSON brut", c["jeux"] == [] and all(m["clair"] is None for m in c["messages"]))
    check("coffre verrouillé : jouer refusé", jeu(B, IPA, a="abandon", g=g, s=5).status_code == 423)
finally:
    for p in (pa, pb):
        p.terminate()
print("\nTOUT EST OK" if ok_global else "\nIL Y A DES ECHECS")
sys.exit(0 if ok_global else 1)
