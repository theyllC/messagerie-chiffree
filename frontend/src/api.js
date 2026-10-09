export async function api(url, options) {
  let r;
  try {
    r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  } catch {
    throw new Error("Le serveur Python ne répond pas. Lance backend/main.py, puis recharge la page.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || "Erreur inattendue.");
  return data;
}

export const post = (url, corps) => api(url, { method: "POST", body: JSON.stringify(corps) });
export const erreur = (texte) => ({ type: "erreur", texte });
export const ok = (texte) => ({ type: "ok", texte });
export const info = (texte) => ({ type: "info", texte });
