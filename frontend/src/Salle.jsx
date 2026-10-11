import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api, post, erreur, ok } from "./api.js";
import { Avatar, Statut } from "./composants.jsx";
import SalleProf from "./SalleProf.jsx";
import { CartePartie } from "./Jeux.jsx";
import { listeJeux } from "./jeux/index.js";
import { DELAIS_OUVERTURE, DUREES, REACTIONS, decouperMentions, deriver, estMentionne } from "./salonEvenements.js";

/* Salle de classe : on rejoint un serveur relais avec un code à 6 chiffres. Les messages restent chiffrés de bout en bout,
   le relais ne fait que transporter du chiffré. */
/* Salon commun : un fil de discussion partagé par tous les membres de la salle (créateur compris), chiffré de bout en bout.
   La clé du salon est distribuée automatiquement à chaque membre (chiffrée avec sa clé publique) : il faut un coffre ouvert. */
const MAX_EVENEMENTS = 1500;  // événements gardés en mémoire (messages, réactions, votes, coups)
const ROLES = { createur: "Créateur", admin: "Admin" };
const ETATS_CLE = {
  coffre_absent: "Crée ton coffre (onglet Contacts) : il reçoit la clé du salon chiffré.",
  coffre_verrouille: "Ton coffre est verrouillé : déverrouille-le (onglet Contacts) pour lire et écrire dans le salon.",
  en_attente: "En attente de la clé du salon : elle arrive dès qu'un admin ou le créateur est connecté avec son coffre ouvert.",
};
const NOTE_ILLISIBLE = {
  sans_cle: "🔒 Message envoyé avant ton arrivée : tu n'as pas la clé de cette période.",
  verrouille: "🔒 Coffre verrouillé : message chiffré.",
  illisible: "⚠️ Message illisible ou falsifié.",
};

function BadgeRole({ role }) {
  return ROLES[role] ? <span className={`badge role ${role}`}>{ROLES[role]}</span> : null;
}

/* Les réactions, sondages, votes et coups de jeu sont des « événements » du salon : chiffrés avec la même clé que les messages,
   transportés par le même relais aveugle. Chaque client rejoue la suite d'événements (voir salonEvenements.js). */
