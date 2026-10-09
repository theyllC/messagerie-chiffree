# Messagerie chiffrée (React + Python)

Chaque PC lance le même programme. Python s'occupe du réseau, React de l'interface.

## Utilisation (Python seulement, le front est déjà compilé)
    cd backend
    pip install -r requirements.txt
    python main.py
Puis ouvre http://localhost:8000 sur chaque PC.
- Onglet « Recevoir » : affiche l'adresse IP du PC à donner à l'émetteur.
- Onglet « Envoyer » : saisis l'IP de l'autre PC (ou choisis-le dans la liste des PC détectés), un nom facultatif, la clé et le message. Avec une clé échangée, tu peux aussi joindre un fichier (2 Mo maximum).
- Onglet « Historique » : messages chiffrés envoyés et reçus (✓ envoyé, ✓✓ remis, ✓✓ lu) ; saisis la clé pour relire un message à clé manuelle. Un réglage efface automatiquement les messages anciens.
- Onglet « Conversations » : le fil de discussion avec un contact, lisible directement (coffre ouvert), avec envoi de messages et de fichiers.
- Onglet « Contacts » : crée d'abord ton **coffre** (mot de passe), puis clique sur « Échanger les clés » : ton contact accepte, vous comparez le **code de sécurité** (il doit être identique des deux côtés) et vous n'avez plus de clé à saisir. Tu peux aussi ajouter, renommer ou supprimer des contacts, vois qui est en ligne, puis clique sur « Écrire » pour leur envoyer un message.
- Onglet « Comment ça marche » : démonstration interactive avec les vraies valeurs de chaque étape.

## Modifier le front (Node.js requis)
    cd frontend
    npm install
    npm run dev      # http://localhost:5173, avec python main.py lancé à côté
    npm run build    # régénère frontend/dist, servi par Python

Contacts et historique sont enregistrés dans `%APPDATA%\MessagerieChiffree` (ou le dossier personnel hors Windows).

Le coffre (`coffre.json`) est chiffré (AES-256-GCM, clé dérivée par scrypt) : sans le mot de passe, personne ne peut le lire. Mot de passe oublié : « Réinitialiser » supprime le coffre et les clés.
Les clés sont de type RSA-3072 (OAEP pour transporter la clé, PSS pour signer). Limite : l'échange de clés ne protège contre un intrus sur le réseau que si vous comparez le code de sécurité.

## Protections et accusés
- **Anti-rejeu** : un même message chiffré n'est accepté qu'une seule fois (les 5000 derniers sont mémorisés). Un message capturé puis renvoyé est ignoré.
- **Accusés de réception** : « remis » dès que le message est arrivé, « lu » quand le contact l'a déchiffré. L'accusé « lu » est signé avec la clé échangée, un faux est rejeté. L'accusé « remis » n'est pas signé (un intrus sur le réseau pourrait en fabriquer un).
- **Pièces jointes** : chiffrées avec la clé échangée (uniquement), rangées chiffrées dans `fichiers/` à côté de l'historique, 2 Mo maximum.
- **Notifications** : case en haut de la page. Une notification et un son préviennent d'un message reçu quand l'onglet n'est pas au premier plan. Le contenu du message n'y figure jamais.

Tests automatiques (deux instances sur le même PC) : `pip install httpx` puis `python backend/tests/test_echange_cles.py` et `python backend/tests/test_accuses_fichiers.py`, `python backend/tests/test_rsa.py` et `python backend/tests/test_import_cle.py`.

Pare-feu : autorise le port 5000 en TCP (réception des messages) et le port 5001 en UDP (détection automatique des PC du réseau). L'interface web (port 8000)
n'est accessible que depuis le PC lui-même.

## Créer l'exécutable Windows
Lance `build_exe.bat` (Python requis ; compile aussi le front si Node.js est installé).

## Mises à jour automatiques (GitHub Releases)
Plus besoin de renvoyer l'exécutable : l'application cherche toute seule une nouvelle version et propose de l'installer.

