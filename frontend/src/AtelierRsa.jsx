import { useId, useMemo, useState } from "react";
import { post, erreur, ok } from "./api.js";
import { Modal, Statut } from "./composants.jsx";

/* ---- Arithmétique sur grands entiers (BigInt) ---- */
const pgcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

function puissMod(base, exp, m) {
  let r = 1n;
  base %= m;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return r;
}

/* Inverse de e modulo phi (Euclide étendu) ; null s'il n'existe pas. */
function inverse(e, phi) {
  let [a, b] = [e % phi, phi];
  let [x0, x1] = [1n, 0n];
  while (b) {
    const q = a / b;
    [a, b] = [b, a - q * b];
    [x0, x1] = [x1, x0 - q * x1];
  }
  return a === 1n ? ((x0 % phi) + phi) % phi : null;
}

const PETITS = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];

/* Miller-Rabin : certain en dessous de 3,3·10^24, très probable au-delà. */
function estPremier(n) {
  if (n < 2n) return false;
  for (const p of PETITS) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n, s = 0;
  while (d % 2n === 0n) { d /= 2n; s++; }
  for (const a of PETITS) {
    let x = puissMod(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let compose = true;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) { compose = false; break; }
    }
    if (compose) return false;
  }
  return true;
}

/* Attaque : factoriser n par la méthode rho de Pollard. Abandonne après `max` tours. */
function factoriser(n, max = 200000) {
  if (n % 2n === 0n) return 2n;
  for (let c = 1n; c < 6n; c++) {
    let x = 2n, y = 2n, d = 1n, tours = 0;
    while (d === 1n && tours < max) {
      x = (x * x + c) % n;
      y = (y * y + c) % n;
      y = (y * y + c) % n;
      d = pgcd(x > y ? x - y : y - x, n);
      tours++;
    }
    if (d !== 1n && d !== n) return d;
    if (tours >= max) return null;
  }
  return null;
}

const abrege = (n) => {
  const t = String(n);
  return t.length > 48 ? `${t.slice(0, 20)}…${t.slice(-20)} (${t.length} chiffres)` : t;
};
const entier = (t) => (/^\d{1,600}$/.test(t.trim()) ? BigInt(t.trim()) : null);

function calculer(pTxt, qTxt, eTxt) {
  const p = entier(pTxt), q = entier(qTxt);
  if (p === null || q === null) return { erreur: "Saisis p et q : deux nombres entiers positifs." };
  if (!estPremier(p)) return { erreur: `${abrege(p)} n'est pas un nombre premier.` };
  if (!estPremier(q)) return { erreur: `${abrege(q)} n'est pas un nombre premier.` };
  if (p === q) return { erreur: "p et q doivent être différents." };
  const n = p * q, phi = (p - 1n) * (q - 1n);
  let e;
  if (eTxt.trim()) {
    e = entier(eTxt);
    if (e === null || e < 2n || e >= phi) return { erreur: "e doit être un entier compris entre 2 et φ(n) − 1." };
    if (pgcd(e, phi) !== 1n) return { erreur: "e doit être premier avec φ(n) (pgcd(e, φ) = 1) : choisis-en un autre." };
  } else {
    e = [65537n, 257n, 17n, 5n, 3n].find((c) => c < phi && pgcd(c, phi) === 1n);
    if (e === undefined) return { erreur: "Aucun e usuel ne convient : choisis des nombres premiers plus grands." };
  }
  return { p, q, n, phi, e, d: inverse(e, phi) };
}

const EXEMPLES = [
  { nom: "Classique (61 et 53)", p: "61", q: "53" },
  { nom: "Moyens (32 bits)", p: "4294967291", q: "4294967279" },
  { nom: "Plus grands (64 bits)", p: "18446744073709551557", q: "18446744073709551533" },
];

