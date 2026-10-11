"""Test de la validation des événements de jeu (cadre commun du salon et des parties privées), sans lancer de serveur.
Vérifie : un événement mal formé est refusé proprement (jamais d'exception : un membre malveillant ne doit pas pouvoir faire échouer la
lecture du salon pour les autres), les champs de chaque jeu, les différences salon / privé, et la brique d'engagement.
Prérequis : les dépendances de l'application (pip install -r requirements.txt)  ·  Lancer : python backend/tests/test_validation_jeux.py
"""
import json
import os
import sys
import tempfile

os.environ["APPDATA"] = tempfile.mkdtemp()  # l'application range ses fichiers là : on ne touche pas aux vrais
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import main  # noqa: E402

ok_global = True
H, X = "ab" * 32, "cd" * 16
G = "abcd1234"


def check(nom, cond, extra=""):
    global ok_global
    ok_global &= bool(cond)
    print(("OK   " if cond else "ECHEC"), nom, extra)


salon = lambda **d: main.assainir_evenement("jeu", d)
prive = lambda **d: main.assainir_jeu_prive(d)

# ---- jamais d'exception, même avec des types piégés
pieges = [None, True, 1.5, [], [1], {}, {"a": 1}, "", "x" * 500, -1, 10**30]
exceptions = 0
for v in pieges:
    for champ in ("j", "a", "c", "g", "i", "s", "r", "h", "m", "x"):
        base = {"j": "morpion", "a": "coup", "c": 1, "g": G, "i": 0, "s": 0, "r": 0, "h": H, "m": "p", "x": X}
        for jeu in ("morpion", "pfc"):
            for action in ("defi", "accepte", "coup", "abandon", "engage", "revele", "forfait"):
                d = {**base, "j": jeu, "a": action, champ: v}
                for f in (lambda: main.assainir_evenement("jeu", d), lambda: main.assainir_jeu_prive(d)):
                    try:
                        f()
                    except Exception:
                        exceptions += 1
check("types piégés (liste, dict, booléen, énorme…) : refus propre, aucune exception", exceptions == 0, f"{exceptions} exceptions")
check("jeu donné sous forme de liste : refusé (salon et privé)", salon(j=[], a="defi") is None and prive(j=[], a="defi", g=G) is None)
check("jeu « __proto__ » ou « constructor » : refusé", all(salon(j=j, a="defi") is None for j in ("__proto__", "constructor")))

# ---- morpion, salon
check("salon morpion : défi sans identifiant de partie", salon(j="morpion", a="defi") == {"j": "morpion", "a": "defi"})
check("salon morpion : acceptation et abandon portent la partie visée", salon(j="morpion", a="accepte", c=5) == {"j": "morpion", "a": "accepte", "c": 5} and salon(j="morpion", a="abandon", c=5) == {"j": "morpion", "a": "abandon", "c": 5})
check("salon morpion : coup valide", salon(j="morpion", a="coup", c=5, i=8) == {"j": "morpion", "a": "coup", "c": 5, "i": 8})
check("salon morpion : case hors grille refusée", salon(j="morpion", a="coup", c=5, i=9) is None and salon(j="morpion", a="coup", c=5, i=-1) is None and salon(j="morpion", a="coup", c=5) is None)
check("salon morpion : pas d'engagement, de révélation ni de forfait", all(salon(j="morpion", a=a, c=5, r=0, h=H, m="p", x=X) is None for a in ("engage", "revele", "forfait")))
check("salon : action hors défi sans partie visée refusée", salon(j="morpion", a="coup", i=1) is None and salon(j="pfc", a="accepte") is None)
check("salon : une action inconnue est refusée", salon(j="morpion", a="triche", c=5) is None)
check("salon : un booléen n'est pas un entier", salon(j="morpion", a="coup", c=True, i=1) is None and salon(j="morpion", a="coup", c=5, i=True) is None)

