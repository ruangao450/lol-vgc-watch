// LoL uzun build (15.16.704.6097 gibi) + VGC sürümü izleme
// - Bölgeler: EUW, NA, KR, BR, LAN, TR
// - Değişince Discord'a "OLD → Latest" gönderir (ALWAYS_SEND=1 ise her seferinde gönderir)
// - State: .state/versions.json

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");
const ALWAYS_SEND = process.env.ALWAYS_SEND === "1";

// Bölge slug adayları (ilk başarılı olan kullanılır)
const SLUGS = {
  euw: ["euw", "euw1", "eu-west"],
  na:  ["na", "na1", "north-america"],
  kr:  ["kr", "kr1"],
  br:  ["br", "br1"],
  lan: ["lan", "la1", "latam-north"],
  tr:  ["tr", "tr1"]
};

// Riot CDN URL yardımcıları
const LIVE = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
const RELS = id => [
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`
];

// Vanguard public config
const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---- HTTP yardımcıları (Node 20'de global fetch var) ----
async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "lol-vgc-watch/1.0" } });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch {
    return { ok: false, status: 0, text: "" };
  }
}
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "lol-vgc-watch/1.0", "Accept": "application/json" } });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { ok: r.ok, status: r.status, json: j, text: t };
  } catch {
    return { ok: false, status: 0, json: null, text: "" };
  }
}
const shorten = s => (s ? String(s).split("+")[0] : null);

// ---- LoL sürüm çıkarma ----
function pickFromLive(obj) {
  const direct = obj && obj.version != null ? String(obj.version) : null; // 263 gibi
  const artifact =
    obj?.releases?.[0]?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
  const manifestUrl = obj?.releases?.[0]?.download?.url || null;
  return { direct, artifact, manifestUrl };
}
function artifactFrom(text, json) {
  if (text) {
    const m = text.match(/riot:artifact_version_id[^"\n]*"([^"]+)"/);
    if (m) return m[1];
  }
  if (json) {
    const a =
      json?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] ||
      json?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
    if (a) return a;
  }
  return null;
}
async function getLoLRegion(region) {
  const candidates = SLUGS[region] || [region];
  for (const slug of candidates) {
    // 1) live JSON
    const live = await fetchJSON(LIVE(slug));
    if (!live.ok || !live.json) continue;

    const { direct, artifact, manifestUrl } = pickFromLive(live.json);
    if (artifact) return shorten(artifact) || direct || null;

    // 2) live JSON manifest URL veriyorsa
    if (manifestUrl) {
      const man = await fetchText(manifestUrl);
      if (man.ok) {
        const art = artifactFrom(man.text, null);
        if (art) return shorten(art) || direct || null;
      }
    }

    // 3) sadece version N geldiyse releases/N.* dene
    if (direct) {
      for (const u of RELS(direct)) {
        const man = u.endsWith(".json") ? await fetchJSON(u) : await fetchText(u);
        if (man.ok) {
          const art = artifactFrom(man.text, man.json);
          if (art) return shorten(art) || String(direct);
        }
      }
      // artifact yoksa kısa sürümü döndür
      return String(direct);
    }
  }
  return null;
}

// ---- VGC sürümü ----
async function getVGC() {
  const r = await fetchJSON(VGC_URL);
  let v = r.json?.anticheat?.vanguard?.version || null;
  if (!v && r.text) {
    const m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return v;
}

// ---- Discord ----
async function postDiscord(message) {
  if (!DISCORD) { console.log("[DRY]\n" + message); return; }
  try {
    const r = await fetch(DISCORD, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message })
    });
    console.log("Discord status:", r.status);
  } catch (e) {
    console.error("Discord send error:", e.message);
  }
}

// ---- Main ----
(async function main() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { lol: {}, vgc: null };

  // LoL bölgeleri
  const results = await Promise.all(REGIONS.map(async r => [r, await getLoLRegion(r)]));
  const lolNow = Object.fromEntries(results.map(([r, v]) => [r, v]));

  // VGC
  const vgcNow = await getVGC();

  // Değişiklik var mı?
  let anyChange = false;
  const blocks = [];
  for (const [region, ver] of results) {
    const old = prev.lol?.[region] || null;
    if (ver && ver !== old) anyChange = true;
    blocks.push(`🌍 ${region.toUpperCase()}\n① 🎮 OLD LOL version ➜ ${old || "—"}\n② 🔴 Latest LOL version       ➜ ${ver || "—"}`);
  }
  if (vgcNow && vgcNow !== (prev.vgc || null)) anyChange = true;

  const vgcBlock = `③ 🛡️ OLD VGC version ➜ ${prev.vgc || "—"}\n④ 🟢 Latest VGC version       ➜ ${vgcNow || "—"}`;

  if (anyChange || ALWAYS_SEND) {
    const msg = ["📊 Versions", ...blocks, "────────────────────────────────", vgcBlock].join("\n");
    await postDiscord(msg);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lol: lolNow, vgc: vgcNow }, null, 2), "utf8");
    console.log("Message sent & state updated.");
  } else {
    console.log("No changes.");
  }
})();
