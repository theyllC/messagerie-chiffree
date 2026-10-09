"""Serveur relais : une « boîte aux lettres chiffrée » partagée par une salle de classe.

Lancer : python main.py --relais   (ou : python relais.py)

Ce que le relais SAIT : qui est dans la salle (pseudo, avatar), qui écrit à qui, la taille et l'heure des messages.
Ce que le relais NE PEUT PAS faire : lire un message. Il transporte les mêmes textes chiffrés que le réseau direct
(RSA-OAEP + AES-256-GCM) : les clés ne sont jamais envoyées au relais, qui n'a donc rien à déchiffrer.

Protocole (HTTP + JSON, sondage régulier : passe les proxys et pare-feux d'établissement) :
    POST /relais/rejoindre   {code, pseudo, avatar}      -> {id, token, salle}
    GET  /relais/annuaire                                -> membres de la salle et leur présence
    POST /relais/profil      {pseudo, avatar}
    POST /relais/envoyer     {a, data}                   -> dépose `data` dans la boîte du membre `a` (même salle)
    GET  /relais/boite?apres=n                           -> mes messages en attente {n, de, data, heure}
    POST /relais/acquitter   {jusqua}                    -> efface mes messages jusqu'au numéro n
    GET  /relais/salon?apres=n                           -> messages CHIFFRÉS du salon commun {n, de, epoque, data, heure} + numéros supprimés
    POST /relais/salon/envoyer {data, epoque, ttl}       -> dépose un message chiffré dans le salon (clé de l'époque courante) ; ttl > 0 : éphémère, effacé à l'échéance
                                                            (texte, réaction, sondage, vote ou coup de jeu : le relais ne fait pas la différence)
    POST /relais/salon/supprimer {n}                     -> supprime un message (son auteur, ou un admin)
    POST /relais/salon/pub {pub}                         -> publie ma clé publique RSA (pour recevoir la clé du salon)
    GET  /relais/salon/cles                              -> mes exemplaires de la clé du salon (chiffrés pour moi : RSA-OAEP)
    POST /relais/salon/cles {epoque, cles, retraits}     -> (admin) distribue la clé du salon / la renouvelle (époque + 1)
    POST /relais/salon/role {id, role}                   -> (créateur) nomme ou retire un admin
    POST /relais/salon/retirer {id}                      -> (admin) retire un membre de la salle
    POST /relais/quitter
Salon commun : chiffré de bout en bout (AES-256-GCM). La clé du salon est tirée au hasard par le CRÉATEUR, puis chiffrée pour chaque
membre avec sa clé publique RSA : le relais ne voit que des textes chiffrés et ne connaît jamais la clé. Elle est renouvelée (époque + 1)
dès qu'un membre part ou est retiré. Rôles : « createur » (le premier à rejoindre depuis le PC du relais), « admin », « eleve ».
Le jeton (en-tête X-Relais-Token) identifie le membre : le champ « de » est posé par le relais, pas par l'expéditeur.
La page /relais/tableau (code de salle, QR code, liste des élèves) n'est accessible que depuis le PC du relais.
Le trafic n'est pas chiffré en transit (HTTP) : c'est sans importance pour le contenu des messages (chiffrés de bout en bout),
mais le code de salle et le jeton circulent en clair sur le réseau local.
"""
import hashlib
import json
import math
import os
import secrets
import socket
import sys
import threading
import time
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel

