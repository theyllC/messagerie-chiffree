"""Test de bout en bout : deux instances du programme sur ce PC échangent leurs clés puis se parlent.
Prérequis : pip install httpx  ·  Lancer : python backend/tests/test_echange_cles.py
"""
import subprocess, time, os, shutil, httpx, sys
S=__import__("tempfile").mkdtemp()
def lancer(nom, web, hote):
    d=f"{S}/ap_{nom}"; shutil.rmtree(d,ignore_errors=True)
    env=dict(os.environ, APPDATA=d, MC_PORT_WEB=str(web), MC_HOTE=hote, MC_SANS_NAVIGATEUR="1")
    p=subprocess.Popen(["python3",os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","main.py")],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    return p, d
pa,da=lancer("A",8001,"127.0.0.1"); pb,db=lancer("B",8002,"127.0.0.2"); time.sleep(4)
A=httpx.Client(base_url="http://127.0.0.1:8001",timeout=20); B=httpx.Client(base_url="http://127.0.0.1:8002",timeout=20)
ok=True
def check(nom, cond, extra=""):
    global ok; ok&=bool(cond); print(("OK  " if cond else "ECHEC"), nom, extra)
try:
    check("état initial absent", A.get("/api/echanges").json()["etat"]=="absent")
    r=A.post("/api/echange/demarrer",json={"ip":"127.0.0.2"}); check("démarrer sans coffre refusé (423)", r.status_code==423)
    check("mdp trop court refusé", A.post("/api/coffre/creer",json={"mdp":"court"}).status_code==400)
    check("création A", A.post("/api/coffre/creer",json={"mdp":"mdp-de-A-123"}).status_code==200)
    check("création B", B.post("/api/coffre/creer",json={"mdp":"mdp-de-B-456"}).status_code==200)
    # A demande à B
    r=A.post("/api/echange/demarrer",json={"ip":"127.0.0.2"}); check("A envoie hello", r.status_code==200, r.text)
    time.sleep(1); e=B.get("/api/echanges").json(); check("B voit la demande de A", [d["ip"] for d in e["demandes"]]==["127.0.0.1"], str(e["demandes"]))
    check("A voit la demande envoyée", A.get("/api/echanges").json()["sortants"]==["127.0.0.2"])
    # B verrouille puis tente d'accepter
    B.post("/api/coffre/verrouiller"); check("accepter verrouillé refusé", B.post("/api/echange/accepter",json={"ip":"127.0.0.1"}).status_code==423)
    check("mauvais mdp", B.post("/api/coffre/ouvrir",json={"mdp":"faux-faux-faux"}).status_code==400)
    check("ouverture B", B.post("/api/coffre/ouvrir",json={"mdp":"mdp-de-B-456"}).status_code==200)
    # A se verrouille AVANT la réponse de B : la finalisation doit se faire au déverrouillage
    A.post("/api/coffre/verrouiller")
    r=B.post("/api/echange/accepter",json={"ip":"127.0.0.1"}); check("B accepte", r.status_code==200, r.text)
    time.sleep(1)
    A.post("/api/coffre/ouvrir",json={"mdp":"mdp-de-A-123"})
    ea,eb=A.get("/api/echanges").json(), B.get("/api/echanges").json()
    check("A a la clé de B", "127.0.0.2" in ea["cles"], str(ea["cles"]))
    check("B a la clé de A", "127.0.0.1" in eb["cles"])
    check("codes de sécurité identiques", ea["cles"]["127.0.0.2"]["code"]==eb["cles"]["127.0.0.1"]["code"], ea["cles"]["127.0.0.2"]["code"])
    check("demande B effacée, sortants A vide", eb["demandes"]==[] and ea["sortants"]==[])
    # Envoi sans mot de passe de message
    r=A.post("/api/envoyer",json={"ip":"127.0.0.2","message":"Salut B, ça va ? é","contact_cle":True}); check("A envoie avec la clé du contact", r.status_code==200, r.text[:60])
    time.sleep(1); m=B.get("/api/recus?apres=0").json()["messages"]; check("B reçoit un message v2", len(m)==1 and m[0]["v"]==2)
    r=B.post("/api/dechiffrer",json={"crypte":m[0]["crypte"]}); check("B déchiffre sans clé manuelle", r.json().get("clair")=="Salut B, ça va ? é", r.text)
    # A relit son propre message envoyé
    h=A.get("/api/historique").json()["entrees"]; r=A.post("/api/dechiffrer",json={"crypte":h[-1]["crypte"]}); check("A relit son message envoyé", r.json().get("clair")=="Salut B, ça va ? é")
    # coffre verrouillé : reçoit mais ne déchiffre pas
    B.post("/api/coffre/verrouiller"); A.post("/api/envoyer",json={"ip":"127.0.0.2","message":"pendant le verrouillage","contact_cle":True}); time.sleep(1)
    m=B.get("/api/recus?apres=0").json()["messages"]; check("message reçu coffre verrouillé", len(m)==2)
    check("déchiffrement refusé (423)", B.post("/api/dechiffrer",json={"crypte":m[1]["crypte"]}).status_code==423)
    B.post("/api/coffre/ouvrir",json={"mdp":"mdp-de-B-456"}); check("puis déchiffré après ouverture", B.post("/api/dechiffrer",json={"crypte":m[1]["crypte"]}).json().get("clair")=="pendant le verrouillage")
    # mode manuel v1 toujours OK
    r=A.post("/api/envoyer",json={"ip":"127.0.0.2","cle":"motdepasse123","message":"manuel"}); time.sleep(1)
    m=B.get("/api/recus?apres=0").json()["messages"][-1]; check("v1 manuel", m["v"]==1 and B.post("/api/dechiffrer",json={"crypte":m["crypte"],"cle":"motdepasse123"}).json().get("clair")=="manuel")
    check("v1 sans clé refusé", B.post("/api/dechiffrer",json={"crypte":m["crypte"]}).status_code==400)
    # vérifier / révoquer
    B.post("/api/cle/verifier",json={"ip":"127.0.0.1","verifie":True}); check("vérifié", B.get("/api/echanges").json()["cles"]["127.0.0.1"]["verifie"] is True)
    B.post("/api/cle/revoquer",json={"ip":"127.0.0.1"}); check("révoqué", B.get("/api/echanges").json()["cles"]=={})
    check("message v2 illisible après révocation", B.post("/api/dechiffrer",json={"crypte":m["crypte"] if False else B.get("/api/recus?apres=0").json()["messages"][0]["crypte"]}).status_code==400)
    # persistance : redémarrer A
    pass
except Exception as ex:
    ok=False; print("EXCEPTION", repr(ex))
finally:
    for p in (pa,pb): p.terminate()
    print("TOUT OK" if ok else "DES ECHECS")
