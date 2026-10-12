/* Cadre commun des jeux à deux (salon de la salle et conversations privées).
   Le cadre gère ce qui est identique pour tous les jeux : le défi, l'acceptation, l'abandon, la fin de partie, et l'ordre des
   événements d'une partie privée. Chaque jeu n'écrit que ses propres règles et s'inscrit avec enregistrerJeu().

   Un jeu fournit :
     id, nom, icone                     identité (id = valeur du champ « j » des événements)
     libelleSalon, libellePrive, ...    textes des boutons de lancement
     salon                              false : jeu réservé aux conversations privées (pas de bouton dans le salon ; voir JEUX_PRIVES dans backend/main.py)
     etatInitial()                      champs propres à la partie (grille, manche, points…)
     actions                            actions de jeu autres que défi / accepte / abandon (ex. ["coup"], ["engage", "revele", "forfait"])
     appliquer(g, ev)                   applique UNE de ces actions ; doit ignorer en silence tout ce qui est illégal
     ordrePrive(e)                      rang d'un événement dans une partie privée (pas de relais pour les numéroter)
     champsPrives(g, a)                 champs de transport en plus pour l'action a d'une partie privée (ex. numéro du coup)
   Règle d'or : appliquer() ne lève jamais d'erreur et ne fait confiance à rien (l'événement vient d'un autre joueur). */

export const DELAI_FORFAIT = 60;  // secondes : au-delà, l'adversaire qui doit agir peut être déclaré forfait (salon seulement : l'heure vient du relais)

const JEUX = Object.create(null);  // sans prototype : un identifiant comme « constructor » ne désigne jamais un jeu

export function enregistrerJeu(def) {
  for (const cle of ["id", "nom", "icone", "etatInitial", "appliquer", "ordrePrive"]) {
    if (!def[cle]) throw new Error(`Jeu mal défini : « ${cle} » manque.`);
  }
  JEUX[def.id] = {
    actions: [],
    libelleSalon: def.nom,
    libellePrive: def.nom,
    sousTitrePrive: "Partie privée à deux",
    salon: true,
    champsPrives: () => ({}),
    ...def,
  };
}

export const jeuDefini = (id) => (typeof id === "string" ? JEUX[id] || null : null);
export const listeJeux = () => Object.values(JEUX);

export const joueurDe = (g, id) => (g.x.id === id ? "x" : g.o && g.o.id === id ? "o" : null);
export const adversaire = (cote) => (cote === "x" ? "o" : "x");

export function terminer(g, gagnant, motif) {
  g.etat = "fini";
  g.gagnant = gagnant;  // "x", "o", "nul" ou "annule"
  if (motif) g.motif = motif;
}

/* Applique un événement « jeu » à la partie correspondante (jeux : Map identifiant de la partie -> partie). Ignore silencieusement
   tout événement illégal : mauvais joueur, mauvais tour, partie finie, jeu inconnu… C'est ce qui rend la triche inutile :
   tous les clients rejettent les mêmes événements. */
export function appliquerJeu(jeux, ev) {
  if (ev.a === "defi") {
    const def = jeuDefini(ev.j);
    // Un défi dont l'identifiant existe déjà est ignoré : sinon, en privé, un contact pourrait renvoyer un défi pour remettre à zéro
    // une partie qu'il est en train de perdre.
    if (def && !jeux.has(ev.n)) jeux.set(ev.n, { n: ev.n, j: ev.j, etat: "attente", x: { id: ev.de, pseudo: ev.pseudo }, o: null, gagnant: null, ...def.etatInitial() });
    return;
  }
  const g = jeux.get(ev.c);
  if (!g || g.j !== ev.j || g.etat === "fini") return;
  const def = jeuDefini(g.j);
  if (!def) return;
  if (ev.a === "accepte") {
    if (g.etat === "attente" && ev.de !== g.x.id) {
      g.o = { id: ev.de, pseudo: ev.pseudo };
      g.etat = "en_cours";
    }
  } else if (ev.a === "abandon") {
    const cote = joueurDe(g, ev.de);
    if (!cote) return;
    terminer(g, g.o ? adversaire(cote) : "annule");
    g.abandon = true;
  } else if (def.actions.includes(ev.a)) {
    def.appliquer(g, ev);
  }
}

/* Parties privées : défi d'abord, acceptation ensuite, puis les actions dans l'ordre propre au jeu. */
export function ordrePrive(e) {
  if (e.a === "defi") return 0;
  if (e.a === "accepte") return 1;
  const def = jeuDefini(e.j);
  return def ? def.ordrePrive(e) : 10000;
}