PORT_RELAIS = int(os.environ.get("MC_PORT_RELAIS", 8100))
MAX_DATA = 6 * 1024 * 1024        # taille maximale d'un dépôt (octets) : comme la réception directe
MAX_BOITE = 500                   # messages en attente par membre
MAX_OCTETS_BOITE = 40 * 1024 * 1024  # octets en attente par membre
MAX_MEMBRES = 200                 # membres par salle
DUREE_MESSAGE = 7 * 24 * 3600     # un message non récupéré est effacé après 7 jours
PRESENCE = 15                     # un membre est « en ligne » s'il a appelé le relais depuis moins de N secondes
ECHECS_MAX, FENETRE_ECHECS = 10, 60  # codes de salle faux tolérés par adresse, par minute
LOT_BOITE = 50                    # messages rendus par appel à /boite
LOT_OCTETS = 8 * 1024 * 1024      # ... et au plus autant d'octets
MAX_PSEUDO, MAX_AVATAR = 20, 4
MAX_SALON = 1000                  # événements gardés dans le salon d'une salle : messages, réactions, votes, coups de jeu (les plus anciens sont effacés)
TTL_MIN, TTL_MAX = 5, 86400       # durée de vie permise pour un message éphémère (secondes)
MAX_DATA_SALON = 12000            # taille maximale d'un message chiffré du salon (caractères base64)
MAX_PUB, MAX_WRAP = 2048, 1400    # clé publique (base64 DER) et clé du salon chiffrée pour un membre (base64)
MAX_EPOQUES = 20                  # époques de clé gardées par membre
ROLES = ("eleve", "admin", "createur")
LOT_SALON = 300                   # événements rendus par appel à /salon
QUOTA_SALON, FENETRE_QUOTA = 20, 10  # au plus 20 envois par membre en 10 s (messages, réactions, votes, coups) : sinon un seul membre fait sortir les autres des MAX_SALON événements gardés

DOSSIER = Path(os.environ.get("APPDATA") or Path.home()) / "MessagerieChiffree" / "relais"
FICHIER_ETAT = DOSSIER / "etat.json"
STATIQUE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "relais_static"

relais_app = FastAPI()
verrou = threading.RLock()
# salles : {code: {"nom", "cree", "membres": {id: {"pseudo", "avatar", "hash", "vu"}}}}
salles = {}
envois_salon = {}  # (code de salle, id du membre) -> instants (monotonic) de ses derniers envois dans le salon ; en mémoire seulement
# boites : {id: {"n": dernier numéro, "msgs": [{"n", "de", "data", "heure", "t"}]}}
boites = {}
echecs = {}   # {adresse: [instants des codes faux]}
_sale = False  # des changements ne sont pas encore écrits sur disque


def maintenant():
    return datetime.now().isoformat(timespec="seconds")


def hash_jeton(jeton):
    return hashlib.sha256(jeton.encode("utf-8")).hexdigest()


def nettoyer(texte, longueur, espaces=True):
    if not isinstance(texte, str):
        return ""
    return "".join(c for c in texte if c.isprintable() and (espaces or not c.isspace())).strip()[:longueur]


def role_de(m):
    return m.get("role") if m.get("role") in ROLES else "eleve"


def est_admin(m):
    return role_de(m) in ("admin", "createur")


def est_local(requete):
    hote = requete.client.host if requete.client else ""
    return hote in ("127.0.0.1", "::1", "localhost") or hote == ip_locale()


def rotation_requise(salle):
    """Un membre est parti depuis la dernière clé : un admin doit en tirer une nouvelle."""
    return salle.get("epoque", 0) >= 1 and salle.get("retraits", 0) > salle.get("retraits_couverts", 0)


def marquer_sale():
    global _sale
    _sale = True


def sauver():
    """Écriture atomique de l'état. À appeler avec le verrou pris."""
    global _sale
    try:
        DOSSIER.mkdir(parents=True, exist_ok=True)
        tmp = FICHIER_ETAT.with_suffix(".tmp")
        tmp.write_text(json.dumps({"salles": salles, "boites": boites}), encoding="utf-8")
        tmp.replace(FICHIER_ETAT)
        _sale = False
    except OSError:
        pass  # l'état reste en mémoire


def charger():
    try:
        d = json.loads(FICHIER_ETAT.read_text(encoding="utf-8"))
        if isinstance(d, dict) and isinstance(d.get("salles"), dict) and isinstance(d.get("boites"), dict):
            salles.update(d["salles"])
            boites.update(d["boites"])
    except (OSError, ValueError):
        pass


def nouveau_code():
    while True:
        code = f"{secrets.randbelow(10**6):06d}"
        if code not in salles:
            return code