function useSeconde(actif) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!actif) return undefined;
    const id = setInterval(() => setT((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [actif]);
}

function formatReste(s) {
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${s} s`;
}

function Reactions({ n, parEmoji, moi, pret, onReagir }) {
  const [choix, setChoix] = useState(false);
  const pastilles = [...(parEmoji?.entries() || [])].filter(([, qui]) => qui.size > 0);
  return (
    <div className="reactions">
      {pastilles.map(([e, qui]) => (
        <button key={e} type="button" className={`reaction${qui.has(moi) ? " moi" : ""}`} disabled={!pret}
                onClick={() => onReagir(n, e, !qui.has(moi))} aria-pressed={qui.has(moi)} aria-label={`${e} ${qui.size}`}>
          {e} <span>{qui.size}</span>
        </button>
      ))}
      {pret && (choix ? (
        <span className="reaction-choix" role="group" aria-label="Choisir une réaction">
          {REACTIONS.map((e) => (
            <button key={e} type="button" className="reaction" onClick={() => { setChoix(false); onReagir(n, e, !parEmoji?.get(e)?.has(moi)); }} aria-label={`Réagir ${e}`}>{e}</button>
          ))}
        </span>
      ) : <button type="button" className="reaction ajout" onClick={() => setChoix(true)} aria-label="Ajouter une réaction">☺ +</button>)}
    </div>
  );
}

function CarteSondage({ m, sondage, moi, pret, onVoter }) {
  const total = sondage.votes.size;
  const monVote = sondage.votes.get(moi);
  return (
    <div className="sondage">
      <strong>📊 {sondage.q}</strong>
      <ul>
        {sondage.o.map((texte, i) => {
          const part = total ? Math.round((sondage.total[i] * 100) / total) : 0;
          return (
            <li key={i}>
              <button type="button" className={`option-sondage${monVote === i ? " choisi" : ""}`} disabled={!pret} onClick={() => onVoter(m.n, i)} aria-pressed={monVote === i}>
                <span className="barre" style={{ width: `${part}%` }} aria-hidden="true" />
                <span className="option-texte">{texte}</span>
                <span className="option-score">{sondage.total[i]} · {part} %</span>
              </button>
            </li>
          );
        })}
      </ul>
      <span className="note">{total} vote{total > 1 ? "s" : ""} · les votes sont visibles de la salle, tu peux changer le tien</span>
    </div>
  );
}

function FormSondage({ onEnvoyer, onFermer }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState(["", ""]);
  const prets = opts.map((o) => o.trim()).filter(Boolean);
  return (
    <form className="form-sondage" onSubmit={(e) => { e.preventDefault(); if (q.trim() && prets.length >= 2) onEnvoyer(q.trim(), prets); }}>
      <input value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} placeholder="Question du sondage" aria-label="Question du sondage" />
      {opts.map((o, i) => (
        <input key={i} value={o} maxLength={80} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} />
      ))}
      <div className="action">
        {opts.length < 6 && <button type="button" className="lien" onClick={() => setOpts([...opts, ""])}>+ Ajouter une option</button>}
        <button type="submit" className="bouton petit" disabled={!q.trim() || prets.length < 2}>Publier le sondage</button>
        <button type="button" className="lien" onClick={onFermer}>Annuler</button>
      </div>
    </form>
  );
}

function Salon({ actif, profils }) {
  const [evenements, setEvenements] = useState([]);
  const [supprimes, setSupprimes] = useState(() => new Set());
  const [expires, setExpires] = useState(() => new Set());
  const [meta, setMeta] = useState({ etat_cle: "en_attente", moi_role: "eleve", moi: "" });
  const [texte, setTexte] = useState("");
  const [ttl, setTtl] = useState(0);
  const [ouvreDans, setOuvreDans] = useState(0);        // message « à ouvrir plus tard » : délai en secondes (0 = lisible tout de suite)
  const [citees, setCitees] = useState(() => new Map());  // id -> pseudo des membres cités avec @ dans le message en cours
  const [monPseudo, setMonPseudo] = useState("");
  const [outil, setOutil] = useState("");
  const [reponse, setReponse] = useState(null);
  const [statut, setStatut] = useState(null);
  const [envoi, setEnvoi] = useState(false);
  const [confirmer, setConfirmer] = useState(null);
  const [surligne, setSurligne] = useState(null);
  const dernier = useRef(0);
  const version = useRef(null);
  const verrous = useRef(new Map());  // numéro -> heure d'ouverture (relais) des messages encore verrouillés : on relit tout quand l'un d'eux s'ouvre
  const decalage = useRef(0);  // heure du relais moins heure de ce PC (secondes) : le temps restant des messages éphémères suit l'horloge du relais
  const liste = useRef(null);
  const champ = useRef(null);
  const enBas = useRef(true);
  const idTexte = useId();

  const actualiser = useCallback(async () => {
    try {
      const r = await api(`/api/relais/salon?apres=${dernier.current}`);
      setStatut((s) => (s && s.auto ? null : s));
      setMeta({ etat_cle: r.etat_cle, moi_role: r.moi_role, moi: r.moi });
      if (typeof r.horloge === "number") decalage.current = r.horloge - Date.now() / 1000;
      const v = JSON.stringify(r.cles);
      if (version.current !== null && version.current !== v) {  // une clé est arrivée (ou le coffre s'est fermé) : on relit tout
        version.current = v;
        dernier.current = 0;
        setEvenements([]);
        return;
      }
      version.current = v;
      for (const m of r.messages) if (m.verrou && typeof m.ouvre === "number") verrous.current.set(m.n, m.ouvre);
      if ([...verrous.current.values()].some((o) => o <= r.horloge)) {  // un message verrouillé s'ouvre : le relais en donne maintenant le contenu, on relit tout
        verrous.current.clear();
        dernier.current = 0;
        setEvenements([]);
        return;
      }
      if (r.messages.length) dernier.current = Math.max(dernier.current, ...r.messages.map((m) => m.n));
      setSupprimes(new Set(r.supprimes));
      setExpires(new Set(r.expires || []));
      setEvenements((anciens) => {
        const vus = new Set(anciens.map((m) => m.n));
        return [...anciens, ...r.messages.filter((m) => !vus.has(m.n))].slice(-MAX_EVENEMENTS);
      });
    } catch (err) {
      setStatut({ ...erreur(err.message), auto: true });
    }
  }, []);

  useEffect(() => {
    if (!actif) return undefined;
    actualiser();
    const id = setInterval(actualiser, 2000);
    return () => clearInterval(id);
  }, [actif, actualiser]);

  useEffect(() => {
    if (actif) api("/api/profil").then((p) => setMonPseudo(typeof p?.pseudo === "string" ? p.pseudo : "")).catch(() => {});
  }, [actif]);

  const { fil: filBrut, reactions, sondages, jeux, epingles } = useMemo(() => deriver(evenements, supprimes), [evenements, supprimes]);
  const aDesEphemeres = evenements.some((m) => m.exp);
  const aDesVerrous = evenements.some((m) => m.verrou);
  useSeconde(actif && (aDesEphemeres || aDesVerrous));
  const maintenant = () => Date.now() / 1000 + decalage.current;
  const resteOuverture = (m) => (m.verrou && typeof m.ouvre === "number" ? Math.ceil(m.ouvre - maintenant()) : null);
  const membresCitables = useMemo(() => Object.entries(profils || {})
    .filter(([cle, p]) => cle.startsWith("relais:") && p?.pseudo)
    .map(([cle, p]) => ({ id: cle.slice(7), pseudo: p.pseudo, avatar: p.avatar })), [profils]);
  const pseudosConnus = useMemo(() => [...membresCitables.map((x) => x.pseudo), monPseudo], [membresCitables, monPseudo]);
  const requete = /(^|\s)@([^\s@]{0,30})$/.exec(texte);  // « @ » en cours de frappe, tout à la fin du texte
  const suggestions = requete ? membresCitables.filter((x) => x.pseudo.toLowerCase().startsWith(requete[2].toLowerCase())).slice(0, 5) : [];
  const reste = (m) => (m.exp ? Math.ceil(m.exp - (Date.now() / 1000 + decalage.current)) : null);
  // Un message éphémère disparaît dès que son temps est écoulé, sans attendre que le relais l'efface.
  const fil = filBrut.filter((m) => m.supprime || reste(m) === null || reste(m) > 0);

  // On suit les nouveaux messages seulement si la personne est déjà en bas du fil (sinon elle relit l'historique).
  useEffect(() => {
    const el = liste.current;
    if (el && enBas.current) el.scrollTop = el.scrollHeight;
  }, [fil.length]);

  function surDefilement() {
    const el = liste.current;
    if (el) enBas.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  const admin = meta.moi_role === "admin" || meta.moi_role === "createur";
  const pret = meta.etat_cle === "ok";
  const moi = meta.moi;

  function nomDe(m) {
    return (!m.moi && profils[`relais:${m.de}`]?.pseudo) || m.pseudo || "Ancien membre";
  }
  function nomJoueur(j) {
    return j.id === moi ? "Toi" : profils[`relais:${j.id}`]?.pseudo || j.pseudo || "Joueur";
  }

  function repondre(m) {
    setReponse({ n: m.n, p: m.moi ? "Moi" : nomDe(m), x: m.texte.replace(/\s+/g, " ").trim().slice(0, 120) });
    champ.current?.focus();
  }

  function aller(n) {
    const el = document.getElementById(`salon-msg-${n}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setSurligne(n);
    setTimeout(() => setSurligne(null), 1600);
  }

  async function evenement(corps, { suivre = false } = {}) {
    setStatut(null);
    try {
      await post("/api/relais/salon/evenement", corps);
      if (suivre) enBas.current = true;
      await actualiser();
    } catch (err) {
      setStatut(erreur(err.message));
    }
  }
  const reagir = (c, e, on) => evenement({ k: "rx", c, e, on });
  const epingler = (c, on) => evenement({ k: "pin", c, on });
  function citer(membre) {
    setTexte((t) => t.replace(/(^|\s)@([^\s@]{0,30})$/, `$1@${membre.pseudo} `));
    setCitees((c) => new Map(c).set(membre.id, membre.pseudo));
    champ.current?.focus();
  }
  function rendreTexte(m) {
    return decouperMentions(m.texte, pseudosConnus).map((x, i) => (x.mention ? <mark key={i} className="mention">{x.t}</mark> : <span key={i}>{x.t}</span>));
  }
  const voter = (c, i) => evenement({ k: "vote", c, i });
  const actionJeu = (a) => evenement({ k: "jeu", j: "morpion", ...a }, { suivre: a.a === "defi" });
  async function publierSondage(q, o) {
    await evenement({ k: "poll", q, o }, { suivre: true });
    setOutil("");
  }

  async function envoyer(ev) {
    ev.preventDefault();
    const t = texte.trim();
    if (!t || envoi || !pret) return;
    setEnvoi(true);
    setStatut(null);
    try {
      const mentions = [...citees].filter(([, pseudo]) => t.includes(`@${pseudo}`)).map(([id]) => id);  // seulement ceux qui sont toujours dans le texte
      await post("/api/relais/salon", { texte: t, ttl, ouvre_dans: ouvreDans, mentions, reponse_a: reponse ? { n: reponse.n, p: reponse.p === "Moi" ? "" : reponse.p, x: reponse.x } : null });
      setTexte("");
      setCitees(new Map());
      setOuvreDans(0);
      setReponse(null);
      enBas.current = true;
      await actualiser();
    } catch (err) {
      setStatut(erreur(err.message));
    } finally {
      setEnvoi(false);
    }
  }

  async function supprimer(n) {
    setConfirmer(null);
    try {
      await post("/api/relais/salon/supprimer", { n });
      if (reponse?.n === n) setReponse(null);
      actualiser();
    } catch (err) {
      setStatut(erreur(err.message));
    }
  }

  return (
    <div className="panneau">
      <p className="note">
        Le salon est visible par <strong>toute la salle</strong>, créateur compris, et <strong>chiffré de bout en bout</strong> : le relais ne voit que du texte chiffré,
        y compris pour les réactions, les sondages et les parties de morpion.
        La clé est renouvelée quand quelqu'un quitte la salle ou en est retiré.
      </p>
      {!pret && <p className="statut info" role="status">{ETATS_CLE[meta.etat_cle]}</p>}
      {epingles.length > 0 && (
        <ul className="epingles" aria-label="Messages épinglés">
          {epingles.map((n) => {
            const m = filBrut.find((x) => x.n === n);
            if (!m) return null;
            return (
              <li key={n}>
                <button type="button" className="epingle" onClick={() => aller(n)}>
                  <span aria-hidden="true">📌</span>
                  <strong>{m.moi ? "Moi" : nomDe(m)}</strong>
                  <span className="epingle-texte">{m.k === "poll" ? `Sondage : ${m.q}` : m.verrou ? "🔒 Message verrouillé" : (m.texte || "").replace(/\s+/g, " ").slice(0, 80)}</span>
                </button>
                {admin && <button type="button" className="lien" onClick={() => epingler(n, false)} aria-label="Désépingler ce message">✕</button>}
              </li>
            );
          })}
        </ul>
      )}
      <ul className="fil-conversation" ref={liste} onScroll={surDefilement} role="log" aria-live="polite" aria-label="Salon de la salle">
        {fil.length === 0 && (
          <li className="etat-vide">
            <strong>{pret ? "Le salon est vide" : "Salon chiffré"}</strong>
            <p className="note">{pret ? "Écris le premier message : tous les membres de la salle le verront." : "Les messages s'afficheront ici dès que tu auras la clé."}</p>
          </li>
        )}
        {fil.map((m) => {
          const profil = (!m.moi && profils[`relais:${m.de}`]) || m;
          const lisible = m.etat === "ok" && !m.supprime;
          const r = reste(m);
          const rv = resteOuverture(m);  // secondes avant l'ouverture d'un message verrouillé (null : pas verrouillé)
          const cite = lisible && !m.moi && estMentionne(m, moi);
          return (
            <li key={m.n} id={`salon-msg-${m.n}`} className={`bulle ${m.moi ? "envoye" : "recu"}${surligne === m.n ? " surligne" : ""}${m.k === "jeu" || m.k === "poll" ? " large" : ""}${cite ? " mentionne" : ""}${epingles.includes(m.n) ? " epingle-bulle" : ""}`}>
              <span className="bulle-tete">
                <Avatar profil={profil} nom={m.pseudo} petit />
                <strong>{m.moi ? "Moi" : nomDe(m)}</strong>
                <BadgeRole role={m.role} />
                {lisible && r !== null && <span className="badge ephemere" title="Message éphémère : le relais l'efface à l'échéance">💨 {formatReste(r)}</span>}
                {cite && <span className="badge mention-toi" title="Ce message te cite">@ toi</span>}
              </span>
              {m.rep && lisible && (
                <button type="button" className="citation" onClick={() => aller(m.rep.n)} aria-label={`Message cité de ${m.rep.p || "moi"} : ${m.rep.x}`}>
                  <strong>{m.rep.p || "Moi"}</strong>
                  <span>{m.rep.x}</span>
                </button>
              )}
              {m.supprime ? <p className="texte supprime">{expires.has(m.n) ? "💨 Message éphémère expiré" : "Message supprimé"}</p>
                : lisible && m.k === "poll" ? <CarteSondage m={m} sondage={sondages.get(m.n)} moi={moi} pret={pret} onVoter={voter} />
                : lisible && m.k === "jeu" ? <CartePartie j={m.j} jeu={jeux.get(m.n)} moi={moi} pret={pret} nom={nomJoueur} portee={`salon-${moi}`} maintenant={maintenant} onAction={(a) => actionJeu({ j: m.j, ...a })} />
                : lisible && rv !== null ? <p className="texte verrou">🔒 {rv > 0 ? `Message verrouillé : il s'ouvre dans ${formatReste(rv)}` : "Ouverture du message…"}</p>
                : lisible ? <p className="texte">{rendreTexte(m)}</p>
                : <p className="texte chiffre">{NOTE_ILLISIBLE[m.etat] || NOTE_ILLISIBLE.illisible}</p>}
              {lisible && rv === null && <Reactions n={m.n} parEmoji={reactions.get(m.n)} moi={moi} pret={pret} onReagir={reagir} />}
              <span className="meta">
                {lisible && rv === null && m.k !== "poll" && m.k !== "jeu" && pret && <button type="button" className="lien" onClick={() => repondre(m)}>Répondre</button>}
                {lisible && rv === null && admin && pret && (!m.k || m.k === "msg" || m.k === "poll") && (epingles.includes(m.n)
                  ? <button type="button" className="lien" onClick={() => epingler(m.n, false)}>Désépingler</button>
                  : <button type="button" className="lien" onClick={() => epingler(m.n, true)}>📌 Épingler</button>)}
                {!m.supprime && (m.moi || admin) && (confirmer === m.n ? (
                  <>
                    <button type="button" className="lien danger" onClick={() => supprimer(m.n)}>Supprimer pour tous</button>
                    <button type="button" className="lien" onClick={() => setConfirmer(null)}>Annuler</button>
                  </>
                ) : <button type="button" className="lien danger" onClick={() => setConfirmer(m.n)}>Supprimer</button>)}
                <span>{(m.heure || "").slice(11, 16)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {reponse && (
        <div className="reponse-barre" role="group" aria-label="Réponse en cours">
          <div className="citation-apercu"><strong>Réponse à {reponse.p}</strong><span>{reponse.x}</span></div>
          <button type="button" className="lien" onClick={() => setReponse(null)} aria-label="Annuler la réponse">✕</button>
        </div>
      )}
      {outil === "sondage" && <FormSondage onEnvoyer={publierSondage} onFermer={() => setOutil("")} />}
      <div className="salon-outils" role="group" aria-label="Outils du salon">
        <button type="button" className="bouton secondaire petit" disabled={!pret} onClick={() => setOutil(outil === "sondage" ? "" : "sondage")}>📊 Sondage</button>
        {listeJeux().map((jeu) => (
          <button key={jeu.id} type="button" className="bouton secondaire petit" disabled={!pret} onClick={() => actionJeu({ j: jeu.id, a: "defi" })}>{jeu.icone} {jeu.libelleSalon}</button>
        ))}
        <label className="ephemere-choix">
          <span>💨 Éphémère</span>
          <select value={ttl} onChange={(e) => { setTtl(Number(e.target.value)); if (e.target.value !== "0") setOuvreDans(0); }} aria-label="Durée de vie du prochain message">
            {DUREES.map((d) => <option key={d.ttl} value={d.ttl}>{d.label}</option>)}
          </select>
        </label>
        <label className="ephemere-choix">
          <span>🔒 À ouvrir</span>
          <select value={ouvreDans} onChange={(e) => { setOuvreDans(Number(e.target.value)); if (e.target.value !== "0") setTtl(0); }} aria-label="Délai avant l'ouverture du prochain message">
            {DELAIS_OUVERTURE.map((d) => <option key={d.delai} value={d.delai}>{d.label}</option>)}
          </select>
        </label>
      </div>
      {suggestions.length > 0 && (
        <ul className="suggestions-mention" role="listbox" aria-label="Citer un membre">
          {suggestions.map((x) => (
            <li key={x.id} role="option" aria-selected="false">
              <button type="button" className="lien" onClick={() => citer(x)}>@{x.pseudo}</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={envoyer} className="salon-saisie">
        <label htmlFor={idTexte} className="sr-only">Message pour la salle</label>
        <textarea id={idTexte} ref={champ} rows={2} value={texte} maxLength={1000} disabled={!pret}
                  placeholder={pret ? "Écris à toute la salle… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)" : "Le salon n'est pas encore déverrouillé"}
                  onChange={(e) => setTexte(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && reponse) setReponse(null);
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) envoyer(e);
                  }} />
        <button type="submit" className="bouton" disabled={envoi || !pret || !texte.trim()}>{envoi ? "Envoi…" : "Envoyer"}</button>
      </form>
      <Statut statut={statut} />
    </div>
  );
}

function SalleEleve({ contacts, profils, echanges, actif, onChange, onEcrire, onConversation }) {
  const [etat, setEtat] = useState({ configure: false, connecte: false, erreur: "" });
  const [membres, setMembres] = useState([]);
  const [erreurAnnuaire, setErreurAnnuaire] = useState("");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [statut, setStatut] = useState(null);
  const [enCours, setEnCours] = useState(false);
  const [quitter, setQuitter] = useState(false);
  const [vue, setVue] = useState("salon");
  const [moiRole, setMoiRole] = useState("eleve");
  const [retrait, setRetrait] = useState("");
  const idUrl = useId();
  const idCode = useId();
  const ouvert = echanges.etat === "ouvert";

  const actualiser = useCallback(async () => {
    try {
      const e = await api("/api/relais");
      setEtat(e);
      if (e.configure) {
        try {
          const a = await api("/api/relais/annuaire");
          setMembres(a.membres);
          setMoiRole(a.moi_role || "eleve");
          setErreurAnnuaire("");
        } catch (err) {
          setErreurAnnuaire(err.message);
        }
      } else {
        setMembres([]);
      }
    } catch { /* le serveur redémarre : on réessaie au prochain tour */ }
  }, []);

  useEffect(() => {
    if (!actif) return undefined;
    actualiser();
    const id = setInterval(actualiser, 3000);
    return () => clearInterval(id);
  }, [actif, actualiser]);

  async function rejoindre(ev) {
    ev.preventDefault();
    if (!url.trim()) return setStatut(erreur("Indique l'adresse du relais (ou colle le lien mc-relais:// du tableau)."));
    setEnCours(true);
    setStatut(null);
    try {
      const e = await post("/api/relais/rejoindre", { url: url.trim(), code: code.trim() });
      setEtat(e);
      setUrl("");
      setCode("");
      setStatut(ok(`Tu as rejoint « ${e.salle || "la salle"} ».`));
      onChange();
      actualiser();
    } catch (err) {
      setStatut(erreur(err.message));
    } finally {
      setEnCours(false);
    }
  }

  async function agir(promesse, message) {
    try {
      await promesse;
      onChange();
      actualiser();
      if (message) setStatut(ok(message));
    } catch (err) {
      setStatut(erreur(err.message));
    }
  }

  if (!etat.configure) {
    return (
      <form onSubmit={rejoindre} className="panneau encadre">
        <p className="note">
          Le professeur lance le relais sur un PC (<code>python main.py --relais</code>) et affiche un <strong>code à 6 chiffres</strong> avec un QR code.
          Saisis l'adresse du relais et le code pour rejoindre la salle : plus besoin de chercher les adresses IP, et tes messages
          t'attendent même si tu n'es pas connecté en même temps que ton contact.
        </p>
        <div className="duo">
          <div className="champ">
            <div className="titre"><label htmlFor={idUrl}>Adresse du relais (ou lien du QR code)</label></div>
            <input id={idUrl} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="192.168.1.10:8100" autoComplete="off" inputMode="url" />
          </div>
          <div className="champ">
            <div className="titre"><label htmlFor={idCode}>Code de la salle</label></div>
            <input id={idCode} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoComplete="off" inputMode="numeric" maxLength={20} />
          </div>
        </div>
        <div className="action">
          <button type="submit" className="bouton" disabled={enCours}>{enCours ? "Connexion…" : "Rejoindre la salle"}</button>
          <Statut statut={statut} />
        </div>
        <p className="note">Astuce : le QR code du tableau contient un lien <code>mc-relais://adresse/code</code>. Colle-le dans le premier champ, le code sera lu tout seul.</p>
      </form>
    );
  }

  const liste = [...membres].sort((a, b) => Number(b.en_ligne) - Number(a.en_ligne) || (a.pseudo || "").localeCompare(b.pseudo || "", "fr"));
  return (
    <div className="panneau">
      <div className="carte-ip">
        <div>
          <p>Salle de classe</p>
          <strong className="petit">{etat.salle || "Salle"}</strong>
          <p className="ligne-statut">
            <span className={`point ${etat.connecte ? "on" : "off"}`} aria-hidden="true" />
            {etat.connecte ? "connecté au relais" : `relais injoignable${etat.erreur ? ` : ${etat.erreur}` : ""}`} · {etat.url}
          </p>
          <p className="ligne-statut">Ton rôle : <strong>{ROLES[moiRole] || "Élève"}</strong></p>
        </div>
        {!quitter ? (
          <button type="button" className="lien" onClick={() => setQuitter(true)}>Quitter la salle</button>
        ) : (
          <span className="vider">
            <button type="button" className="lien danger" onClick={() => { setQuitter(false); agir(post("/api/relais/quitter", {}), "Tu as quitté la salle."); }}>Quitter</button>
            <button type="button" className="lien" onClick={() => setQuitter(false)}>Annuler</button>
          </span>
        )}
      </div>
      <Statut statut={statut} />
      <p className="note">
        Le relais transporte uniquement des messages chiffrés : il ne peut pas les lire. Pour être sûr que la personne en face est la bonne
        (et que le relais ne s'est pas glissé entre vous), échange les clés puis compare le <strong>code de sécurité</strong> à voix haute (onglet Contacts).
      </p>
      {!ouvert && <p className="note">Coffre {echanges.etat === "absent" ? "absent : crée-le" : "verrouillé : déverrouille-le"} dans l'onglet Contacts pour échanger des clés.</p>}

      <div className="sous-onglets" role="tablist" aria-label="Contenu de la salle">
        <button type="button" role="tab" aria-selected={vue === "salon"} className={vue === "salon" ? "actif" : ""} onClick={() => setVue("salon")}>Salon de la salle</button>
        <button type="button" role="tab" aria-selected={vue === "eleves"} className={vue === "eleves" ? "actif" : ""} onClick={() => setVue("eleves")}>Élèves ({liste.length})</button>
      </div>
      {vue === "salon" && <Salon key={etat.id} actif={actif && vue === "salon"} profils={profils} />}
      {vue === "eleves" && <>
      <div className="titre"><span>Élèves de la salle ({liste.length})</span></div>
      {erreurAnnuaire && <p className="statut erreur" role="status">{erreurAnnuaire}</p>}
      {liste.length === 0 && !erreurAnnuaire && (
        <div className="etat-vide">
          <strong>Personne d'autre dans la salle pour l'instant</strong>
          <p className="note">Les autres élèves apparaîtront ici dès qu'ils auront rejoint la salle.</p>
        </div>
      )}
      <ul className="entrees">
        {liste.map((m) => {
          const cle = echanges.cles[m.adresse];
          const nom = contacts[m.adresse] || m.pseudo || "Élève sans pseudo";
          return (
            <li key={m.adresse} className="contact">
              <div className="contact-tete">
                <Avatar profil={profils[m.adresse] || m} nom={nom} />
                <div className="contact-infos">
                  <strong>{nom} <BadgeRole role={m.role} /></strong>
                  <span className="heure ligne-statut">
                    <span className={`point ${m.en_ligne ? "on" : "off"}`} aria-hidden="true" />
                    {m.en_ligne ? "en ligne" : "hors ligne (ses messages l'attendent)"}
                    {cle && <span className={`badge ${cle.verifie ? "sur" : ""}`}>{cle.verifie ? "Clé vérifiée" : "Clé à vérifier"}</span>}
                  </span>
                </div>
                <div className="contact-actions">
                  {!m.contact ? (
                    <button type="button" className="bouton petit"
                            onClick={() => agir(post("/api/contacts", { ip: m.adresse, name: m.pseudo || "Élève" }), `${m.pseudo || "Élève"} ajouté aux contacts.`)}>
                      Ajouter aux contacts
                    </button>
                  ) : (
                    <>
                      <button type="button" className="bouton petit" onClick={() => onConversation(m.adresse)}>Conversation</button>
                      <button type="button" className="bouton secondaire petit" onClick={() => onEcrire(m.adresse, contacts[m.adresse] || m.pseudo)}>Écrire</button>
                    </>
                  )}
                </div>
              </div>
              {(moiRole === "createur" || (moiRole === "admin" && m.role === "eleve")) && m.role !== "createur" && (
                <div className="contact-pied">
                  {moiRole === "createur" && (m.role === "admin"
                    ? <button type="button" className="bouton secondaire petit" onClick={() => agir(post("/api/relais/salon/role", { id: m.id, role: "eleve" }), `${nom} n'est plus admin.`)}>Retirer le rôle d'admin</button>
                    : <button type="button" className="bouton secondaire petit" onClick={() => agir(post("/api/relais/salon/role", { id: m.id, role: "admin" }), `${nom} est maintenant admin.`)}>Nommer admin</button>)}
                  {retrait === m.id ? (
                    <span className="vider">
                      <button type="button" className="lien danger" onClick={() => { setRetrait(""); agir(post("/api/relais/salon/retirer", { id: m.id }), `${nom} retiré de la salle : la clé du salon est renouvelée.`); }}>Oui, retirer {nom}</button>
                      <button type="button" className="lien" onClick={() => setRetrait("")}>Annuler</button>
                    </span>
                  ) : <button type="button" className="lien danger" onClick={() => setRetrait(m.id)}>Retirer de la salle</button>}
                </div>
              )}
              {m.contact && !cle && ouvert && (
                <div className="contact-pied">
                  <button type="button" className="bouton secondaire petit"
                          onClick={() => agir(post("/api/echange/demarrer", { ip: m.adresse }), "Demande envoyée : ton contact doit l'accepter.")}>
                    Échanger les clés
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      </>}
    </div>
  );
}

/* Deux vues : rejoindre la salle d'un professeur (élève), ou créer et gérer sa propre salle (professeur). */
export default function Salle(props) {
  const [mode, setMode] = useState("rejoindre");
  return (
    <div className="panneau">
      <div className="sous-onglets" role="tablist" aria-label="Salle de classe">
        <button type="button" role="tab" aria-selected={mode === "rejoindre"} className={mode === "rejoindre" ? "actif" : ""} onClick={() => setMode("rejoindre")}>
          Rejoindre une salle
        </button>
        <button type="button" role="tab" aria-selected={mode === "creer"} className={mode === "creer" ? "actif" : ""} onClick={() => setMode("creer")}>
          Créer ma salle (professeur)
        </button>
      </div>
      {mode === "rejoindre"
        ? <SalleEleve {...props} actif={props.actif} />
        : <SalleProf actif={props.actif} onChange={props.onChange} onVoirAnnuaire={() => setMode("rejoindre")} coffre={props.echanges.etat} />}
    </div>
  );
}
