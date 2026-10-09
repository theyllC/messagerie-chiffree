"""Test de bout en bout du Sprint 2 : serveur relais + salle de classe.
Un relais (127.0.0.1:8100) et trois clients (A, B, C) qui ne se parlent QUE par le relais.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_sprint2.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import httpx

DOSSIER_BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
MAIN = os.path.join(DOSSIER_BACKEND, "main.py")
RACINE = tempfile.mkdtemp()
ok_global = True
CODE = "424242"
URL_RELAIS = "http://127.0.0.1:8100"


def lancer(nom, web, hote, args=(), extra=None):
    d = os.path.join(RACINE, nom)
    env = dict(os.environ, APPDATA=d, MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1", MC_INTERVALLE_RELAIS="0.4",
               MC_INTERVALLE_FILE="1", MC_PORT_RELAIS="8100", MC_CODE_SALLE=CODE, **(extra or {}))
    return subprocess.Popen([sys.executable, MAIN, *args], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL), d


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
        time.sleep(0.2)
    return None


pr, dossier_r = lancer("R", 8090, "127.0.0.1", ["--relais"], {"MC_HOTE_RELAIS": "127.0.0.1"})
pa, _ = lancer("A", 8041, "127.0.0.1")
pb, _ = lancer("B", 8042, "127.0.0.2")
pc, _ = lancer("C", 8043, "127.0.0.3")
procs = [pr, pa, pb, pc]
time.sleep(4)
R = httpx.Client(base_url=URL_RELAIS, timeout=30)
A = httpx.Client(base_url="http://127.0.0.1:8041", timeout=30)
B = httpx.Client(base_url="http://127.0.0.1:8042", timeout=30)
C = httpx.Client(base_url="http://127.0.0.1:8043", timeout=30)

try:
    # ====================== RELAIS SEUL ======================
    check("relais : ping", R.get("/relais/ping").json().get("relais") is True)
    r = R.get("/relais/tableau")
    check("tableau : page HTML servie au PC du relais", r.status_code == 200 and "Salle de classe" in r.text)
    check("tableau : qrcode.js servi", R.get("/relais/qrcode.js").status_code == 200)
    tj = R.get("/relais/tableau.json").json()
    check("tableau : code de salle fixé par MC_CODE_SALLE", tj["salles"][0]["code"] == CODE, str(tj)[:200])
    check("tableau : lien mc-relais:// avec le code", tj["salles"][0]["lien"].endswith(f":8100/{CODE}") and tj["salles"][0]["lien"].startswith("mc-relais://"))
    check("sans jeton : 401", R.get("/relais/annuaire").status_code == 401)
    check("faux jeton : 401", R.get("/relais/boite", headers={"X-Relais-Token": "faux"}).status_code == 401)
    check("mauvais code : 404", R.post("/relais/rejoindre", json={"code": "000000"}).status_code == 404)

    # ====================== CLIENTS REJOIGNENT ======================
    A.post("/api/profil", json={"pseudo": "Alice", "avatar": "🦊"})
    B.post("/api/profil", json={"pseudo": "Bob", "avatar": "🎮"})
    check("client : pas de salle au départ", A.get("/api/relais").json()["configure"] is False)
    check("client : code à 5 chiffres refusé", A.post("/api/relais/rejoindre", json={"url": URL_RELAIS, "code": "12345"}).status_code == 400)
    check("client : adresse invalide refusée", A.post("/api/relais/rejoindre", json={"url": "ftp://x", "code": CODE}).status_code == 400)
    ra = A.post("/api/relais/rejoindre", json={"url": "127.0.0.1:8100", "code": CODE})
    check("A rejoint (adresse sans http://)", ra.status_code == 200 and ra.json()["configure"], ra.text)
    rb = B.post("/api/relais/rejoindre", json={"url": f"mc-relais://127.0.0.1:8100/{CODE}", "code": ""})
    check("B rejoint avec le lien mc-relais://", rb.status_code == 200 and rb.json()["configure"], rb.text)
    rc = C.post("/api/relais/rejoindre", json={"url": URL_RELAIS, "code": CODE})
    check("C rejoint", rc.status_code == 200)
    id_a, id_b, id_c = ra.json()["id"], rb.json()["id"], rc.json()["id"]
    adr_a, adr_b, adr_c = "relais:" + id_a, "relais:" + id_b, "relais:" + id_c
    check("jeton jamais renvoyé au front", "token" not in ra.text)

    ann = attendre(lambda: (lambda d: d if len(d["membres"]) == 2 else None)(A.get("/api/relais/annuaire").json()))
    check("A voit B et C dans l'annuaire (pas lui-même)", bool(ann) and {m["adresse"] for m in ann["membres"]} == {adr_b, adr_c}, str(ann))
    mb = next(m for m in ann["membres"] if m["adresse"] == adr_b)
    check("annuaire : pseudo + avatar de B", mb["pseudo"] == "Bob" and mb["avatar"] == "🎮" and mb["en_ligne"], str(mb))
    check("annuaire : B pas encore dans les contacts", mb["contact"] is False)
    check("tableau : 3 élèves", len(R.get("/relais/tableau.json").json()["salles"][0]["membres"]) == 3)

    # ====================== ÉCHANGE DE CLÉS PAR LE RELAIS ======================
    for X in (A, B, C):
        X.post("/api/coffre/creer", json={"mdp": "mot-de-passe-123"})
    A.post("/api/contacts", json={"ip": adr_b, "name": "Bob"})
    A.post("/api/contacts", json={"ip": adr_c, "name": "Carla"})
    check("contact relais ajouté", A.get("/api/contacts").json()["contacts"].get(adr_b) == "Bob")
    check("statut du contact relais : en ligne", attendre(lambda: A.get("/api/statut-contacts").json()["statuts"].get(adr_b)))
    check("profil de B retenu", attendre(lambda: A.get("/api/contacts").json()["profils"].get(adr_b, {}).get("pseudo") == "Bob"))

    r = A.post("/api/echange/demarrer", json={"ip": adr_b})
    check("demande d'échange envoyée par le relais", r.status_code == 200, r.text)
    dem = attendre(lambda: B.get("/api/echanges").json()["demandes"])
    check("B reçoit la demande de « relais:<id de A> »", bool(dem) and dem[0]["ip"] == adr_a, str(dem))
    check("B connaît déjà le pseudo de A (annuaire)", attendre(lambda: B.get("/api/contacts").json()["profils"].get(adr_a, {}).get("pseudo") == "Alice"))
    code_b = dem[0].get("code")
    B.post("/api/echange/accepter", json={"ip": adr_a})
    cles_a = attendre(lambda: A.get("/api/echanges").json()["cles"].get(adr_b))
    check("clés échangées via le relais", bool(cles_a))
    check("code de sécurité identique des deux côtés (anti-MITM)", bool(cles_a) and cles_a["code"] == code_b, f"{cles_a and cles_a['code']} / {code_b}")
    A.post("/api/echange/demarrer", json={"ip": adr_c})
    attendre(lambda: C.get("/api/echanges").json()["demandes"])
    C.post("/api/echange/accepter", json={"ip": adr_a})
    check("clés A<->C échangées", attendre(lambda: A.get("/api/echanges").json()["cles"].get(adr_c)))

    # ====================== MESSAGES ======================
    j = A.post("/api/envoyer", json={"ip": adr_b, "message": "Salut Bob, par le relais", "contact_cle": True}).json()
    check("envoi par le relais : statut envoyé", j.get("statut") == "envoye", str(j))
    rb_ = attendre(lambda: B.get("/api/recus?apres=0").json()["messages"])
    check("B reçoit le message", bool(rb_) and rb_[-1]["pair"] == adr_a, str(rb_ and rb_[-1]["pair"]))
    d = B.post("/api/dechiffrer", json={"id": rb_[-1]["id"]}).json()
    check("B déchiffre", d.get("clair") == "Salut Bob, par le relais", str(d))
    h = lambda: next(e for e in A.get("/api/historique").json()["entrees"] if e["id"] == j["id"])
    check("accusé « lu » revenu par le relais", attendre(lambda: h().get("statut") == "lu"), str(h().get("statut")))

    # Le relais ne peut pas lire : on inspecte tout son état sur disque
    time.sleep(6)  # laisse la sauvegarde périodique se faire
    etat_brut = open(os.path.join(dossier_r, "MessagerieChiffree", "relais", "etat.json"), encoding="utf-8").read()
    check("état du relais écrit sur disque", len(etat_brut) > 50)
    check("le texte en clair n'apparaît nulle part côté relais", "Salut Bob" not in etat_brut)
    check("aucune clé privée côté relais", "PRIVATE KEY" not in etat_brut and "rsa_prive" not in etat_brut)

    # Pièce jointe par le relais
    import base64
    contenu = base64.b64encode(os.urandom(40000)).decode()
    rf = A.post("/api/envoyer-fichier", json={"ip": adr_b, "nom_fichier": "t.bin", "donnees": contenu})
    check("fichier envoyé par le relais", rf.status_code == 200, rf.text)
    check("B reçoit la pièce jointe", attendre(lambda: any(m["v"] == 3 for m in B.get("/api/recus?apres=0").json()["messages"])))

    # ====================== GROUPE PAR LE RELAIS ======================
    g = A.post("/api/envoyer-groupe", json={"destinataires": [adr_b, adr_c], "message": "Coucou la classe"}).json()["envois"]
    check("groupe via relais : tous ok", all(e["statut"] == "ok" for e in g), str(g))
    rc_ = attendre(lambda: [m for m in C.get("/api/recus?apres=0").json()["messages"]][-1:])
    check("C déchiffre le message de groupe", rc_ and C.post("/api/dechiffrer", json={"id": rc_[0]["id"]}).json().get("clair") == "Coucou la classe")

    # ====================== BOÎTE AUX LETTRES : DESTINATAIRE HORS LIGNE ======================
    pc.terminate(); pc.wait()
    time.sleep(1)
    check("C hors ligne dans l'annuaire", attendre(lambda: next(m for m in A.get("/api/relais/annuaire").json()["membres"] if m["adresse"] == adr_c)["en_ligne"] is False, 20))
    j2 = A.post("/api/envoyer", json={"ip": adr_c, "message": "Tu rattraperas ça plus tard", "contact_cle": True}).json()
    check("envoi à un absent : accepté par le relais (envoyé, pas 'attente')", j2.get("statut") == "envoye", str(j2))
    check("la boîte de C contient le message côté relais", next(m for m in R.get("/relais/tableau.json").json()["salles"][0]["membres"] if m["id"] == id_c)["en_attente"] >= 1)
    pc, _ = lancer("C", 8043, "127.0.0.3")
    procs.append(pc)
    time.sleep(4)
    C = httpx.Client(base_url="http://127.0.0.1:8043", timeout=30)
    C.post("/api/coffre/ouvrir", json={"mdp": "mot-de-passe-123"})
    recus = attendre(lambda: [m for m in C.get("/api/recus?apres=0").json()["messages"]], 15)
    check("C retrouve ses messages au retour", bool(recus) and len(recus) >= 1)
    textes = []
    for m in recus or []:
        try:
            textes.append(C.post("/api/dechiffrer", json={"id": m["id"]}).json().get("clair"))
        except Exception:
            pass
    check("le message déposé pendant l'absence est lisible", "Tu rattraperas ça plus tard" in textes, str(textes))
    check("boîte vidée après acquittement", attendre(lambda: next(m for m in R.get("/relais/tableau.json").json()["salles"][0]["membres"] if m["id"] == id_c)["en_attente"] == 0, 10))

    # ====================== RELAIS ARRÊTÉ : LA FILE D'ATTENTE PREND LE RELAIS ======================
    pr.terminate(); pr.wait()
    time.sleep(1)
    j3 = A.post("/api/envoyer", json={"ip": adr_b, "message": "relais en panne", "contact_cle": True}).json()
    check("relais arrêté : message en file d'attente", j3.get("statut") == "attente", str(j3))
    check("client : relais signalé injoignable", attendre(lambda: A.get("/api/relais").json()["connecte"] is False, 10))
    pr, _ = lancer("R", 8090, "127.0.0.1", ["--relais"], {"MC_HOTE_RELAIS": "127.0.0.1"})  # même dossier : l'état est rechargé
    procs.append(pr)
    check("relais redémarré : la file d'attente se vide", attendre(lambda: not A.get("/api/file-attente").json()["messages"], 25))
    d3 = attendre(lambda: [m for m in B.get("/api/recus?apres=0").json()["messages"] if B.post("/api/dechiffrer", json={"id": m["id"]}).json().get("clair") == "relais en panne"], 15)
    check("B reçoit le message parti après la panne (le jeton survit au redémarrage)", bool(d3))

    # ====================== SÉCURITÉ DU RELAIS ======================
    codes = [R.post("/relais/rejoindre", json={"code": f"{i:06d}"}).status_code for i in range(1, 13)]
    check("force brute du code : 429 après 10 essais", 429 in codes and codes[0] == 404, str(codes))
    check("même avec le bon code, l'adresse bloquée reste bloquée", R.post("/relais/rejoindre", json={"code": CODE}).status_code == 429)
    tok_a = json.load(open(os.path.join(RACINE, "A", "MessagerieChiffree", "relais.json")))["token"]
    H = {"X-Relais-Token": tok_a}
    check("envoi vers un id inconnu : 404", R.post("/relais/envoyer", json={"a": "ffff", "data": "x"}, headers=H).status_code == 404)
    check("dépôt vide refusé", R.post("/relais/envoyer", json={"a": id_b, "data": ""}, headers=H).status_code == 400)
    check("expéditeur posé par le relais (pas de champ « de » falsifiable)", "de" not in json.dumps(R.post("/relais/envoyer", json={"a": id_b, "data": "x", "de": id_c}, headers=H).json()))

    # nouveau code + retrait d'un membre depuis le tableau
    nv = R.post(f"/relais/tableau/nouveau-code?code={CODE}").json()["code"]
    check("nouveau code généré", nv != CODE and len(nv) == 6)
    check("retrait d'un élève : son jeton ne marche plus", R.post(f"/relais/tableau/retirer?code={nv}&id={id_c}").status_code == 200
          and C.get("/api/relais/annuaire").status_code == 502)

    # quitter
    A.post("/api/relais/quitter")
    check("A quitte la salle", A.get("/api/relais").json()["configure"] is False)
    check("A n'est plus dans l'annuaire du relais", id_a not in [m["id"] for m in R.get("/relais/tableau.json").json()["salles"][0]["membres"]])
finally:
    for p in procs:
        p.terminate()

print()
print("TOUS LES TESTS PASSENT" if ok_global else "DES TESTS ONT ECHOUE")
sys.exit(0 if ok_global else 1)