def creer_salle(nom, code=None):
    code = code or nouveau_code()
    salles[code] = {"nom": nettoyer(nom, 40) or "Salle de classe", "cree": maintenant(), "membres": {}}
    marquer_sale()
    return code


def ip_locale():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def lien_salle(code):
    return f"mc-relais://{ip_locale()}:{PORT_RELAIS}/{code}"


# --- Authentification --------------------------------------------------------
def membre_authentifie(jeton):
    """(code de salle, id, fiche du membre) pour ce jeton, sinon 401. Verrou pris. Met à jour la présence."""
    if not jeton or len(jeton) > 200:
        raise HTTPException(401, "Jeton manquant ou invalide : rejoins de nouveau la salle.")
    h = hash_jeton(jeton)
    for code, salle in salles.items():
        for mid, m in salle["membres"].items():
            if secrets.compare_digest(m["hash"], h):
                m["vu"] = time.time()
                return code, mid, m
    raise HTTPException(401, "Jeton inconnu : tu as été retiré de la salle ou le relais a changé. Rejoins de nouveau la salle.")


def _maintenant_quota():
    return time.monotonic()


def verifier_quota_salon(code, mid):
    """Fenêtre glissante par membre : lève 429 au-delà de QUOTA_SALON envois en FENETRE_QUOTA secondes. Verrou pris.
    Les envois refusés ne sont pas comptés : on peut reprendre dès que la fenêtre s'est vidée. Le relais ne voit que du chiffré, le quota
    porte donc sur tous les envois du salon, pas seulement sur les coups ou les réactions."""
    t = _maintenant_quota()
    recents = [x for x in envois_salon.get((code, mid), []) if t - x < FENETRE_QUOTA]
    if len(recents) >= QUOTA_SALON:
        envois_salon[(code, mid)] = recents
        attente = max(1, math.ceil(FENETRE_QUOTA - (t - recents[0])))
        raise HTTPException(429, f"Trop d'envois d'affilée : attends {attente} s ({QUOTA_SALON} envois au maximum par {FENETRE_QUOTA} s).",
                            headers={"Retry-After": str(attente)})
    recents.append(t)
    envois_salon[(code, mid)] = recents
    if len(envois_salon) > 5000:  # ménage : membres partis ou silencieux depuis longtemps
        for cle in [k for k, v in envois_salon.items() if not v or t - v[-1] >= FENETRE_QUOTA]:
            del envois_salon[cle]


def trop_d_echecs(adresse):
    maintenant_t = time.time()
    recents = [t for t in echecs.get(adresse, []) if maintenant_t - t < FENETRE_ECHECS]
    echecs[adresse] = recents
    return len(recents) >= ECHECS_MAX


# --- API ---------------------------------------------------------------------
class Rejoindre(BaseModel):
    code: str
    pseudo: str = ""
    avatar: str = ""


class Profil(BaseModel):
    pseudo: str = ""
    avatar: str = ""


class Depot(BaseModel):
    a: str
    data: str


class Acquit(BaseModel):
    jusqua: int


@relais_app.get("/relais/ping")
def ping():
    return {"relais": True, "version": 1}


@relais_app.post("/relais/rejoindre")
def rejoindre(r: Rejoindre, requete: Request):
    adresse = requete.client.host if requete.client else "?"
    code = "".join(r.code.split())
    with verrou:
        if trop_d_echecs(adresse):
            raise HTTPException(429, "Trop d'essais avec un mauvais code : attends une minute.")
        salle = salles.get(code)
        if salle is None:
            echecs.setdefault(adresse, []).append(time.time())
            raise HTTPException(404, "Code de salle inconnu. Vérifie les 6 chiffres affichés au tableau.")
        if len(salle["membres"]) >= MAX_MEMBRES:
            raise HTTPException(409, "La salle est pleine.")
        mid, jeton = secrets.token_hex(8), secrets.token_urlsafe(24)
        # Le créateur est le premier à rejoindre depuis le PC même du relais (le professeur) tant que la salle n'en a pas.
        role = "createur" if est_local(requete) and not any(role_de(x) == "createur" for x in salle["membres"].values()) else "eleve"
        salle["membres"][mid] = {"pseudo": nettoyer(r.pseudo, MAX_PSEUDO), "avatar": nettoyer(r.avatar, MAX_AVATAR, False),
                                 "hash": hash_jeton(jeton), "vu": time.time(), "role": role, "pub": "", "cles": {}}
        boites[mid] = {"n": 0, "msgs": []}
        marquer_sale()
        return {"id": mid, "token": jeton, "salle": {"nom": salle["nom"]}, "role": role}