**Pour les utilisateurs** : une bannière « Version X disponible » apparaît (avec une notification si elles sont activées). Un clic sur « Mettre à jour » télécharge, vérifie, remplace le programme et le relance ; la page se recharge toute seule. « Plus tard » masque la bannière pour cette version. La ligne « Version … · Rechercher une mise à jour » permet de vérifier à la main. L'ancien exécutable est gardé sous le nom `MessagerieChiffree.exe.old` jusqu'au démarrage suivant. Hors de l'exécutable (`python main.py`), la bannière renvoie vers la page de la version au lieu d'installer.

**Mise en place (une seule fois)**
1. `python tools/signer_release.py --generer` affiche une clé **publique** et une clé **privée**.
2. Dans `backend/mise_a_jour.py`, renseigne `DEPOT` (ex. `moncompte/messagerie-chiffree`) et `CLE_PUBLIQUE_B64` (la clé publique). Tant que ce n'est pas fait, les mises à jour restent désactivées.
3. Sur GitHub : Settings → Secrets and variables → Actions → New repository secret, nom `UPDATE_SIGNING_KEY`, valeur = la clé **privée**. Ne la commite jamais : si elle fuit, régénère la paire et publie une version avec la nouvelle clé publique (les anciennes installations devront être réinstallées une fois à la main).
4. Le dépôt doit être **public** (l'application lit la release sans identifiant). Distribue une première fois l'exécutable publié : à partir de là, tout passe par les mises à jour.

**Publier une version** : `git tag v1.1.0` puis `git push --tags`. Le workflow `.github/workflows/release.yml` lance les tests, compile le front, construit l'exe, signe le manifeste `version.json` et crée la release. Le numéro de version vient du tag et le texte de la bannière du dernier message de commit.

**Sécurité** : le manifeste (version, adresse, SHA-256) est signé en Ed25519 ; l'application refuse toute mise à jour dont la signature ne correspond pas à la clé publique embarquée, dont l'adresse sort du dépôt, ou dont l'empreinte SHA-256 diffère (en cas de refus, rien n'est remplacé). Une version plus ancienne n'est jamais installée. Si la copie échoue, l'ancienne version est remise en place. Test : `python backend/tests/test_maj.py`.

## Nouveautés
- **Détection automatique** : « Détecter les PC du réseau » (Contacts) envoie une diffusion UDP (port 5001) ; chaque PC répond avec son nom d'ordinateur. Si personne ne répond, le programme scanne le réseau /24 comme avant.
- **Fichiers sans échange de clés** : dans l'onglet Envoyer, saisis une clé puis joins le fichier (format v4, AES-256-GCM + scrypt). Ton contact l'ouvre avec la même clé (Recevoir ou Historique).
- **Accusé « remis » signé** pour les messages à clé échangée. Les messages à clé saisie n'ont pas de signature possible.
- **Thème sombre** : automatique selon le système, ou bouton « Thème » en haut à droite.
- **Pièce jointe + message en un seul envoi** : le fichier choisi attend (bouton « Retirer »), puis part avec le message au clic sur « Envoyer » : le fichier d'abord, le message ensuite.
- **On écrit avec une clé, jamais avec un mot de passe** (onglet Envoyer) : la section « Clé utilisée » liste les clés que tu as pour ce contact (clé échangée, clé publique RSA importée) et tu choisis laquelle chiffre le message. Il n'y a plus de clé à saisir à l'envoi ; la clé saisie à la main ne sert plus qu'à relire d'anciens messages dans l'Historique.
- **Mes clés** (onglet dédié) : empreinte de ta clé publique (16 premiers octets du SHA-256, en hexadécimal), taille, date de création, export en `.pem` ou copie. La clé privée n'est jamais envoyée ; elle ne s'affiche que sur demande (bouton « Afficher… »), après nouvelle saisie du mot de passe du coffre, et se masque seule au bout d'une minute. Tous les détails (clé publique, clé privée, import, aide) s'ouvrent dans des fenêtres modales.
- **Import manuel d'une clé publique** (onglet Mes clés) : colle la clé d'un contact (PEM ou base64) ou choisis son `.pem`. Seules les clés RSA d'au moins 3072 bits (e = 65537) sont acceptées. Tu peux ensuite lui écrire en **RSA direct** (format v5) sans aucun échange réseau préalable : une clé AES jetable est chiffrée avec sa clé publique (RSA-OAEP). Limites : l'expéditeur n'est pas authentifié, pas d'accusé « lu », pas de pièce jointe, et tu ne peux pas relire tes propres messages v5 (seul le destinataire a la clé privée). Compare l'empreinte avec celle que ton contact voit chez lui.

