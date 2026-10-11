/* Point d'entrée des jeux : importer ce fichier inscrit tous les jeux dans le cadre. Pour ajouter un jeu : créer jeux/monjeu.js
   (voir morpion.js comme modèle), l'importer ici, puis ajouter sa carte dans Jeux.jsx (CARTES) et sa validation dans backend/main.py (CHAMPS_JEU). */
import "./morpion.js";
import "./pfc.js";

export { adversaire, appliquerJeu, enregistrerJeu, jeuDefini, joueurDe, listeJeux, ordrePrive, terminer } from "./cadre.js";
export { gagnantMorpion } from "./morpion.js";
export { COUPS_PFC, DELAI_FORFAIT, MANCHES_GAGNANTES, MANCHES_MAX, champsEngagementPfc, departForfait } from "./pfc.js";