@relais_app.get("/relais/annuaire")
def annuaire(x_relais_token: str = Header(default="")):
    with verrou:
        code, moi, moi_m = membre_authentifie(x_relais_token)
        salle = salles[code]
        t, epoque, admin = time.time(), salle.get("epoque", 0), est_admin(moi_m)
        membres = []
        for mid, m in salle["membres"].items():
            fiche = {"id": mid, "pseudo": m["pseudo"], "avatar": m["avatar"], "en_ligne": t - m["vu"] < PRESENCE, "role": role_de(m),
                     "a_pub": bool(m.get("pub")), "a_cle": str(epoque) in m.get("cles", {})}
            if admin and m.get("pub"):
                fiche["pub"] = m["pub"]  # seuls les admins en ont besoin (pour chiffrer la clé du salon à leur intention)
            membres.append(fiche)
        return {"salle": {"nom": salle["nom"]}, "moi": moi, "moi_role": role_de(moi_m), "epoque": epoque,
                "retraits": salle.get("retraits", 0), "rotation": rotation_requise(salle), "membres": membres}


@relais_app.post("/relais/profil")
def maj_profil(p: Profil, x_relais_token: str = Header(default="")):
    with verrou:
        _, _, m = membre_authentifie(x_relais_token)
        m["pseudo"], m["avatar"] = nettoyer(p.pseudo, MAX_PSEUDO), nettoyer(p.avatar, MAX_AVATAR, False)
        marquer_sale()
    return {"resultat": "ok"}


@relais_app.post("/relais/envoyer")
def envoyer(d: Depot, x_relais_token: str = Header(default="")):
    if not d.data or len(d.data) > MAX_DATA:
        raise HTTPException(400, "Message vide ou trop gros.")
    with verrou:
        code, moi, _ = membre_authentifie(x_relais_token)
        if d.a not in salles[code]["membres"]:
            raise HTTPException(404, "Destinataire inconnu dans cette salle.")  # jamais d'envoi hors de la salle
        boite = boites.setdefault(d.a, {"n": 0, "msgs": []})
        if len(boite["msgs"]) >= MAX_BOITE or sum(len(x["data"]) for x in boite["msgs"]) + len(d.data) > MAX_OCTETS_BOITE:
            raise HTTPException(507, "La boîte du destinataire est pleine : il doit se connecter pour la vider.")
        boite["n"] += 1
        boite["msgs"].append({"n": boite["n"], "de": moi, "data": d.data, "heure": maintenant(), "t": time.time()})
        marquer_sale()
        return {"n": boite["n"]}


@relais_app.get("/relais/boite")
def lire_boite(apres: int = 0, x_relais_token: str = Header(default="")):
    with verrou:
        _, moi, _ = membre_authentifie(x_relais_token)
        sortie, total = [], 0
        for x in boites.get(moi, {"msgs": []})["msgs"]:
            if x["n"] <= apres:
                continue
            if sortie and (len(sortie) >= LOT_BOITE or total + len(x["data"]) > LOT_OCTETS):
                break
            sortie.append({"n": x["n"], "de": x["de"], "data": x["data"], "heure": x["heure"]})
            total += len(x["data"])
        return {"messages": sortie}


@relais_app.post("/relais/acquitter")
def acquitter(a: Acquit, x_relais_token: str = Header(default="")):
    with verrou:
        _, moi, _ = membre_authentifie(x_relais_token)
        boite = boites.get(moi)
        if boite:
            avant = len(boite["msgs"])
            boite["msgs"] = [x for x in boite["msgs"] if x["n"] > a.jusqua]
            if len(boite["msgs"]) != avant:
                marquer_sale()
    return {"resultat": "ok"}


