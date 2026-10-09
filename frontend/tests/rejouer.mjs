// Rejoue des événements de jeu rendus par l'API (JSON sur l'entrée standard) avec le vrai moteur et affiche les parties.
// Utilisé par backend/tests/test_jeu_prive.py : vérifie que Python (hashlib) et JavaScript s'accordent sur les engagements.
import { deriverPrive } from "../src/salonEvenements.js";
let texte = "";
for await (const bloc of process.stdin) texte += bloc;
console.log(JSON.stringify(deriverPrive(JSON.parse(texte))));