# ---- pierre-feuille-ciseaux, salon
check("salon pfc : engagement valide", salon(j="pfc", a="engage", c=5, r=0, h=H) == {"j": "pfc", "a": "engage", "c": 5, "r": 0, "h": H})
check("salon pfc : empreinte non hexadécimale, majuscule ou trop courte refusée", all(salon(j="pfc", a="engage", c=5, r=0, h=h) is None for h in ("Z" * 64, H.upper(), "ab" * 31)))
check("salon pfc : révélation valide", salon(j="pfc", a="revele", c=5, r=2, m="f", x=X) == {"j": "pfc", "a": "revele", "c": 5, "r": 2, "m": "f", "x": X})
check("salon pfc : coup inconnu ou sel mal formé refusés", salon(j="pfc", a="revele", c=5, r=0, m="z", x=X) is None and salon(j="pfc", a="revele", c=5, r=0, m="p", x="12") is None)
check("salon pfc : manche absente ou hors limite refusée", salon(j="pfc", a="engage", c=5, h=H) is None and salon(j="pfc", a="engage", c=5, r=10, h=H) is None and salon(j="pfc", a="forfait", c=5, r=-1) is None)
check("salon pfc : forfait valide (la manche suffit)", salon(j="pfc", a="forfait", c=5, r=0) == {"j": "pfc", "a": "forfait", "c": 5, "r": 0})
check("salon pfc : pas de « coup » (on s'engage puis on révèle)", salon(j="pfc", a="coup", c=5, i=0) is None)

# ---- privé
check("privé : identifiant de partie obligatoire et bien formé", prive(j="morpion", a="defi") is None and all(prive(j="morpion", a="defi", g=g) is None for g in ("ABCD1234", "abcd123", "abcd12345", "../../etc", 5)))
check("privé : défi valide", prive(j="morpion", a="defi", g=G) == {"j": "morpion", "a": "defi", "g": G})
check("privé morpion : un coup porte son numéro s et sa case i", prive(j="morpion", a="coup", g=G, s=2, i=4) == {"j": "morpion", "a": "coup", "g": G, "s": 2, "i": 4})
check("privé morpion : coup ou abandon sans numéro refusé, numéro hors limite refusé", all(prive(**d) is None for d in (
    {"j": "morpion", "a": "coup", "g": G, "i": 4}, {"j": "morpion", "a": "abandon", "g": G}, {"j": "morpion", "a": "coup", "g": G, "s": 10, "i": 4}, {"j": "morpion", "a": "coup", "g": G, "s": -1, "i": 4})))
check("privé morpion : abandon avec son numéro", prive(j="morpion", a="abandon", g=G, s=3) == {"j": "morpion", "a": "abandon", "g": G, "s": 3})
check("privé : jamais de forfait (rien pour dater un retard entre deux contacts)", prive(j="pfc", a="forfait", g=G, r=0) is None)
check("privé morpion : pas d'engagement ni de révélation", prive(j="morpion", a="engage", g=G, r=0, h=H) is None and prive(j="morpion", a="revele", g=G, r=0, m="p", x=X) is None)
check("privé pfc : engagement et révélation valides", prive(j="pfc", a="engage", g=G, r=1, h=H) == {"j": "pfc", "a": "engage", "g": G, "r": 1, "h": H} and prive(j="pfc", a="revele", g=G, r=1, m="c", x=X) is not None)
check("privé pfc : pas de numéro de coup, pas de « coup »", prive(j="pfc", a="coup", g=G, s=0, i=0) is None)
check("privé : le JSON envoyé garde l'ordre j, a, g, puis les champs du jeu", json.dumps(prive(j="morpion", a="coup", g=G, s=3, i=4)) == '{"j": "morpion", "a": "coup", "g": "abcd1234", "s": 3, "i": 4}')

# ---- brique d'engagement et registre
check("brique : empreinte_valide (64 hexa minuscules)", main.empreinte_valide(H) and not main.empreinte_valide(H.upper()) and not main.empreinte_valide(None) and not main.empreinte_valide("ab" * 31))
check("brique : sel_valide (32 hexa minuscules)", main.sel_valide(X) and not main.sel_valide("cd" * 15) and not main.sel_valide(12) and not main.sel_valide(X.upper()))
check("registre : chaque jeu a sa validation et sa grille", set(main.CHAMPS_JEU) == set(main.JEUX_SALON) == {"morpion", "pfc"})

print("\nTOUT EST OK" if ok_global else "\nIL Y A DES ECHECS")
sys.exit(0 if ok_global else 1)