class MsgSalon(BaseModel):
    data: str
    epoque: int
    ttl: int = 0   # message éphémère : le relais l'efface au bout de ttl secondes (0 = durée normale)


class CiblePub(BaseModel):
    pub: str


class PoserCles(BaseModel):
    epoque: int
    cles: dict[str, str]
    retraits: int = 0


class CibleMsg(BaseModel):
    n: int


class RoleMembre(BaseModel):
    id: str
    role: str


class CibleMembre(BaseModel):
    id: str


@relais_app.post("/relais/salon/pub")
def salon_pub(c: CiblePub, x_relais_token: str = Header(default="")):
    if not c.pub or len(c.pub) > MAX_PUB:
        raise HTTPException(400, "Clé publique invalide.")
    with verrou:
        _, _, m = membre_authentifie(x_relais_token)
        if m.get("pub") != c.pub:
            m["pub"], m["cles"] = c.pub, {}  # nouvelle identité : les anciens exemplaires de la clé ne servent plus
            marquer_sale()
    return {"resultat": "ok"}


@relais_app.get("/relais/salon/cles")
def salon_cles_lire(x_relais_token: str = Header(default="")):
    with verrou:
        code, _, m = membre_authentifie(x_relais_token)
        return {"epoque": salles[code].get("epoque", 0), "cles": dict(m.get("cles", {}))}


@relais_app.post("/relais/salon/cles")
def salon_cles_poser(c: PoserCles, x_relais_token: str = Header(default="")):
    if len(c.cles) > MAX_MEMBRES:
        raise HTTPException(400, "Trop de clés.")
    with verrou:
        code, _, moi = membre_authentifie(x_relais_token)
        if not est_admin(moi):
            raise HTTPException(403, "Seul un admin peut distribuer la clé du salon.")
        salle = salles[code]
        e = salle.get("epoque", 0)
        valides = {mid: w for mid, w in c.cles.items() if mid in salle["membres"] and isinstance(w, str) and 0 < len(w) <= MAX_WRAP}
        if c.epoque == e and e >= 1:  # distribution aux membres qui n'ont pas encore leur exemplaire
            for mid, w in valides.items():
                salle["membres"][mid].setdefault("cles", {}).setdefault(str(e), w)
        elif c.epoque == e + 1:  # première clé du salon (créateur) ou renouvellement (admin)
            if e == 0 and role_de(moi) != "createur":
                raise HTTPException(403, "Seul le créateur de la salle crée la première clé du salon.")
            salle["epoque"] = c.epoque
            for mid, w in valides.items():
                cles = salle["membres"][mid].setdefault("cles", {})
                cles[str(c.epoque)] = w
                for vieille in sorted(cles, key=int)[:-MAX_EPOQUES]:
                    del cles[vieille]
            salle["retraits_couverts"] = max(salle.get("retraits_couverts", 0), min(c.retraits, salle.get("retraits", 0)))
        else:
            raise HTTPException(409, "La clé du salon a déjà changé : réessaie.")
        marquer_sale()
        return {"epoque": salle["epoque"]}


@relais_app.post("/relais/salon/envoyer")
def salon_envoyer(d: MsgSalon, x_relais_token: str = Header(default="")):
    if not d.data or len(d.data) > MAX_DATA_SALON:
        raise HTTPException(400, "Message vide ou trop gros.")
    if d.ttl and not TTL_MIN <= d.ttl <= TTL_MAX:
        raise HTTPException(400, f"Durée de vie d'un message éphémère : de {TTL_MIN} s à 24 h.")
    with verrou:
        code, moi, _ = membre_authentifie(x_relais_token)
        salle = salles[code]
        if salle.get("epoque", 0) < 1:
            raise HTTPException(409, "Le salon n'a pas encore de clé : le créateur doit ouvrir son coffre.")
        if d.epoque != salle["epoque"]:
            raise HTTPException(409, "La clé du salon vient de changer : réessaie dans quelques secondes.")
        verifier_quota_salon(code, moi)
        salle["salon_n"] = int(salle.get("salon_n", 0)) + 1
        msgs = salle.setdefault("salon", [])
        msg = {"n": salle["salon_n"], "de": moi, "epoque": d.epoque, "data": d.data, "heure": maintenant(), "t": time.time()}
        if d.ttl:
            msg["exp"] = msg["t"] + d.ttl
        msgs.append(msg)
        del msgs[:-MAX_SALON]
        marquer_sale()
        return {"n": salle["salon_n"]}


