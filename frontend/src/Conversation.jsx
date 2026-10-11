import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, post, erreur, info } from "./api.js";
import { Avatar, Coches, Fichier, MAX_FICHIER, envoyerFichier, formatTaille } from "./composants.jsx";
import { CartePartie } from "./Jeux.jsx";
import { jeuDefini, listeJeux } from "./jeux/index.js";
import { deriverPrive } from "./salonEvenements.js";

function PieceJointe({ id, taille }) {
  const [fichier, setFichier] = useState(null);
  const [message, setMessage] = useState(null);

  async function ouvrir() {
    try {
      const r = await post("/api/dechiffrer", { id, cle: "" });
      setFichier(r.fichier);
      setMessage(null);
    } catch (e) {
      setMessage(e.message);
    }
  }

  if (fichier) return <Fichier f={fichier} />;
  return (
    <div>
      <span>Pièce jointe chiffrée ({formatTaille(taille)})</span>{" "}
      <button type="button" className="lien" onClick={ouvrir}>Déchiffrer</button>
      {message && <p className="statut erreur" role="status">{message}</p>}
    </div>
  );
}

/* Fil de discussion avec un contact. Les textes sont déchiffrés en mémoire à chaque affichage, jamais enregistrés. */
export default function Conversation({ contacts, profils = {}, monProfil = {}, echanges, entrees, actif, choix, onEnvoye }) {
  const [ip, setIp] = useState("");
  const [fil, setFil] = useState({ messages: [], jeux: [], ouvert: false });
  const [texte, setTexte] = useState("");
  const [statut, setStatut] = useState(null);
  const [enCours, setEnCours] = useState(false);
  const [fichier, setFichierJoint] = useState(null);  // pièce jointe choisie, envoyée avec le message
  const [recherche, setRecherche] = useState("");
  const [reponse, setReponse] = useState(null);  // message auquel on répond : { moi, x }
  const [surligne, setSurligne] = useState(null);
  const [menuPlus, setMenuPlus] = useState(false);
  const [chiffres, setChiffres] = useState({});  // {ip: true} : affichage du texte chiffré au lieu du texte lisible (par conversation)
  const refFichier = useRef(null);
  const refMenu = useRef(null);
  const refPlus = useRef(null);
  const [enLigne, setEnLigne] = useState({});  // {ip: bool} : le programme est-il ouvert sur son PC ?
  const bas = useRef(null);
  const zoneTexte = useRef(null);
  const idChoix = useId();
  const idTexte = useId();
  const idFichier = useId();

  const extrait = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 140);
  function repondreA(m) {
    setReponse({ moi: m.sens === "envoye", x: extrait(m.clair) });
    zoneTexte.current?.focus();
  }
  // Retrouve le message cité dans le fil (par son début de texte) et le met en évidence un instant
  function allerA(rep) {
    const cible = [...fil.messages].reverse().find((m) => m.clair && extrait(m.clair) === rep.x);
    if (!cible) return;
    document.getElementById(`msg-${cible.id}`)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setSurligne(cible.id);
    setTimeout(() => setSurligne(null), 1500);
  }

  // Le menu « + » se ferme au clic ailleurs ou avec Échap
  useEffect(() => {
    if (!menuPlus) return undefined;
    const dehors = (e) => { if (!refMenu.current?.contains(e.target) && !refPlus.current?.contains(e.target)) setMenuPlus(false); };
    const clavier = (e) => { if (e.key === "Escape") { setMenuPlus(false); refPlus.current?.focus(); } };
    document.addEventListener("mousedown", dehors);
    document.addEventListener("keydown", clavier);
    refMenu.current?.querySelector("button")?.focus();
    return () => { document.removeEventListener("mousedown", dehors); document.removeEventListener("keydown", clavier); };
  }, [menuPlus]);
  useEffect(() => { setMenuPlus(false); }, [ip]);
  const defier = (jeu) => { setMenuPlus(false); jouer({ j: jeu, a: "defi" }); };
  const chiffre = Boolean(chiffres[ip]);
  const basculerChiffre = () => setChiffres((c) => ({ ...c, [ip]: !c[ip] }));

  function choisirFichier(ev) {
    const f = ev.target.files[0];
    ev.target.value = "";  // permet de rechoisir le même fichier
    if (!f) return;
    if (f.size > MAX_FICHIER) { setStatut(erreur(`Fichier trop gros (${formatTaille(MAX_FICHIER)} maximum).`)); return; }
    setStatut(null);
    setFichierJoint(f);
  }

  useEffect(() => { if (choix) setIp(choix.ip); }, [choix]);

  const interlocuteurs = [...new Set([...Object.keys(contacts), ...entrees.map((e) => e.pair)])];
  const nomDe = (adresse) => (contacts[adresse] ? `${contacts[adresse]} (${adresse})` : adresse);
  const nomCourt = (adresse) => profils[adresse]?.pseudo || contacts[adresse] || adresse;

  // Liste façon messagerie : le contact le plus récent en premier, avec le sens du dernier échange (le contenu reste chiffré tant qu'on n'ouvre pas la conversation).
  const lignes = useMemo(() => {
    const dernier = {};
    for (const e of entrees) if (!dernier[e.pair] || e.heure > dernier[e.pair].heure) dernier[e.pair] = e;
    const q = recherche.trim().toLowerCase();
    return interlocuteurs
      .filter((a) => !q || nomCourt(a).toLowerCase().includes(q) || a.includes(q))
      .map((a) => ({ ip: a, dernier: dernier[a] }))
      .sort((x, y) => (y.dernier?.heure || "").localeCompare(x.dernier?.heure || "") || nomCourt(x.ip).localeCompare(nomCourt(y.ip), "fr"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entrees, contacts, profils, recherche]);
  const heureCourte = (h) => {
    if (!h) return "";
    const auj = new Date();
    const jour = `${auj.getFullYear()}-${String(auj.getMonth() + 1).padStart(2, "0")}-${String(auj.getDate()).padStart(2, "0")}`;
    return h.slice(0, 10) === jour ? h.slice(11, 16) : `${h.slice(8, 10)}/${h.slice(5, 7)}`;
  };

  // Qui est en ligne : vérifié à l'ouverture de l'onglet puis toutes les 20 s
  useEffect(() => {
    if (!actif) return undefined;
    let vivant = true;
    const verifier = () => api("/api/statut-contacts").then((r) => vivant && setEnLigne(r.statuts || {})).catch(() => {});
    verifier();
    const id = setInterval(verifier, 20000);
    return () => { vivant = false; clearInterval(id); };
  }, [actif]);
  const profilContact = profils[ip];
  const cle = echanges.cles[ip];

  // La zone de saisie grandit avec le texte (6 lignes au plus), puis défile.
  useEffect(() => {
    const z = zoneTexte.current;
    if (!z) return;
    z.style.height = "auto";
    z.style.height = `${Math.min(z.scrollHeight, 168)}px`;
  }, [texte, ip, cle]);

  const charger = useCallback(() => {
    if (!ip) return;
    api(`/api/conversation?ip=${encodeURIComponent(ip)}`).then(setFil).catch(() => {});
  }, [ip]);

  // Le fil se met à jour tout seul tant que l'onglet est ouvert
  useEffect(() => {
    if (!actif || !ip) return undefined;
    setFil({ messages: [], jeux: [], ouvert: false });
    setReponse(null);
    charger();
    const id = setInterval(charger, 3000);
    return () => clearInterval(id);
  }, [actif, ip, charger]);

  useEffect(() => { bas.current?.scrollIntoView?.({ block: "end" }); }, [fil.messages.length]);

  // Parties privées : les coups sont des messages chiffrés avec la clé échangée ; la partie est reconstituée ici, à chaque lecture du fil.
  const parties = useMemo(() => deriverPrive(fil.jeux || []), [fil.jeux]);
  const nomJoueur = (j) => (j.id === "moi" ? "Toi" : profilContact?.pseudo || contacts[ip] || "Ton contact");

  // Ajoute à une action de carte ce que le transport privé attend : le jeu, l'identifiant de la partie, et le numéro du coup (morpion).
  const actionPrivee = (g, a) => (a.a === "defi" ? { ...a, j: g.j } : { ...a, j: g.j, g: g.n, ...jeuDefini(g.j)?.champsPrives(g, a.a) });

  async function jouer(a) {
    setStatut(null);
    try {
      const r = await post("/api/conversation/jeu", { ip, ...a });
      if (r.statut === "attente") setStatut(info("Contact hors ligne : ton coup partira dès que son PC sera joignable."));
      charger();
      onEnvoye();
    } catch (e) {
      setStatut(erreur(e.message));
    }
  }

  async function envoyer(ev) {
    ev?.preventDefault();
    if ((!texte.trim() && !fichier) || enCours) return;
    setEnCours(true);
    let fichierPart = false;
    let enAttente = false;
    try {
      // Le fichier part d'abord, puis le message
      if (fichier) {
        const f = await envoyerFichier({ ip, nom: contacts[ip] || "", fichier, manuel: false, cle: "" });
        enAttente = f.statut === "attente";
        fichierPart = true;
        setFichierJoint(null);
      }
      if (texte.trim()) {
        const r = await post("/api/envoyer", { ip, message: texte, contact_cle: true, nom: contacts[ip] || "", ...(reponse ? { reponse: { s: reponse.moi ? 1 : 0, x: reponse.x } } : {}) });
        enAttente = enAttente || r.statut === "attente";
      }
      setTexte("");
      setReponse(null);
      setStatut(enAttente ? info("Contact hors ligne : message en file d'attente, il partira dès que son PC sera joignable.") : null);
      charger();
      onEnvoye();
    } catch (e) {
      setStatut(erreur(fichierPart ? `Le fichier est parti, mais pas le message : ${e.message}` : e.message));
      if (fichierPart) { charger(); onEnvoye(); }
    } finally {
      setEnCours(false);
    }
  }

  const cleOk = Boolean(cle);
  return (
    <div className="panneau chat">
      {echanges.etat !== "ouvert" && (
        <p className="note">Coffre verrouillé : déverrouille-le dans l'onglet Contacts pour lire et écrire ici.</p>
      )}

      <div className={`chat-app${ip ? " ouvert" : ""}`}>
        <aside className="chat-liste" aria-label="Contacts">
          <div className="chat-liste-tete">
            <h2 id={idChoix}>Discussions</h2>
            <input type="search" className="chat-recherche" placeholder="Rechercher un contact" aria-label="Rechercher un contact"
                   value={recherche} onChange={(e) => setRecherche(e.target.value)} />
          </div>
          <ul className="chat-contacts" aria-labelledby={idChoix}>
            {lignes.length === 0 && <li className="note chat-vide-liste">{interlocuteurs.length ? "Aucun contact trouvé." : "Aucun contact pour l'instant : ajoute-en dans l'onglet Contacts."}</li>}
            {lignes.map(({ ip: a, dernier }) => (
              <li key={a}>
                <button type="button" className={`chat-contact${a === ip ? " actif" : ""}`} aria-current={a === ip ? "true" : undefined} onClick={() => setIp(a)}>
                  <span className="chat-avatar">
                    <Avatar profil={profils[a]} nom={nomCourt(a)} />
                    {enLigne[a] && <span className="point-ligne" title="En ligne" />}
                  </span>
                  <span className="chat-contact-texte">
                    <span className="chat-contact-ligne">
                      <strong>{nomCourt(a)}</strong>
                      <time>{heureCourte(dernier?.heure)}</time>
                    </span>
                    <span className="chat-contact-apercu">
                      {dernier ? <>{dernier.sens === "envoye" ? "↗ Envoyé" : "↙ Reçu"} · message chiffré</> : echanges.cles[a] ? "🔒 Clés échangées" : "Pas encore de message"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="chat-principal" aria-label="Conversation">
          {!ip ? (
            <div className="chat-vide">
              <span className="chat-vide-icone" aria-hidden="true">💬</span>
              <h3>Messagerie chiffrée</h3>
              <p className="note">Choisis un contact à gauche pour ouvrir la conversation.</p>
            </div>
          ) : (
            <>
              <header className="chat-entete">
                <button type="button" className="chat-retour" aria-label="Retour aux discussions" onClick={() => setIp("")}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <span className="chat-avatar"><Avatar profil={profilContact} nom={nomCourt(ip)} />{enLigne[ip] && <span className="point-ligne" />}</span>
                <div className="chat-entete-texte">
                  <strong>{nomCourt(ip)}</strong>
                  <span>{enLigne[ip] ? "En ligne" : "Hors ligne"} · {ip}{chiffre ? " · affichage chiffré" : cleOk ? " · 🔒 clés échangées" : ""}</span>
                </div>
                <div className="chat-entete-actions">
                  <button type="button" className={`chat-bascule${chiffre ? " actif" : ""}`} aria-pressed={chiffre} onClick={basculerChiffre}
                          title={chiffre ? "Afficher le texte lisible de tous les messages" : "Afficher le texte chiffré de tous les messages"}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {chiffre ? <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></> : <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>}
                    </svg>
                    {chiffre ? "Déchiffrer tout" : "Chiffrer tout"}
                  </button>
                </div>
              </header>

              <ul className="fil-conversation" aria-live="polite">
                {fil.messages.length === 0 && <li className="note">Aucun message avec ce contact pour l'instant.</li>}
                {fil.messages.map((m) => {
                  const texteChiffre = chiffre && m.crypte && m.v !== 3 && m.v !== 4;
                  const peutRepondre = cleOk && m.clair && !texteChiffre && fil.ouvert !== false;
                  return (
                    <li key={m.id} id={`msg-${m.id}`} className={`bulle ${m.sens}${surligne === m.id ? " surligne" : ""}`}>
                      {texteChiffre ? (
                        <p className="texte chiffre-brut" title={`Message chiffré (v${m.v})`}>{m.crypte}{m.crypte_tronque ? "…" : ""}</p>
                      ) : (
                        <>
                          {m.rep && (
                            <button type="button" className="citation" onClick={() => allerA(m.rep)} aria-label={`Message cité de ${m.rep.moi ? "toi" : nomCourt(ip)} : ${m.rep.x}`}>
                              <strong>{m.rep.moi ? "Toi" : nomCourt(ip)}</strong>
                              <span>{m.rep.x}</span>
                            </button>
                          )}
                          {m.v === 3 ? (
                            <PieceJointe id={m.id} taille={m.taille} />
                          ) : m.v === 4 ? (
                            <p className="note">Pièce jointe protégée par une clé saisie : ouvre-la dans l'onglet Historique.</p>
                          ) : m.clair !== null ? (
                            <p className="texte">{m.clair}</p>
                          ) : (
                            <p className="note">
                              {m.v === 5 && m.sens === "envoye"
                                ? "Message envoyé en RSA direct : seul le destinataire peut le lire."
                                : m.v === 2 || m.v === 5
                                ? "Message chiffré : déverrouille le coffre pour le lire."
                                : "Message à clé manuelle : relis-le dans l'onglet Historique."}
                            </p>
                          )}
                        </>
                      )}
                      <span className="meta">
                        {m.heure.slice(11, 16)} {m.sens === "envoye" && <Coches statut={m.statut} />}
                      </span>
                      {peutRepondre && (
                        <button type="button" className="bulle-repondre" onClick={() => repondreA(m)} aria-label="Répondre à ce message" title="Répondre">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v3" /></svg>
                        </button>
                      )}
                    </li>
                  );
                })}
                <li ref={bas} aria-hidden="true" />
              </ul>

              {cleOk && parties.length > 0 && (
                <section className="parties-privees parties-zone" aria-label="Parties avec ce contact">
                  {parties.map((g) => (
                    <div key={g.n} className="bulle large partie">
                      <CartePartie j={g.j} jeu={g} moi="moi" pret={fil.ouvert} nom={nomJoueur} portee={`prive-${ip}`} onAction={(a) => jouer(actionPrivee(g, a))} />
                    </div>
                  ))}
                </section>
              )}

              {cleOk ? (
                <form onSubmit={envoyer} className="composeur-zone">
                  <div className="composeur">
                    {reponse && (
                      <div className="composeur-rep">
                        <div className="composeur-rep-texte"><strong>Réponse à {reponse.moi ? "toi" : nomCourt(ip)}</strong><span>{reponse.x}</span></div>
                        <button type="button" className="composeur-pj-x" aria-label="Annuler la réponse" onClick={() => setReponse(null)}>×</button>
                      </div>
                    )}
                    {fichier && (
                      <div className="composeur-pj">
                        <span className="composeur-pj-nom">📎 {fichier.name} · {formatTaille(fichier.size)}</span>
                        <button type="button" className="composeur-pj-x" aria-label="Retirer la pièce jointe" onClick={() => setFichierJoint(null)}>×</button>
                      </div>
                    )}
                    <div className="composeur-ligne">
                      <input id={idFichier} ref={refFichier} type="file" className="cache" tabIndex={-1} onChange={choisirFichier} />
                      <div className="composeur-plus">
                        <button type="button" ref={refPlus} className={`composeur-btn${menuPlus ? " ouvert" : ""}`} aria-haspopup="menu" aria-expanded={menuPlus} aria-label="Plus d'actions" title="Joindre un fichier, défier…" onClick={() => setMenuPlus((o) => !o)}>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                        </button>
                        {menuPlus && (
                          <div className="composeur-menu" role="menu" ref={refMenu}>
                            <button type="button" role="menuitem" onClick={() => { setMenuPlus(false); refFichier.current?.click(); }}>
                              <span aria-hidden="true">📎</span><span>Joindre un fichier<small>{formatTaille(MAX_FICHIER)} max, chiffré</small></span>
                            </button>
                            {listeJeux().map((jeu) => (
                              <button key={jeu.id} type="button" role="menuitem" disabled={fil.ouvert === false} onClick={() => defier(jeu.id)}>
                                <span aria-hidden="true">{jeu.icone}</span><span>{jeu.libellePrive}<small>{jeu.sousTitrePrive}</small></span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <textarea id={idTexte} ref={zoneTexte} rows={1} className="composeur-texte" value={texte} placeholder="Écris ton message…"
                                aria-label="Ton message" onChange={(e) => setTexte(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Escape" && reponse) { setReponse(null); return; } if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); envoyer(); } }} />
                      <button type="submit" className="composeur-envoi" disabled={enCours || (!texte.trim() && !fichier)}
                              aria-label={fichier ? "Envoyer le fichier" + (texte.trim() ? " et le message" : "") : "Envoyer"} title="Envoyer (Entrée)">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                      </button>
                    </div>
                  </div>
                  {statut && <p className={`statut ${statut.type}`} role="status">{statut.texte}</p>}
                </form>
              ) : (
                <p className="note chat-sans-cle">
                  Pour écrire ici sans saisir de clé, échange d'abord les clés avec ce contact (onglet Contacts, coffre déverrouillé).
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
