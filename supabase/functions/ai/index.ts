// =====================================================================
// Coach Assiette : fonction IA sécurisée (Supabase Edge Function "ai")
// © 2026 Sébastien Bassous (github.com/keyvos) — Tous droits réservés.
// La clé de l'API Claude reste ici, côté serveur : elle n'arrive jamais
// sur le téléphone des clients.
// Secret obligatoire : ANTHROPIC_API_KEY
// Réglages facultatifs : AI_MODEL (défaut claude-haiku-5-5, le moins cher ; mettre claude-sonnet-5-5 pour plus de précision),
//   AI_MODEL_QUICK (défaut claude-haiku-5-5), AI_DAILY_LIMIT (défaut 20),
//   ALLOWED_ORIGINS (défaut https://keyvos.github.io : seul ce site peut utiliser l'IA,
//   une copie de l'application hébergée ailleurs est refusée)
// "Verify JWT" : désactivé (la fonction vérifie elle-même la connexion)
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

// ==== origin (même code dans billing)
function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") || "https://keyvos.github.io").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}
function originOk(req: Request): boolean {
  const list = allowedOrigins();
  if (list.includes("*")) return true;
  return list.includes(req.headers.get("Origin") || "");
}
function corsFor(req: Request): Record<string, string> {
  const o = req.headers.get("Origin") || "";
  const list = allowedOrigins();
  return {
    "Access-Control-Allow-Origin": list.includes("*") ? "*" : (list.includes(o) ? o : list[0]),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
// ==== end origin

function serverKey(): string {
  // New-style secret key first, then the legacy service_role key
  try {
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const k = all.default || Object.values(all)[0];
    if (typeof k === "string" && k) return k;
  } catch (_) { /* ignore */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

const IMG_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!originOk(req)) return reply({ error: "Site non autorisé", code: "origin" }, 403);
  if (req.method !== "POST") return reply({ error: "Méthode non autorisée", code: "bad_request" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return reply({ error: "ANTHROPIC_API_KEY manquante", code: "not_granted" }, 500);

  // 1. Only signed-in people of this app
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false } });
  const { data: who, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !who?.user) return reply({ error: "Session invalide", code: "session_expired" }, 401);
  const uid = who.user.id;

  // 2. Subscription: if paid subscriptions are on and this person has to pay, they must be up to date
  const { data: acc, error: accErr } = await admin.rpc("access_for", { uid });
  if (!accErr && acc && acc.allowed === false) return reply({ error: "Abonnement nécessaire", code: "subscription" }, 402);

  // 3. Daily limit per person (protects the bill)
  const limit = Number(Deno.env.get("AI_DAILY_LIMIT") || "20");
  const day = new Date().toISOString().slice(0, 10);
  const { data: row } = await admin.from("ai_usage").select("n").eq("user_id", uid).eq("day", day).maybeSingle();
  const used = row?.n || 0;
  if (used >= limit) return reply({ error: "Limite du jour atteinte", code: "quota" }, 429);
  await admin.from("ai_usage").upsert({ user_id: uid, day, n: used + 1 });

  // 4. Build the request to Claude
  let body: { prompt?: string; images?: { type?: string; data?: string }[]; tier?: string };
  try { body = await req.json(); } catch (_) { return reply({ error: "Requête illisible", code: "bad_request" }, 400); }
  const prompt = String(body.prompt || "").slice(0, 60000);
  if (!prompt) return reply({ error: "Requête vide", code: "bad_request" }, 400);
  const content: unknown[] = [];
  for (const im of (Array.isArray(body.images) ? body.images.slice(0, 2) : [])) {
    if (im && typeof im.data === "string" && im.data.length > 0 && im.data.length < 7_000_000) {
      content.push({ type: "image", source: { type: "base64", media_type: IMG_TYPES.includes(String(im.type)) ? im.type : "image/jpeg", data: im.data } });
    }
  }
  content.push({ type: "text", text: prompt });
  const model = body.tier === "quick"
    ? (Deno.env.get("AI_MODEL_QUICK") || "claude-haiku-5-5")
    : (Deno.env.get("AI_MODEL") || "claude-haiku-5-5");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 3000, messages: [{ role: "user", content }] }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = r.status === 429 || r.status === 529 ? "rate_limited" : r.status === 401 || r.status === 403 ? "not_granted" : r.status === 400 && /image/i.test(JSON.stringify(out)) ? "image_rejected" : "unavailable";
    return reply({ error: out?.error?.message || "Erreur IA", code }, 502);
  }
  const text = (out.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  return reply({ text, model, stop: out.stop_reason });
});