@relais_app.get("/relais/salon")
def salon_lire(apres: int = 0, x_relais_token: str = Header(default="")):
    with verrou:
        code, moi, m = membre_authentifie(x_relais_token)
        salle = salles[code]
        tous = salle.get("salon", [])
        nouveaux = [x for x in tous if x["n"] > apres and not x.get("supprime")]
        nouveaux = nouveaux[-LOT_SALON:] if apres <= 0 else nouveaux[:LOT_SALON]  # première lecture : les plus récents
        return {"moi": moi, "moi_role": role_de(m), "epoque": salle.get("epoque", 0), "dernier": int(salle.get("salon_n", 0)),
                "messages": [{**{k: x[k] for k in ("n", "de", "epoque", "data", "heure", "t")}, **({"exp": x["exp"]} if "exp" in x else {})} for x in nouveaux],
                "supprimes": [x["n"] for x in tous if x.get("supprime")],
                "expires": [x["n"] for x in tous if x.get("supprime") and x.get("expire")],  # effacés parce que leur durée de vie est écoulée
                "horloge": time.time()}  # l'heure du relais : les clients calculent le temps restant d'un message éphémère sans dépendre de leur propre horloge


@relais_app.post("/relais/salon/supprimer")
def salon_supprimer(c: CibleMsg, x_relais_token: str = Header(default="")):
    with verrou:
        code, moi, m = membre_authentifie(x_relais_token)
        msg = next((x for x in salles[code].get("salon", []) if x["n"] == c.n), None)
        if msg is None:
            raise HTTPException(404, "Message introuvable (déjà effacé ?).")
        if msg["de"] != moi and not est_admin(m):
            raise HTTPException(403, "Tu peux supprimer tes messages ; seuls les admins suppriment ceux des autres.")
        msg["supprime"], msg["data"] = True, ""
        marquer_sale()
    return {"resultat": "ok"}


@relais_app.post("/relais/salon/role")
def salon_role(c: RoleMembre, x_relais_token: str = Header(default="")):
    if c.role not in ("admin", "eleve"):
        raise HTTPException(400, "Rôle inconnu.")
    with verrou:
        code, moi, m = membre_authentifie(x_relais_token)
        if role_de(m) != "createur":
            raise HTTPException(403, "Seul le créateur de la salle nomme ou retire les admins.")
        cible = salles[code]["membres"].get(c.id)
        if cible is None:
            raise HTTPException(404, "Membre inconnu.")
        if role_de(cible) == "createur":
            raise HTTPException(400, "Le créateur de la salle ne peut pas changer de rôle.")
        cible["role"] = c.role
        marquer_sale()
    return {"resultat": "ok"}


@relais_app.post("/relais/salon/retirer")
def salon_retirer(c: CibleMembre, x_relais_token: str = Header(default="")):
    with verrou:
        code, moi, m = membre_authentifie(x_relais_token)
        if not est_admin(m):
            raise HTTPException(403, "Seuls les admins retirent un membre de la salle.")
        cible = salles[code]["membres"].get(c.id)
        if cible is None:
            raise HTTPException(404, "Membre inconnu.")
        if c.id == moi:
            raise HTTPException(400, "Pour partir toi-même, utilise « Quitter la salle ».")
        if role_de(m) == "admin" and est_admin(cible):
            raise HTTPException(403, "Un admin ne peut pas retirer un autre admin ni le créateur.")
        retirer_membre(code, c.id)
    return {"resultat": "ok"}


