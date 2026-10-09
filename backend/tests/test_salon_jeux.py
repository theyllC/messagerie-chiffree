"""Test des événements du salon : réactions, sondages, votes, morpion, messages éphémères.
Vérifie : tout est chiffré de bout en bout (le relais ne voit rien en clair), validation des entrées (envoi ET réception),
messages éphémères effacés par le relais à l'échéance, durées invalides refusées.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_salon_jeux.py
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
CODE = "626262"
URL_RELAIS = "http://127.0.0.1:8111"
MDP = "mot-de-passe-123"
ok_global = True


def lancer(nom, web, args=()):
    env = dict(os.environ, APPDATA=os.path.join(RACINE, nom), MC_PORT_WEB=str(web), MC_HOTE="127.0.0.1", MC_SANS_NAVIGATEUR="1",
               MC_INTERVALLE_RELAIS="0.4", MC_INTERVALLE_SALON="0.6", MC_INTERVALLE_FILE="1", MC_PORT_RELAIS="8111", MC_CODE_SALLE=CODE,
               MC_HOTE_RELAIS="127.0.0.1", MC_PORT_SOCKET=str(5400 + web % 100), MC_PORT_UDP=str(5500 + web % 100))
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


procs = {"R": lancer("R", 8291, ["--relais"]), "P": lancer("P", 8292), "A": lancer("A", 8293), "B": lancer("B", 8294)}
time.sleep(4)
R = httpx.Client(base_url=URL_RELAIS, timeout=30)
P, A, B = (httpx.Client(base_url=f"http://127.0.0.1:{p}", timeout=60) for p in (8292, 8293, 8294))


def salon(X, apres=0):
    return X.get(f"/api/relais/salon?apres={apres}").json()


def ev(X, **corps):
    return X.post("/api/relais/salon/evenement", json=corps)


def evenements(X, k):
    return [m for m in salon(X)["messages"] if m.get("k") == k]


try:
    for X, nom in ((P, "Prof"), (A, "Alice"), (B, "Bob")):
        X.post("/api/profil", json={"pseudo": nom, "avatar": ""})
        X.post("/api/coffre/creer", json={"mdp": MDP})
        X.post("/api/relais/rejoindre", json={"url": URL_RELAIS, "code": CODE})
    for X, nom in ((P, "Prof"), (A, "Alice"), (B, "Bob")):
        check(f"{nom} a la clé du salon", attendre(lambda: salon(X)["etat_cle"] == "ok"))
    id_a, id_b = A.get("/api/relais").json()["id"], B.get("/api/relais").json()["id"]
    check("la réponse du salon donne mon identifiant", salon(A)["moi"] == id_a)

    # ------------------------------------------------------------------ réactions
    n_msg = A.post("/api/relais/salon", json={"texte": "Qui est prêt ?"}).json()["n"]
    check("réaction envoyée", ev(B, k="rx", c=n_msg, e="👍", on=True).status_code == 200)
    ev(P, k="rx", c=n_msg, e="🎉", on=True)
    d = attendre(lambda: (lambda l: l if len(l) == 2 else None)(evenements(A, "rx")))
    check("Alice reçoit les 2 réactions déchiffrées", d and {(m["e"], m["c"]) for m in d} == {("👍", n_msg), ("🎉", n_msg)})
    check("l'auteur de la réaction vient du relais (liée au chiffrement)", d and {m["de"] for m in d} >= {id_b})
    check("emoji hors liste refusé", ev(B, k="rx", c=n_msg, e="💣", on=True).status_code == 400)
    check("réaction sans message visé refusée", ev(B, k="rx", e="👍").status_code == 400)

    # ------------------------------------------------------------------ sondage
    check("sondage à une seule option refusé", ev(P, k="poll", q="Pizza ?", o=["oui"]).status_code == 400)
    check("sondage à 7 options refusé", ev(P, k="poll", q="Pizza ?", o=[str(i) for i in range(7)]).status_code == 400)
    check("sondage sans question refusé", ev(P, k="poll", q=" ", o=["a", "b"]).status_code == 400)
    n_poll = ev(P, k="poll", q="Pizza ou sushi ?", o=["Pizza", "Sushi"]).json()["n"]
    check("vote hors limite refusé", ev(A, k="vote", c=n_poll, i=6).status_code == 400)
    ev(A, k="vote", c=n_poll, i=0)
    ev(B, k="vote", c=n_poll, i=1)
    d = attendre(lambda: (lambda l: l if len(l) == 2 else None)(evenements(P, "vote")))
    check("le prof lit les 2 votes", d and sorted(m["i"] for m in d) == [0, 1])
    p = next(iter(evenements(B, "poll")), None)
    check("le sondage est lisible par Bob", p and p["q"] == "Pizza ou sushi ?" and p["o"] == ["Pizza", "Sushi"], str(p))

    # ------------------------------------------------------------------ morpion
    n_defi = ev(A, k="jeu", j="morpion", a="defi").json()["n"]
    check("jeu inconnu refusé", ev(A, k="jeu", j="echecs", a="defi").status_code == 400)
    check("case hors grille refusée", ev(A, k="jeu", j="morpion", a="coup", c=n_defi, i=9).status_code == 400)
    check("action inconnue refusée", ev(A, k="jeu", j="morpion", a="triche", c=n_defi).status_code == 400)
    check("coup sans défi visé refusé", ev(A, k="jeu", j="morpion", a="coup", i=1).status_code == 400)
    ev(B, k="jeu", j="morpion", a="accepte", c=n_defi)
    for X, i in ((A, 0), (B, 3), (A, 1), (B, 4), (A, 2)):
        ev(X, k="jeu", j="morpion", a="coup", c=n_defi, i=i)
    d = attendre(lambda: (lambda l: l if len(l) == 7 else None)(evenements(P, "jeu")))
    check("le prof (spectateur) lit le défi, l'acceptation et les 5 coups", d is not None, str(len(evenements(P, "jeu"))))
    check("les coups portent le bon joueur et la bonne case", d and [(m["a"], m.get("i")) for m in d if m["a"] == "coup"] == [("coup", 0), ("coup", 3), ("coup", 1), ("coup", 4), ("coup", 2)])


    # ------------------------------------------------------------------ pierre-feuille-ciseaux dans le salon
    n_pfc = ev(A, k="jeu", j="pfc", a="defi").json()["n"]
    ev(B, k="jeu", j="pfc", a="accepte", c=n_pfc)
    H_A, H_B = "ab" * 32, "cd" * 32
    check("engagement valide accepté", ev(A, k="jeu", j="pfc", a="engage", c=n_pfc, r=0, h=H_A).status_code == 200)
    ev(B, k="jeu", j="pfc", a="engage", c=n_pfc, r=0, h=H_B)
    check("engagement non hexadécimal refusé", ev(A, k="jeu", j="pfc", a="engage", c=n_pfc, r=0, h="Z" * 64).status_code == 400)
    check("engagement sans partie visée refusé", ev(A, k="jeu", j="pfc", a="engage", r=0, h=H_A).status_code == 400)
    check("révélation d'un coup inconnu refusée", ev(A, k="jeu", j="pfc", a="revele", c=n_pfc, r=0, m="x", x="0" * 32).status_code == 400)
    ev(A, k="jeu", j="pfc", a="revele", c=n_pfc, r=0, m="p", x="11" * 16)
    d = attendre(lambda: (lambda l: l if len([m for m in l if m.get("j") == "pfc"]) == 5 else None)(evenements(P, "jeu")))
    pf = [m for m in d] if d else []
    check("le prof (spectateur) lit les engagements et la révélation", d and [m["a"] for m in pf if m["j"] == "pfc"] == ["defi", "accepte", "engage", "engage", "revele"])
    check("les engagements lus sont ceux envoyés", d and {m["h"] for m in pf if m["a"] == "engage"} == {H_A, H_B})

    # ------------------------------------------------------------------ forfait (pierre-feuille-ciseaux du salon) et heure du relais
    check("forfait valide accepté", ev(A, k="jeu", j="pfc", a="forfait", c=n_pfc, r=0).status_code == 200)
    check("forfait sans manche refusé", ev(A, k="jeu", j="pfc", a="forfait", c=n_pfc).status_code == 400)
    check("forfait avec une manche hors limite refusé", ev(A, k="jeu", j="pfc", a="forfait", c=n_pfc, r=10).status_code == 400)
    check("forfait sans partie visée refusé", ev(A, k="jeu", j="pfc", a="forfait", r=0).status_code == 400)
    check("forfait refusé pour le morpion", ev(A, k="jeu", j="morpion", a="forfait", c=n_defi, r=0).status_code == 400)
    fo = attendre(lambda: next((m for m in evenements(P, "jeu") if m.get("a") == "forfait"), None))
    check("le forfait est lu avec la manche visée", fo and fo["r"] == 0 and fo["c"] == n_pfc, str(fo))
    jeux_pfc = [m for m in evenements(P, "jeu") if m.get("j") == "pfc"]
    ts = [m.get("t") for m in jeux_pfc]
    check("chaque événement porte l'heure du relais (nombre, croissante avec le numéro)", ts and all(isinstance(t, (int, float)) and not isinstance(t, bool) for t in ts)
          and ts == sorted(ts) and abs(ts[-1] - time.time()) < 60, str(ts[-3:]))
    check("les messages texte portent aussi l'heure du relais", all(isinstance(m.get("t"), float) for m in salon(A)["messages"]))

    # ------------------------------------------------------------------ le relais ne voit rien en clair
    time.sleep(6)  # le relais sauvegarde toutes les 5 s
    etat_disque = ""
    for racine, _, fichiers in os.walk(os.path.join(RACINE, "R")):
        for f in fichiers:
            if f.endswith(".json"):
                etat_disque += open(os.path.join(racine, f), encoding="utf-8").read()
    check("état du relais écrit sur disque", "salon" in etat_disque and len(etat_disque) > 500)
    # Les mots-clés sont cherchés entre guillemets : du base64 ne peut pas les contenir par hasard (« pfc » seul, 3 lettres, y apparaissait
    # au hasard dans environ 1 exécution sur 5).
    check("le relais n'a ni emoji, ni question de sondage, ni mot « morpion » en clair",
          not any(mot in etat_disque for mot in ("👍", "🎉", "Pizza", "Sushi", '"morpion"', '"defi"', '"accepte"', '"pfc"', '"engage"', '"revele"', '"forfait"', "ab" * 32, "11" * 16)))

    # ------------------------------------------------------------------ messages éphémères
    check("durée trop courte refusée", A.post("/api/relais/salon", json={"texte": "x", "ttl": 2}).status_code == 400)
    check("durée trop longue refusée", A.post("/api/relais/salon", json={"texte": "x", "ttl": 90000}).status_code == 400)
    n_eph = A.post("/api/relais/salon", json={"texte": "Ce message va s'autodétruire", "ttl": 6}).json()["n"]
    m = attendre(lambda: next((x for x in salon(B)["messages"] if x["n"] == n_eph), None))
    check("Bob lit le message éphémère, avec son échéance", m and m.get("texte") and isinstance(m.get("exp"), (int, float)))
    d = salon(B)
    check("l'échéance est ~6 s après l'horloge du relais", m and 0 < m["exp"] - d["horloge"] <= 6, str(m and m["exp"] - d["horloge"]))
    check("un message normal n'a pas d'échéance", next(x for x in d["messages"] if x["n"] == n_msg).get("exp") is None)
    gone = attendre(lambda: (lambda d: n_eph in d["supprimes"] and n_eph in d["expires"])(salon(B)), delai=20)
    check("le relais efface le message éphémère à l'échéance", gone)
    check("signalé comme expiré (pas comme supprimé par quelqu'un)", n_eph in salon(P)["expires"])
    check("il n'est plus renvoyé par le relais", all(x["n"] != n_eph for x in salon(P)["messages"]))
    n_sup = A.post("/api/relais/salon", json={"texte": "à supprimer"}).json()["n"]
    A.post("/api/relais/salon/supprimer", json={"n": n_sup})
    check("un message supprimé à la main n'est pas « expiré »", n_sup in salon(B)["supprimes"] and n_sup not in salon(B)["expires"])
finally:
    for p in procs.values():
        p.terminate()
print("\nTOUT EST OK" if ok_global else "\nIL Y A DES ECHECS")
sys.exit(0 if ok_global else 1)
