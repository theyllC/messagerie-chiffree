# TODO - Progression de l'implémentation

## État actuel : priorités 1 à 4 terminées, priorité 5 en attente

### Priorité 1 : Améliorer l'historique ✅ COMPLET
- [x] Afficher le nom du contact si disponible dans les entrées d'historique (déjà via `e.pair`)
- [x] Améliorer l'aperçu (`apercu`) pour montrer un résumé du message chiffré (20 premiers caractères + "...")
- [x] Ajouter bouton "Copier le chiffré" sur chaque entrée d'historique
- **Fichiers** : `frontend/src/App.jsx` (fonction `Entree` modifiée)
- **Temps estimé** : 1 heure
- **Modifications** : Aperçu réduit à 20 chars, bouton "Copier le chiffré" ajouté en mode détaillé

### Priorité 2 : Carnet de contacts ✅ COMPLET
- [x] Backend : Dictionnaire IP↔nom + endpoints `/api/contacts` (GET/POST/DELETE/RENAME/VIDER) dans `backend/main.py`
- [x] Frontend : Champ "Nom du PC" dans l'onglet Envoyer + historique affiche le nom à la place de l'IP
- [x] Historique affiche le nom à la place de l'IP quand disponible (via API `/api/contacts`)
- [x] Synchroniser automatiquement le contact quand on envoie un message (le nom saisi est enregistré, les contacts survivent au redémarrage)
- **Fichiers** : `backend/main.py` (terminé), `frontend/src/App.jsx` (terminé), `frontend/src/App.jsx` (composant `Entree`)
- **Temps estimé** : Terminé
- **Modifications** : Backend : 5 nouveaux endpoints ; Frontend : champ nom + historique affiche noms via API

### Priorité 3 : Détection réseau automatique ✅ COMPLET
- [x] Backend : Fonction scan port 5000 + endpoint `/api/decouverte` dans `backend/main.py` (terminé)
- [x] Frontend : Afficher liste des PC détectés dans l'onglet Envoyer (avec bouton Actualiser + select)
- [x] Sélectionner un PC pour remplir automatiquement l'IP (via onChange sur le select)
- **Fichiers** : `backend/main.py` (terminé), `frontend/src/App.jsx` (modifié)
- **Temps estimé** : Terminé
- **Modifications** : Bouton "Actualiser les PC" + dropdown select qui remplit le champ IP

### Priorité 4 : Page « Comment ça marche » ✅ COMPLET
- [x] Créer composant `CommentCaMarche.jsx` ✅ (fichier créé avec étapes pédagogiques)
- [x] Montrer les étapes : Texte → Scrypt → AES → Message chiffré → Réseau ✅ (contenu inclus)
- [x] Ajouter 4ème onglet dans `App.jsx` ✅ (onglet + import + functionChooser mis à jour)
- **Fichiers** : `frontend/src/CommentÇaMarche.jsx`, `frontend/src/App.jsx`
- **Temps estimé** : Terminé
- **Modifications** : Composant pédagogique montrant 4 étapes du chiffrement + nouvel onglet UI

### Priorité 6 : Sécurité et pédagogie ✅ COMPLET
- [x] Coffre de clés chiffré par mot de passe (`backend/main.py`, `/api/coffre/*`)
- [x] Échange de clés automatique (hello/ack ; RSA depuis la priorité 8), code de sécurité à comparer
- [x] Clé par contact : messages « v2 » sans clé à saisir (Envoyer, Recevoir, Historique)
- [x] Démonstration interactive dans « Comment ça marche » (`/api/demo`)
- [x] Test de bout en bout avec deux instances (`backend/tests/test_echange_cles.py`)
- **Idées restantes** : mDNS en plus de la diffusion UDP, confidentialité persistante