def retirer_membre(code, mid):
    """Verrou pris."""
    if salles[code]["membres"].pop(mid, None) is not None:
        salles[code]["retraits"] = salles[code].get("retraits", 0) + 1  # la clé du salon devra être renouvelée
    boites.pop(mid, None)
    envois_salon.pop((code, mid), None)
    marquer_sale()


@relais_app.post("/relais/quitter")
def quitter(x_relais_token: str = Header(default="")):
    with verrou:
        code, moi, _ = membre_authentifie(x_relais_token)
        retirer_membre(code, moi)
    return {"resultat": "ok"}


# --- Tableau (PC du relais seulement) : code de salle, QR code, liste des élèves -------------
def exiger_local(requete):
    if not est_local(requete):
        raise HTTPException(403, "Le tableau n'est accessible que depuis le PC qui fait tourner le relais.")


@relais_app.get("/")
def accueil():
    return RedirectResponse("/relais/tableau")


@relais_app.get("/relais/tableau", response_class=HTMLResponse)
def tableau(requete: Request):
    exiger_local(requete)
    try:
        return HTMLResponse((STATIQUE / "tableau.html").read_text(encoding="utf-8"))
    except OSError:
        raise HTTPException(500, "Page du tableau introuvable (dossier relais_static).")


@relais_app.get("/relais/qrcode.js")
def qrcode_js(requete: Request):
    exiger_local(requete)
    try:
        return Response((STATIQUE / "qrcode.js").read_bytes(), media_type="application/javascript")
    except OSError:
        raise HTTPException(500, "qrcode.js introuvable.")


@relais_app.get("/relais/tableau.json")
def tableau_json(requete: Request):
    exiger_local(requete)
    return {"salles": info_salles()}


@relais_app.post("/relais/tableau/nouveau-code")
def nouveau_code_salle(requete: Request, code: str = ""):
    """Change le code d'une salle (les membres déjà dans la salle y restent) : utile si le code a fuité."""
    exiger_local(requete)
    return {"code": renouveler_code(code)}


@relais_app.post("/relais/tableau/retirer")
def tableau_retirer(requete: Request, code: str = "", id: str = ""):
    exiger_local(requete)
    with verrou:
        if code not in salles or id not in salles[code]["membres"]:
            raise HTTPException(404, "Membre inconnu.")
        retirer_membre(code, id)
    return {"resultat": "ok"}


# --- Entretien : sauvegarde sur disque et effacement des vieux messages ------------------
def entretien():
    while True:
        time.sleep(5)
        with verrou:
            limite = time.time() - DUREE_MESSAGE
            for b in boites.values():
                avant = len(b["msgs"])
                b["msgs"] = [x for x in b["msgs"] if x["t"] > limite]
                if len(b["msgs"]) != avant:
                    marquer_sale()
            for salle in salles.values():
                for x in salle.get("salon", []):  # messages éphémères arrivés à échéance : le contenu chiffré est effacé du relais
                    if x.get("exp") and x["exp"] <= time.time() and not x.get("supprime"):
                        x["supprime"], x["expire"], x["data"] = True, True, ""
                        marquer_sale()
                anciens = salle.get("salon")
                if anciens and any(x["t"] <= limite for x in anciens):
                    salle["salon"] = [x for x in anciens if x["t"] > limite]
                    marquer_sale()
            if _sale:
                sauver()


# --- Gestion des salles (utilisée par le tableau ET par l'interface du programme) ---------
def info_salles():
    """Les salles avec leur code, leur lien et leurs membres (présence, messages en attente)."""
    t = time.time()
    with verrou:
        return [{"code": code, "nom": s["nom"], "lien": lien_salle(code),
                 "membres": [{"id": mid, "pseudo": m["pseudo"], "avatar": m["avatar"], "en_ligne": t - m["vu"] < PRESENCE, "role": role_de(m),
                              "en_attente": len(boites.get(mid, {"msgs": []})["msgs"])}
                             for mid, m in s["membres"].items()]}
                for code, s in salles.items()]


