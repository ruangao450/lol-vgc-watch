// LoL uzun build (15.16.704.6097) + VGC (1.17.x.x) izleme;
// sadece değişince mesaj atar (ALWAYS_SEND=1 ise her seferinde atar)

import fs from "fs";
import path from "path";

// ---------- Ayarlar ----------
const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ALWAYS_SEND = process.env.ALWAYS_SEND === "1";

// Bölge slug adayları (ilk başarılı kullanılır)
const SLUGS = {
  euw: ["euw", "euw1", "eu-west"],
  na:  ["na", "na1", "north-america"],
  kr:  ["kr", "kr1"],
  br:  ["br", "br1"],
  lan: ["lan", "la1", "latam-north"],
  tr:  ["tr", "tr1"]
};

// URL yardımcıları
const LIVE = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
const REL_VARIANTS = id => [
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`
];
const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---------- HTTP ----------
async function req(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "lol-vgc-watch/1.0" } });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, text, json };
  } catch (e) {
    return { ok: false, status: 0, text: "", json: null };
  }
}

const shorten = v => (v ? String(v).split("+")[0] : null);

// ---------- LoL sürüm çıkarma ----------
function pickFromLiveJson(obj) {
  const direct = obj && typeof obj.version !== "undefined" ? String(obj.version) : null;
  const artifact =
    obj?.releases?.[0]?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] ??
    obj?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] ??
    obj?.labels?.["riot:artifact_version_id"]?.values?.[0] ?? null;
  const manifestUrl = obj?.releases?.[0]?.download?.url ?? null;
  return { direct, artifact, manifestUrl };
}

function artifactFrom({ text, json }) {
  if (text) {
    const m = text.match(/riot:artifact_version_id[^"\n]*"([^"]+)"/);
    if (m) return m[1];
  }
  if (json) {
    const a =
      json?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] ??
      json?.labels?.["riot:artifact_version_id"]?.values?.[0] ?? null;
    if (a) return a;
  }
  return null;
}

async function getLoLForRegion(region) {
  const candidates = SLUGS[region] || [region];
  for (const slug of candidates) {
    // 1) live JSON
    const live = await req(LIVE(slug));
    if (!live.ok || !live.json) continue;
    const { direct, artifact, manifestUrl } = pickFromLiveJson(live.json);

    // (a) artifact doğrudan varsa
    if (artifact) return { long: shorten(artifact), short: direct };

    // (b) manifestUrl varsa oradan dene
    if (manifestUrl) {
      const man = await req(manifestUrl);
      if (man.ok) {
        const art = artifactFrom(man);
        if (art) return { long: shorten(art), short: direct };
      }
    }

    // (c) yalnız "version: N" geldiyse, releases/N.* adaylarını dene
    if (direct) {
      const id = String(direct).trim();
      for (const url of REL_VARIANTS(id)) {
        const r = await req(url);
        if (r.ok) {
          const art = artifactFrom(r);
          if (art) return { long: shorten(art), short: id };
        }
      }
      // artifact çıkmadıysa en azından kısa sürümü döndür
      return { long: null, short: id };
    }
  }
  return { long: null, short: null };
}

// ---------- VGC sürüm ----------
async function getVGC() {
  const r = await req(VGC_URL);
  let v = r.json?.anticheat?.vanguard?.version ?? null;
  if (!v && r.text) {
    const m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return v;
}

// ---------- Discord ----------
async function postDiscord(content) {
  if (!DISCORD) { console.log("[DRY]\n" + content); return; }
  try {
    await fetch(DISCORD, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    console.error("Discord send error:", e.message);
  }
}

// ---------- Ana akış ----------
(async () => {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { lol: {}, vgc: null };

  // Tüm bölgeleri çek
  const perRegion = await Promise.all(REGIONS.map(async r => [r, await getLoLForRegion(r)]));
  const lolNow = Object.fromEntries(perRegion.map(([r, res]) => [r, res.long || res.short || null]));

  // VGC
  const vgcNow = await getVGC();

  // Değişiklik algıla + mesaj hazırla
  let anyChange = false;
  const blocks = [];

  for (const [region, res] of perRegion) {
    const current = res.long || res.short || null;
    const old = prev.lol?.[region] || null;
    if (current && current !== old) anyChange = true;

    const title = `🌍 $