### Priorité 7 : Accusés, anti-rejeu, fichiers, notifications ✅ COMPLET
- [x] Accusés de réception envoyé → remis → lu (`statut`, `maj_statut`, trames `remis` / `lu`), « lu » signé HMAC
- [x] Anti-rejeu : empreinte de chaque message conservée (`vus.json`), doublons ignorés
- [x] Conversations : fil de discussion par contact (`/api/conversation`, onglet Conversations)
- [x] Effacement automatique des anciens messages (`/api/parametres`, réglage dans Historique)
- [x] Pièces jointes chiffrées (format v3, `/api/envoyer-fichier`), gros messages rangés dans `fichiers/`
- [x] Notifications du navigateur + son + point dans le titre de l'onglet
- [x] Tests : `backend/tests/test_accuses_fichiers.py`

### Priorité 5 : Mode interception ⏳ EN ATTENTE (optionnel)
- [ ] Vue montrant les messages chiffrés capturés sur le fil
- [ ] Illustrer pourquoi le chiffrement protège même en cas d'interception
- **Fichiers** : `frontend/src/App.jsx` (bascule optionnelle)
- **Temps estimé** : 1-2 heures
- **Note** : Peut réutiliser l'API `/api/recus` existante pour afficher les messages chiffrés

---

## Règles de suivi

### Si je m'arrête en cours de route :
1. **Ne pas fermer le terminal** : Laisser le fichier ouvert
2. **Note la dernière case cochée** : C'est mon point d'arrêt
3. **Reprendre depuis la case suivante** au prochain session
4. **Ne jamais sauter une case** : Même si ça semble rapide, tout noter

### Format de mise à jour
Quand je termine une tâche, je coche la case `[ ]` → `[✅]` et ajoute une note brève sous la section concernée.