- **Clés dans Envoyer et Recevoir** : l'onglet Envoyer a un bloc « Mes clés » (clé publique, clé privée sur demande, bouton « Partager ma clé publique » vers le PC choisi, qui lance l'échange de clés). L'onglet Recevoir montre la clé publique de l'expéditeur du message reçu. Rappel : un message ne se déchiffre jamais avec la clé publique de l'expéditeur ; elle sert à l'identifier et à vérifier ses signatures.

- **Atelier RSA** (onglet Mes clés) : « RSA pas à pas » te laisse choisir deux nombres premiers p et q et montre n, φ(n), e, d, le chiffrement et le déchiffrement avec les vrais nombres, puis simule un attaquant qui factorise n (facile avec de petits nombres, impossible à 3072 bits). Ces nombres ne servent à aucun vrai message. « Créer ma clé depuis mes nombres premiers » construit ta vraie paire RSA à partir de p et q d'au moins 1536 bits (contrôlés par le serveur : primalité, taille, écart entre p et q) ; elle remplace la paire actuelle et exige le mot de passe du coffre.
- **Clé saisie à la main (mode simple)** : maillon faible, à réserver à la démonstration (voir « Protections »). Test : `python backend/tests/test_premiers.py`.
- **Mise en page pleine largeur** : navigation latérale à gauche sur grand écran (onglets qui passent à la ligne sur petit écran, sans barre de défilement), contenu fluide et formulaires Envoyer, Recevoir et Mes clés en deux colonnes.
- **Animations** : fond de chiffres hexadécimaux en profondeur, cube 3D (n, e, d, p, q, φ) que l'on peut faire tourner à la souris, texte chiffré qui se matérialise, transitions d'onglets, de cartes et de modaux. Tout est désactivé si le système demande de réduire les animations.

## Salle de classe : serveur relais (Sprint 2)
Sans relais, chaque PC contacte l'autre directement par son IP : les deux doivent être allumés en même temps, sur le même réseau. Avec un **relais**, un PC de la salle (celui du prof) garde les messages **chiffrés** dans une boîte aux lettres par élève ; chacun les récupère quand il se connecte.

**Côté prof** : `python backend/main.py --relais` (option `--port-relais=8100`). La console affiche le **code de salle à 6 chiffres** et le lien `mc-relais://adresse:8100/123456`. La page `http://localhost:8100/relais/tableau` (visible seulement depuis ce PC) l'affiche en grand avec un **QR code**, la liste des élèves, « Nouveau code » et « Retirer ». Autorise le port **8100 en TCP** dans le pare-feu. Variables utiles : `MC_CODE_SALLE` (code imposé), `MC_NOM_SALLE`, `MC_PORT_RELAIS`. Le prof peut aussi lancer son interface normale, dans un autre terminal, pour écrire lui-même.

