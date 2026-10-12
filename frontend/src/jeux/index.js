/* Point d'entrée des jeux : importer ce fichier inscrit tous les jeux dans le cadre. Pour ajouter un jeu : créer jeux/monjeu.js
   (voir morpion.js comme modèle), l'importer ici, puis ajouter sa carte dans Jeux.jsx (CARTES) et sa validation dans backend/main.py (CHAMPS_JEU). */
import "./morpion.js";
import "./pfc.js";
import "./p4.js";
import "./bn.js";

export { DELAI_FORFAIT, adversaire, appliquerJeu, enregistrerJeu, jeuDefini, joueurDe, listeJeux, ordrePrive, terminer } from "./cadre.js";
export { gagnantMorpion } from "./morpion.js";
export { COUPS_PFC, MANCHES_GAGNANTES, MANCHES_MAX, champsEngagementPfc, departForfait } from "./pfc.js";
export { COLONNES_P4, LIGNES_P4, caseDeChute, gagnantP4, ligneGagnanteP4 } from "./p4.js";
export { CASES_BN, CASES_NAVIRES, NAVIRES_BN, TAILLE_BN, coherente, departForfaitBn, flotteAleatoire, flotteValide, naviresCoules, reponsesDe, reponsesImpossibles } from "./bn.js";