### Priorités absolues (ne pas déplacer)
1. Historique (déjà quasi terminé dans le code)
2. Carnet de contacts (résout le problème IP)
3. Détection réseau (rend l'usage fluide)
4. Page « Comment ça marche » (valeur soutenance)

---

## Journal des modifications

### 2026-10-05 - Démarrage
- Création du fichier TODO
- Analyse du codebase existante
- Planification des 5 priorités

---

### 2026-10-05 - Corrections
- Backend : `FastAPI()` créé deux fois (l'endpoint de découverte était perdu), scan réseau réécrit (parallèle, réseau local /24, sans bloquer le serveur), réception par thread avec limite de taille et filtre des données invalides, contacts sauvegardés dans un fichier, modèles Pydantic.
- Frontend : champ clé manquant dans l'onglet Envoyer, `idNom` non défini, `</div>` en trop, onglet Historique jamais affiché, imports manquants et état `useRef` dans la page « Comment ça marche » (fichier renommé sans accent).
- Front recompilé (`frontend/dist`).

### 2026-10-05 - Coffre, échange de clés, démo
- Nouveau format de message v2 (clé du contact), coffre `coffre.json`, demandes en attente dans `echanges.json`.
- Ports et hôte configurables par variables d'environnement (`MC_PORT_SOCKET`, `MC_PORT_WEB`, `MC_HOTE`) pour les tests.

### 2026-10-06 - Accusés, fichiers, notifications
- Interface branchée sur les accusés ✓/✓✓, la conversation, la conservation automatique ; envoi et réception de fichiers ; notifications.
- Le serveur lit désormais jusqu'à 6 Mo par message (pièces jointes) avec un délai total de 30 s ; `historique.json` ne contient plus les gros messages.

### Priorité 8 : Migration vers le RSA ✅ COMPLET
- [x] Identité RSA-3072 dans le coffre ; hello/ack signés RSA-PSS ; clé de contact transportée en RSA-OAEP (SHA-256)
- [x] Clés publiques refusées si < 3072 bits, > 8192 bits ou e ≠ 65537
- [x] Migration automatique des coffres existants : anciennes clés X25519 gardées (anciens messages lisibles), bouton « Passer au RSA »
- [x] Test : `backend/tests/test_rsa.py`
- **Limites** : pas de confidentialité persistante ; ancienne et nouvelle version ne peuvent pas échanger de clés ; génération RSA de quelques secondes

### Priorité 9 : Finitions ✅ COMPLET
- [x] Accusé « remis » signé (HMAC avec la clé du contact), envoyé à l'ouverture du coffre s'il était verrouillé
- [x] Détection par diffusion UDP (port 5001) avec noms d'ordinateur, repli sur le scan TCP (`backend/tests/test_decouverte.py`)
- [x] Fichiers sans clé échangée : format v4 (clé saisie, scrypt)
- [x] Thème sombre (automatique + bascule)
- **Limites** : messages et fichiers à clé saisie : accusé « remis » non signé, pas de « lu » ; la diffusion UDP ne traverse pas les routeurs ni les Wi-Fi qui isolent les appareils

### Priorité 10 : Ergonomie ✅ COMPLET
- [x] Pièce jointe en attente, envoyée avec le message (Envoyer et Conversations)
- [x] Panneau « Mes clés » et libellés clarifiés (`/api/identite`)
- [x] Envoi vers soi-même (127.0.0.1) : l'anti-rejeu ne l'ignore plus

### Priorité 11 : Refonte du front (doctrine frontend-ui-ux) ✅ COMPLET
- [x] Audit visuel (bureau, mobile 375 px et 320 px, thème sombre) ; passe UX précédente conservée (en-tête, groupes, états vides)
- [x] Carte contact : avatar, statut, actions principales (Conversation, Écrire), badge de clé, menu « Gérer » pour les actions rares
- [x] Choix de fichier en français et accessible au clavier ; aide « Comprendre mes clés » repliable ; onglets sur une ligne (défilement sur mobile)
- [x] Vérifié : contrastes ≥ 4,5:1 (clair et sombre), pas de défilement horizontal à 320 px, focus visible, mouvement réduit
- **Idée gardée pour plus tard** : file d'attente des messages pour un destinataire hors ligne

## Sprint 1 ✅ COMPLET (profils, file d'attente, groupe)
- [x] Profils / avatars : `GET/POST /api/profil`, pseudo + avatar dans la détection UDP et les trames hello/ack, `profils` dans `GET /api/contacts`, modale « Mon profil » (grille d'émojis), avatars dans Contacts et Conversations
- [x] File d'attente offline : `expedier` met en file au lieu de renvoyer 502 (statut `attente`), thread de fond toutes les 15 s (`MC_INTERVALLE_FILE`), `GET /api/file-attente`, `POST /api/file-attente/vider`, plafond 50 messages / 20 tentatives (puis statut `echec`), 🕐 dans `Coches`, pastille sur l'onglet Envoyer, bandeau « Annuler les envois »
- [x] Messages de groupe : `POST /api/envoyer-groupe` (v2 sinon v5, un chiffré par destinataire, envois en parallèle), mode « Plusieurs contacts » avec cases à cocher
- Tests : `backend/tests/test_sprint1.py` (3 instances) ; les 7 tests existants passent toujours

## Sprint 2 ✅ COMPLET (serveur relais + code de salle / QR code)
- [x] Serveur relais `backend/relais.py` (lancé par `--relais`) : HTTP + sondage (passe proxys et pare-feux), boîte aux lettres chiffrée par élève, acquittement, purge à 7 jours, limites de taille, état sur disque (redémarrage sans perte)
- [x] Code de salle à 6 chiffres, anti-force-brute (429), jeton par élève (haché côté relais), expéditeur posé par le relais (non falsifiable)
- [x] Tableau du prof `/relais/tableau` (PC du relais seulement) : code, lien, QR code, élèves, « Nouveau code », « Retirer »
- [x] Client : contacts `relais:<id>` (clés, accusés, conversations, groupe, file d'attente inchangés), annuaire de classe avec pseudo/avatar/présence, onglet « Salle de classe »
- [x] Packaging : `build_exe.bat` embarque `relais_static` et `relais.py`
- Tests : `backend/tests/test_sprint2.py` (58 vérifications) ; Sprint 1 et les 7 tests historiques passent toujours