def renouveler_code(code):
    with verrou:
        if code not in salles:
            raise HTTPException(404, "Salle inconnue.")
        neuf = nouveau_code()
        salles[neuf] = salles.pop(code)
        marquer_sale()
        return neuf


def retirer_eleve(code, mid):
    with verrou:
        if code not in salles or mid not in salles[code]["membres"]:
            raise HTTPException(404, "Membre inconnu.")
        retirer_membre(code, mid)


def supprimer_salle(code):
    """Supprime la salle, ses membres et leurs messages en attente."""
    with verrou:
        if code not in salles:
            raise HTTPException(404, "Salle inconnue.")
        for mid in list(salles[code]["membres"]):
            boites.pop(mid, None)
        del salles[code]
        marquer_sale()


# --- Héberger le relais depuis l'interface (sans ligne de commande) ------------------------
_serveur = None          # uvicorn.Server en cours
_thread_serveur = None
_prepare = False
_verrou_hebergement = threading.Lock()


def preparer():
    """Charge l'état enregistré et lance l'entretien, une seule fois."""
    global _prepare
    with _verrou_hebergement:
        if _prepare:
            return
        _prepare = True
    charger()
    threading.Thread(target=entretien, daemon=True).start()


def heberge():
    return bool(_serveur and _thread_serveur and _thread_serveur.is_alive() and _serveur.started)


def demarrer_hebergement(port=None):
    """Lance le relais dans ce programme. Lève OSError si le port est déjà pris. Renvoie le port."""
    global _serveur, _thread_serveur, PORT_RELAIS
    preparer()
    with _verrou_hebergement:
        if heberge():
            return PORT_RELAIS
        PORT_RELAIS = port or PORT_RELAIS
        config = uvicorn.Config(relais_app, host=os.environ.get("MC_HOTE_RELAIS", "0.0.0.0"), port=PORT_RELAIS, log_level="warning")
        serveur = uvicorn.Server(config)
        fil = threading.Thread(target=serveur.run, daemon=True)
        fil.start()
        fin = time.time() + 8
        while time.time() < fin and not serveur.started and fil.is_alive():
            time.sleep(0.05)
        if not serveur.started:
            serveur.should_exit = True
            raise OSError(f"Impossible de démarrer le relais : le port {PORT_RELAIS} est déjà utilisé "
                          "(un autre relais est peut-être déjà lancé).")
        _serveur, _thread_serveur = serveur, fil
        return PORT_RELAIS


def arreter_hebergement():
    """Arrête le serveur (les salles et les messages en attente restent enregistrés)."""
    global _serveur, _thread_serveur
    with _verrou_hebergement:
        serveur, fil = _serveur, _thread_serveur
        _serveur = _thread_serveur = None
    if serveur:
        serveur.should_exit = True
        fil.join(5)
    with verrou:
        sauver()


def lancer_relais(port=None):
    global PORT_RELAIS
    PORT_RELAIS = port or PORT_RELAIS
    charger()
    with verrou:
        if not salles:
            creer_salle(os.environ.get("MC_NOM_SALLE", "Salle de classe"), os.environ.get("MC_CODE_SALLE") or None)
        sauver()
    threading.Thread(target=entretien, daemon=True).start()
    print("Serveur relais lancé : les messages restent chiffrés de bout en bout, le relais ne peut pas les lire.")
    for code, s in salles.items():
        print(f"  Salle « {s['nom']} » : code {code}   ·   lien : {lien_salle(code)}")
    print(f"  Tableau (code + QR code) : http://localhost:{PORT_RELAIS}/relais/tableau")
    print(f"  Pare-feu : autorise le port {PORT_RELAIS} en TCP. Ferme cette fenêtre pour arrêter le relais.")
    try:
        uvicorn.run(relais_app, host=os.environ.get("MC_HOTE_RELAIS", "0.0.0.0"), port=PORT_RELAIS, log_level="warning")
    except (OSError, SystemExit):
        print(f"\nImpossible de démarrer : le port {PORT_RELAIS} est déjà utilisé.")


if __name__ == "__main__":
    lancer_relais()