**Salon de la salle (chiffré de bout en bout)** : dès qu'un membre (élève ou créateur) a rejoint la salle, l'onglet « Salle de classe » ouvre par défaut le **Salon**, un fil commun à tous les membres (rafraîchi toutes les 2 s, 1000 caractères par message, 300 messages conservés 7 jours).
- **Chiffrement** : le programme du **créateur** tire au hasard une clé AES-256 pour le salon, puis la chiffre (RSA-OAEP) avec la clé publique de chaque membre. Le relais ne stocke que ces exemplaires chiffrés et des messages AES-256-GCM : il ne connaît jamais la clé. Chaque message est lié à son expéditeur et à la période de clé (données associées), la citation d'une réponse est à l'intérieur du message chiffré. Il faut un **coffre créé et ouvert** : la clé n'est gardée qu'en mémoire, jamais sur disque, et disparaît quand le coffre est verrouillé.
- **Renouvellement** : la clé change (période + 1) dès qu'un membre quitte la salle ou en est retiré, un admin connecté s'en charge. Un membre arrivé après ne peut pas relire ce qui précède son arrivée ; un membre retiré n'a plus accès au relais.
- **Rôles** : le **créateur** (le premier à rejoindre depuis le PC du relais) est admin de base et seul à pouvoir **nommer ou retirer un admin** (onglet « Élèves »). Un **admin** peut supprimer n'importe quel message et retirer un élève ; un **élève** supprime ses propres messages.
- **Répondre** : le bouton « Répondre » d'un message affiche la citation au-dessus du champ de saisie ; un clic sur la citation dans le fil renvoie au message d'origine.
- Limite connue : les clés publiques des membres passent par le relais ; un relais malveillant pourrait en substituer une (attaque de l'homme du milieu). Comme le relais tourne sur le PC du professeur, c'est le même cercle de confiance que la salle.
- Test : `python backend/tests/test_salon.py`. Le sous-onglet « Élèves » donne l'annuaire pour les messages privés (échange de clés puis conversation chiffrée).

**Côté élève** : onglet « Salle de classe », saisir l'adresse du relais et le code (ou coller le lien `mc-relais://…`). Les élèves apparaissent dans l'annuaire avec leur pseudo, leur avatar et leur présence ; « Ajouter » les met au carnet, puis échange de clés et code de sécurité comme d'habitude. Tout le reste (conversations, fichiers, envoi groupé, file d'attente, accusés) fonctionne sans changement, y compris vers un élève absent : le message l'attend dans sa boîte (7 jours maximum).

**Ce que voit le relais** : qui est dans la salle, qui écrit à qui, l'heure et la taille des messages. **Ce qu'il ne peut pas faire** : lire un message (les clés ne lui sont jamais envoyées). **Limites** : le trafic client-relais est en HTTP (le code de salle et le jeton passent en clair sur le réseau local) ; un relais malveillant pourrait remplacer des clés publiques pendant l'échange, d'où l'importance de **comparer le code de sécurité à voix haute**. Les essais de code sont limités (10 mauvais codes par minute et par adresse).

Test : `python backend/tests/test_sprint2.py` (relais + 3 élèves sur ce PC).