/* Atelier : on choisit p et q, on voit chaque étape de RSA avec les vrais nombres, puis on attaque. */
export function ModalRsaPasAPas({ onClose }) {
  const [p, setP] = useState("61");
  const [q, setQ] = useState("53");
  const [eSaisi, setESaisi] = useState("");
  const [texte, setTexte] = useState("Salut");
  const [attaque, setAttaque] = useState(null);  // null | "en cours" | { ... }
  const idP = useId(), idQ = useId(), idE = useId(), idTexte = useId();
  const calc = useMemo(() => calculer(p, q, eSaisi), [p, q, eSaisi]);

  const octets = useMemo(() => [...new TextEncoder().encode(texte)].map(BigInt), [texte]);
  const message = useMemo(() => {
    if (calc.erreur || !octets.length) return null;
    if (calc.n <= 255n) return { erreur: "n doit dépasser 255 pour chiffrer du texte : prends des nombres premiers plus grands." };
    const chiffres = octets.map((m) => puissMod(m, calc.e, calc.n));
    const dechiffres = chiffres.map((c) => puissMod(c, calc.d, calc.n));
    return { chiffres, clair: new TextDecoder().decode(Uint8Array.from(dechiffres.map(Number))) };
  }, [calc, octets]);

  function changer(setter) { return (ev) => { setter(ev.target.value); setAttaque(null); }; }

  function attaquer() {
    setAttaque("en cours");
    setTimeout(() => {  // laisse le navigateur afficher « en cours » avant le calcul
      const debut = performance.now();
      const facteur = factoriser(calc.n);
      const ms = Math.round(performance.now() - debut);
      if (facteur === null) return setAttaque({ ms, trouve: false });
      const autre = calc.n / facteur;
      const dPirate = inverse(calc.e, (facteur - 1n) * (autre - 1n));
      const lu = message && !message.erreur
        ? new TextDecoder().decode(Uint8Array.from(message.chiffres.map((c) => Number(puissMod(c, dPirate, calc.n)))))
        : null;
      setAttaque({ ms, trouve: true, facteur, autre, lu });
    }, 30);
  }

  return (
    <Modal titre="RSA pas à pas : choisis p et q" onClose={onClose}>
      <p className="avertissement">
        Atelier pédagogique : les nombres choisis ici <strong>ne servent à aucun vrai message</strong>. Avec de petits nombres premiers,
        RSA se casse en quelques millisecondes (essaie l'attaque plus bas). Le programme utilise des clés de 3072 bits.
      </p>
      <div className="actions-ligne">
        {EXEMPLES.map((x) => (
          <button key={x.nom} type="button" className="bouton secondaire petit" onClick={() => { setP(x.p); setQ(x.q); setESaisi(""); setAttaque(null); }}>{x.nom}</button>
        ))}
      </div>
      <div className="duo">
        <div className="champ">
          <div className="titre"><label htmlFor={idP}>p (premier)</label></div>
          <input id={idP} value={p} onChange={changer(setP)} inputMode="numeric" spellCheck={false} />
        </div>
        <div className="champ">
          <div className="titre"><label htmlFor={idQ}>q (premier)</label></div>
          <input id={idQ} value={q} onChange={changer(setQ)} inputMode="numeric" spellCheck={false} />
        </div>
      </div>
      <div className="champ">
        <div className="titre"><label htmlFor={idE}>e (facultatif : laissé vide, un exposant usuel est choisi)</label></div>
        <input id={idE} value={eSaisi} onChange={changer(setESaisi)} inputMode="numeric" spellCheck={false} />
      </div>

      {calc.erreur ? <p className="statut erreur" role="status">{calc.erreur}</p> : (
        <>
          <dl className="cles">
            <dt>1. Module</dt>
            <dd>n = p × q = <span className="code">{abrege(calc.n)}</span></dd>
            <dt>2. Indicatrice</dt>
            <dd>φ(n) = (p − 1)(q − 1) = <span className="code">{abrege(calc.phi)}</span></dd>
            <dt>3. Exposant public</dt>
            <dd>e = <span className="code">{String(calc.e)}</span>, avec pgcd(e, φ) = 1</dd>
            <dt>4. Exposant privé</dt>
            <dd>d = e⁻¹ mod φ(n) = <span className="code">{abrege(calc.d)}</span></dd>
            <dt>Clé publique</dt>
            <dd>(e, n) : on la donne à tout le monde</dd>
            <dt>Clé privée</dt>
            <dd>(d, n) : seul le propriétaire la connaît. Elle repose sur le secret de p et q.</dd>
          </dl>

          <div className="champ">
            <div className="titre"><label htmlFor={idTexte}>Message à chiffrer (octet par octet)</label></div>
            <input id={idTexte} value={texte} onChange={changer(setTexte)} />
          </div>
          {message?.erreur && <p className="statut erreur" role="status">{message.erreur}</p>}
          {message && !message.erreur && (
            <dl className="cles">
              <dt>Chiffrer</dt>
              <dd>c = mᵉ mod n, pour chaque octet m : <span className="code">{abrege(message.chiffres.join(" "))}</span></dd>
              <dt>Déchiffrer</dt>
              <dd>m = cᵈ mod n → « {message.clair} »</dd>
            </dl>
          )}
          <p className="note">RSA « brut » pour apprendre. Le vrai programme ajoute un remplissage (OAEP) et ne chiffre que la clé AES du message.</p>

          <div className="actions-ligne">
            <button type="button" className="bouton secondaire petit" onClick={attaquer} disabled={attaque === "en cours"}>
              Simuler un attaquant : factoriser n
            </button>
          </div>
          {attaque === "en cours" && <p className="note">Calcul en cours…</p>}
          {attaque && attaque !== "en cours" && (attaque.trouve ? (
            <p className="avertissement" role="status">
              Cassé en {attaque.ms} ms : n = {abrege(attaque.facteur)} × {abrege(attaque.autre)}. L'attaquant en déduit φ(n), puis d,
              {attaque.lu !== null ? <> et lit le message : « {attaque.lu} ».</> : " et peut tout déchiffrer."}
            </p>
          ) : (
            <p className="statut ok" role="status">
              Abandon après {attaque.ms} ms : ce simple attaquant n'a pas réussi à factoriser n. Un attaquant sérieux y arrive jusqu'à
              environ 800 bits ; à 3072 bits, c'est hors de portée.
            </p>
          ))}
        </>
      )}
    </Modal>
  );
}

/* Vraie clé : à partir de deux grands nombres premiers (1536 bits chacun au moins), contrôlés par le serveur. */
export function ModalCleDepuisPremiers({ onChange, onClose }) {
  const [p, setP] = useState("");
  const [q, setQ] = useState("");
  const [mdp, setMdp] = useState("");
  const [statut, setStatut] = useState(null);
  const [attente, setAttente] = useState(false);
  const idP = useId(), idQ = useId(), idMdp = useId();

  async function tirer() {
    setAttente(true);
    setStatut(null);
    try {
      const r = await post("/api/premiers/aleatoires", {});
      setP(r.p); setQ(r.q);
      setStatut(ok(`Deux nombres premiers de ${r.bits} bits tirés au hasard (${r.p.length} chiffres chacun).`));
    } catch (e) {
      setStatut(erreur(e.message));
    } finally {
      setAttente(false);
    }
  }

  async function creer(ev) {
    ev.preventDefault();
    if (!p.trim() || !q.trim()) return setStatut(erreur("Saisis p et q."));
    if (!mdp) return setStatut(erreur("Saisis le mot de passe du coffre."));
    setAttente(true);
    setStatut(null);
    try {
      const r = await post("/api/identite/depuis-premiers", { p, q, mdp });
      onChange(ok(`Nouvelle paire RSA de ${r.bits} bits créée. Empreinte : ${r.empreinte}. Redonne ta clé publique à tes contacts.`));
      onClose();
    } catch (e) {
      setStatut(erreur(e.message));
    } finally {
      setAttente(false);
    }
  }

  return (
    <Modal titre="Créer ma clé à partir de mes nombres premiers" onClose={onClose}>
      <form onSubmit={creer} className="panneau">
        <p className="note">
          Choisis deux nombres premiers p et q d'au moins 1536 bits (environ 463 chiffres) : n = p × q fera 3072 bits ou plus.
          Plus petits, ils sont refusés, car n se factoriserait vite (teste-le dans « RSA pas à pas »).
          À la main, des nombres « choisis » sont souvent moins sûrs que des nombres tirés au hasard.
        </p>
        <p className="avertissement">
          Cela <strong>remplace ta paire de clés actuelle</strong>. Tes contacts devront recevoir ta nouvelle clé publique (onglet Envoyer).
          Les clés secrètes déjà échangées restent valables. p et q sont secrets : celui qui les connaît connaît ta clé privée.
        </p>
        <div className="actions-ligne">
          <button type="button" className="bouton secondaire petit" onClick={tirer} disabled={attente}>Tirer p et q au hasard</button>
        </div>
        <div className="champ">
          <div className="titre"><label htmlFor={idP}>p</label></div>
          <textarea id={idP} rows={3} value={p} onChange={(e) => setP(e.target.value)} spellCheck={false} autoComplete="off" />
        </div>
        <div className="champ">
          <div className="titre"><label htmlFor={idQ}>q</label></div>
          <textarea id={idQ} rows={3} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} autoComplete="off" />
        </div>
        <div className="champ">
          <div className="titre"><label htmlFor={idMdp}>Mot de passe du coffre</label></div>
          <input id={idMdp} type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="off" />
        </div>
        <Statut statut={statut} />
        <div className="actions-ligne">
          <button type="submit" className="bouton" disabled={attente}>{attente ? "Vérification…" : "Remplacer ma paire de clés"}</button>
          <button type="button" className="lien" onClick={onClose}>Annuler</button>
        </div>
      </form>
    </Modal>
  );
}
