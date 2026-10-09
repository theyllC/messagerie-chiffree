import { useEffect, useRef, useState } from "react";

const mouvementReduit = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const HEX = "0123456789ABCDEF";

/* Fond : des chiffres hexadécimaux flottent à des profondeurs différentes (parallaxe avec la souris).
   Léger : ~45 particules, en pause quand l'onglet du navigateur est caché, absent si l'on réduit les animations. */
export function FondChiffre() {
  const toile = useRef(null);

  useEffect(() => {
    if (mouvementReduit()) return undefined;
    const c = toile.current;
    const ctx = c.getContext("2d");
    let l = 0, h = 0, raf = 0, couleur = "#0B7285";
    const souris = { x: 0, y: 0, cx: 0, cy: 0 };
    const particules = Array.from({ length: 45 }, () => ({
      x: Math.random(), y: Math.random(), z: 0.25 + Math.random() * 0.75,
      ch: HEX[Math.floor(Math.random() * 16)], t: Math.random() * 100,
    }));

    function taille() {
      const d = window.devicePixelRatio || 1;
      l = window.innerWidth; h = window.innerHeight;
      c.width = l * d; c.height = h * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }
    const bouge = (ev) => { souris.x = ev.clientX / l - 0.5; souris.y = ev.clientY / h - 0.5; };
    const couleurTheme = () => { couleur = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || couleur; };

    function image() {
      souris.cx += (souris.x - souris.cx) * 0.05;
      souris.cy += (souris.y - souris.cy) * 0.05;
      ctx.clearRect(0, 0, l, h);
      ctx.fillStyle = couleur;
      for (const p of particules) {
        p.y -= 0.00006 * p.z * 16;   // les plus proches montent plus vite
        p.t += 0.02;
        if (p.y < -0.05) { p.y = 1.05; p.x = Math.random(); p.ch = HEX[Math.floor(Math.random() * 16)]; }
        const taillePx = 10 + p.z * 22;
        ctx.globalAlpha = 0.05 + p.z * 0.13 + Math.sin(p.t) * 0.02;
        ctx.font = `${taillePx}px Consolas, "Courier New", monospace`;
        ctx.fillText(p.ch, p.x * l - souris.cx * 60 * p.z, p.y * h - souris.cy * 60 * p.z);
      }
      raf = requestAnimationFrame(image);
    }
    function visibilite() {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(image);
    }

    taille(); couleurTheme();
    const veille = setInterval(couleurTheme, 2000);  // suit le changement de thème
    window.addEventListener("resize", taille);
    window.addEventListener("pointermove", bouge);
    document.addEventListener("visibilitychange", visibilite);
    raf = requestAnimationFrame(image);
    return () => {
      cancelAnimationFrame(raf); clearInterval(veille);
      window.removeEventListener("resize", taille);
      window.removeEventListener("pointermove", bouge);
      document.removeEventListener("visibilitychange", visibilite);
    };
  }, []);

  return <canvas ref={toile} className="fond-chiffre" aria-hidden="true" />;
}

/* Cube 3D : ses six faces portent les symboles de RSA. Il tourne seul ; on peut le saisir et le lancer avec la souris ou le doigt. */
const FACES = [["n", "module"], ["e", "exposant public"], ["d", "exposant privé"], ["p", "premier"], ["q", "premier"], ["φ", "indicatrice"]];

export function CubeRsa() {
  const cube = useRef(null);

  useEffect(() => {
    const el = cube.current;
    const reduit = mouvementReduit();
    let rx = -22, ry = 30, vx = 0, vy = reduit ? 0 : 0.45, prise = false, dernier = null, raf = 0;
    const poser = () => { el.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`; };

    function image() {
      if (!prise) {
        ry += vy; rx += vx;
        vx *= 0.96;
        vy += ((reduit ? 0 : 0.45) - vy) * 0.02;  // l'élan retombe vers la rotation lente
      }
      poser();
      raf = requestAnimationFrame(image);
    }
    function appui(ev) { prise = true; dernier = [ev.clientX, ev.clientY]; el.setPointerCapture?.(ev.pointerId); }
    function deplace(ev) {
      if (!prise) return;
      const dx = ev.clientX - dernier[0], dy = ev.clientY - dernier[1];
      dernier = [ev.clientX, ev.clientY];
      ry += dx * 0.6; rx -= dy * 0.6;
      vy = dx * 0.6; vx = -dy * 0.6;
    }
    function relache() { prise = false; }
    el.addEventListener("pointerdown", appui);
    el.addEventListener("pointermove", deplace);
    el.addEventListener("pointerup", relache);
    el.addEventListener("pointercancel", relache);
    poser();
    if (!reduit) raf = requestAnimationFrame(image);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", appui);
      el.removeEventListener("pointermove", deplace);
      el.removeEventListener("pointerup", relache);
      el.removeEventListener("pointercancel", relache);
    };
  }, []);

  return (
    <div className="cube-scene" title="Glisse pour faire tourner le cube">
      <div className="cube" ref={cube} role="img" aria-label="Cube décoratif portant les symboles de RSA : n, e, d, p, q et phi">
        {FACES.map(([symbole, nom]) => (
          <div key={symbole} className="face"><b>{symbole}</b><small>{nom}</small></div>
        ))}
      </div>
    </div>
  );
}

/* Le texte chiffré se « matérialise » : des caractères aléatoires se figent peu à peu. Ignoré pour les très longs textes. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=";

export function useMaterialisation(final) {
  const [texte, setTexte] = useState(final);
  useEffect(() => {
    if (!final || final.length > 1500 || mouvementReduit()) { setTexte(final); return undefined; }
    const pas = 16;
    let i = 0;
    const id = setInterval(() => {
      const fixe = Math.floor((final.length * i) / pas);
      setTexte([...final].map((ch, j) => (j < fixe || /\s/.test(ch) ? ch : ALPHABET[Math.floor(Math.random() * ALPHABET.length)])).join(""));
      if (++i > pas) { clearInterval(id); setTexte(final); }
    }, 32);
    return () => clearInterval(id);
  }, [final]);
  return texte;
}