## Salon : réactions, sondages, éphémères, morpion
Tout passe par le salon chiffré existant : ce sont des **événements** chiffrés avec la même clé AES que les messages. Le relais ne voit toujours que du chiffré (pas d'emoji, pas de question de sondage, pas de coup de jeu en clair) et n'a aucune règle de jeu à connaître.
- **Réactions** : 👍 ❤️ 😂 😮 😢 🎉 🔥 👀 sous chaque message ; un clic ajoute ou retire la sienne.
- **Sondages** : 📊 une question, 2 à 6 options. Un vote par personne, modifiable. Les votes sont **visibles de la salle** (ce n'est pas un vote secret : voir « vote anonyme vérifiable » dans les idées suivantes).
- **Messages éphémères** : 💨 choisis une durée (10 s, 1 min, 1 h, 24 h) avant d'envoyer. Le relais **efface le contenu chiffré** à l'échéance et les clients le masquent dès la fin du compte à rebours. Limite : quelqu'un a pu lire ou copier le message avant, et un relais malveillant pourrait ne pas l'effacer (les clients le masquent quand même).
- **Morpion** : ⭕ « Défi morpion » publie un défi dans le salon ; le premier qui le relève joue contre toi, les autres regardent. Pas de serveur de jeu : chaque client **rejoue la même suite d'événements** (ordonnée par le numéro du relais) et applique les mêmes règles ; un coup illégal (mauvais tour, case prise, tiers) est ignoré par tout le monde, donc tricher est inutile.
- Les événements d'un type inconnu ou mal formé sont ignorés (compatible avec les versions futures). Le salon garde désormais 1000 événements (au lieu de 300 messages).
- Tests : `python backend/tests/test_salon_jeux.py` (relais + 3 clients) et `node frontend/tests/salonEvenements.test.mjs` (règles et état dérivé, sans réseau).

## Parties privées à deux (onglet Conversations)
Le morpion se joue aussi en **1 contre 1 avec un contact**, sans salle ni relais : « ⭕ Défier au morpion » dans une conversation (clés échangées nécessaires).
- Chaque action (défi, acceptation, coup, abandon) est un **message v2 ordinaire** chiffré avec la clé échangée, dont le texte commence par un marqueur de jeu. Il n'apparaît pas comme bulle de texte ; Historique et Recevoir affichent « Coup de jeu » au lieu du JSON.
- **Pas de numéro de relais pour ordonner** : chaque coup porte son numéro dans la partie (`s`). Les coups sont rejoués dans cet ordre, donc la file d'attente ou une reconnexion ne changent pas le résultat ; un coup au mauvais numéro (rejeu, doublon) est ignoré.
- Le contact peut être **hors ligne** : le coup attend dans la file d'attente et part dès que son PC est joignable (partie « par correspondance »).
- Limite : une partie vit dans l'historique des messages ; si l'effacement automatique supprime ses coups, la partie disparaît.
- Tests : `python backend/tests/test_jeu_prive.py` (deux instances, échange de clés, partie complète) et `node frontend/tests/salonEvenements.test.mjs`.

## Pierre-feuille-ciseaux avec engagement (salon et conversations privées)
Boutons « ✊ Pierre-feuille-ciseaux » dans le salon et dans une conversation. Première à 2 manches, les égalités se rejouent.
**Le problème** : si je joue en premier et que mon coup est visible, l'autre choisit le coup gagnant. S'il joue en premier, c'est l'inverse. Sans arbitre, qui joue le premier ?
**La solution, un schéma d'engagement** (commit-reveal) :
1. **Engagement** : chacun publie `SHA-256(partie | manche | coup | sel)`, le **sel** étant 128 bits aléatoires tirés par son navigateur. Cette empreinte ne révèle rien (le sel empêche d'essayer les 3 coups pour la retrouver) mais ne laisse plus changer d'avis (impossible de trouver un autre coup donnant la même empreinte).
2. **Révélation** : quand les deux empreintes sont publiées, chacun envoie son coup et son sel (automatiquement). **Chaque client recalcule l'empreinte** : si elle ne correspond pas à l'engagement, la révélation est refusée et la partie est perdue (« a triché »).
- La partie et la manche sont dans l'empreinte : un engagement ne se réutilise ni dans une autre manche ni dans une autre partie. Un second engagement dans la même manche est ignoré.
- Le coup et le sel restent dans le navigateur (`localStorage`) entre l'engagement et la révélation ; si on les efface en cours de manche, on ne peut plus révéler (l'interface propose d'abandonner).
- **Limite** : l'engagement protège contre le changement de coup, pas contre l'abandon (quelqu'un qui voit qu'il perd peut refuser de révéler : il faut alors « Abandonner »). Il n'y a pas de minuteur pour l'instant.
- Moteur : `frontend/src/salonEvenements.js` (règles) et `frontend/src/sha256.js` (SHA-256 synchrone, vérifié contre `node:crypto`). Tests : `node frontend/tests/sha256.test.mjs`, `node frontend/tests/salonEvenements.test.mjs` (tentatives de triche comprises) et `python backend/tests/test_jeu_prive.py` (partie jouée par l'API, engagements calculés en Python, rejoués par le moteur JavaScript).
