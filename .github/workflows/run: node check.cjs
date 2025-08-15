// LoL uzun build (örn. 15.16.704.6097) + VGC sürümü izleme
// Bölgeler: euw, na, kr, br, lan, tr  (LOL_REGIONS ile değiştirilebilir)
// - LoL: live-<slug>-win.json -> (artifact || manifest) -> uzun sürüm
//        Bulunamazsa kısa patchline (263 vb.) döner
// - VGC: "anticheat.vanguard.version" düz anahtarı + regex fallback
// - Değişince mesaj atar; test için ALWAYS_SEND=1 / DEBUG=1 kullan

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const STATE_DIR  = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const ALWAYS = process.env.ALWAYS_SEND === "1";
const DEBUG  = process.env.DEBUG === "1";

// ---- Bölge slug haritası ----
const SLUGS = {
  euw: ["euw","euw1","eu-west"],
  na:  ["na","na1","north-america"],
  kr:  ["kr","kr1"],
  br:  ["br","br1"],
  lan: ["lan","la1","latam-north"],
  tr:  ["tr","tr1"]
};

// ---- URL yardımcıları ----
const LIVE = s => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${s}-win.json`;

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---- HTTP helpers (Node 20'de global fetch var) ----
async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"lol-vgc-watch/1.0" } });
    const t = await r.text();
    return { ok:r.ok, status:r.status, text:t };
  } catch {
    return { ok:false, status:0, text:"" };
  }
}
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"lol-vgc-watch/1.0", "Accept":"application/json" } });
    const t = await r.text();
    let j=null; try { j = JSON.parse(t); } catch {}
    return { ok:r.ok, status:r.status, json:j, text:t };
  } catch {
    return { ok:false, status:0, json:null, text:"" };
  }
}
const shorten = v => (v ? String(v).split("+")[0] : null);

// ---- JSON yardımcıları ----
function fromLiveLoose(live) {
  // Amaç: JSON yapısı değişse bile (a) artifact, (b) releases manifest URL yakalamak
  const obj = live.json;
  const text = live.text || "";

  let direct = null;
  // 1) direct patchline
  if (obj && obj.version != null) direct = String(obj.version);

  // 2) JSON üzerinde geniş arama (artifact + manifest)
  let artifact = null;
  let manifestUrl = null;

  // 2a) Metin tabanlı artifact yakalama
  // "riot:artifact_version_id": { "values": ["15.16.704.6097+..."] }
  {
    const m = text.match(/"riot:artifact_version_id"\s*:\s*{[^}]*"values"\s*:\s*\[\s*"([^"]+)"\s*\]/i);
    if (m) artifact = m[1];
  }

  // 2b) Metin tabanlı manifest URL yakalama
  // "download":{"url":"https://.../channels/public/releases/<HEX>.manifest" ...}
  {
    const m = text.match(/"download"\s*:\s*{[^}]*"url"\s*:\s*"([^"]+\/channels\/public\/releases\/[^"]+\.manifest)"/i);
    if (m) manifestUrl = m[1];
  }

  // 2c) Nesne ağacında emniyetli arama (labels + id + download.url)
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    // labels
    const labels = node.labels;
    if (!artifact && labels && typeof labels === "object") {
      const a = labels["riot:artifact_version_id"];
      if (a?.values?.[0]) artifact = a.values[0];
    }
    // release.id -> gerekirse
    if (!manifestUrl && node.download?.url && typeof node.download.url === "string") {
      if (node.download.url.includes("/channels/public/releases/") && node.download.url.endsWith(".manifest")) {
        manifestUrl = node.download.url;
      }
    }
    for (const k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
    }
  };
  if (obj) walk(obj);

  return { direct, artifact, manifestUrl, peek: text.slice(0, 180).replace(/\s+/g," ") };
}

function artifactFrom(text, json) {
  // Metin → artifact
  if (text) {
    const m = text.match(/riot:artifact_version_id[^"\n]*"([^"]+)"/);
    if (m) return m[1];
  }
  // JSON → artifact
  if (json) {
    const a =
      json?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] ||
      json?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
    if (a) return a;
  }
  return null;
}

// ---- LoL ana fonksiyon ----
async function getLol(region){
  const tried = [];
  const cands = SLUGS[region] || [region];

  let shortCandidate = null;

  // live-<slug>-win.json
  for (const slug of cands) {
    const liveUrl = LIVE(slug);
    const live = await fetchJSON(liveUrl);
    tried.push(`live:${slug}:${live.status}`);

    if (!live.ok || (!live.json && !live.text)) continue;

    // JSON/metin içinden geniş tarama
    const { direct, artifact, manifestUrl, peek } = fromLiveLoose(live);
    if (DEBUG && peek) tried.push(`livepeek:${peek}`);

    // (a) artifact doğrudan varsa
    if (artifact) {
      return { value: shorten(artifact), debug: tried.concat("artifact:live") };
    }

    // (b) manifest URL verdiyse, oradan artifact dene
    if (manifestUrl) {
      const man = manifestUrl.endsWith(".json") ? await fetchJSON(manifestUrl) : await fetchText(manifestUrl);
      tried.push(`manifestUrl:${man.status}`);
      if (man.ok) {
        const art = artifactFrom(man.text, man.json || null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:manifestUrl") };
      }
    }

    // (c) kısa sürümü aday tut
    if (direct && !shortCandidate) shortCandidate = String(direct).trim();
  }

  if (shortCandidate) return { value: shortCandidate, debug: tried.concat("fallback:short") };
  return { value: null, debug: tried.concat("no-hit") };
}

// ---- VGC ----
async function getVgc(){
  const r = await fetchJSON(VGC_URL);
  let v = null;
  if (r.json) {
    v = r.json["anticheat.vanguard.version"]
     || r.json?.anticheat?.vanguard?.version
     || null;
  }
  if (!v && r.text) {
    let m = r.text.match(/"anticheat\.vanguard\.version"\s*:\s*"([^"]+)"/i);
    if (!m) m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return { v, status: r.status, peek: (r.text || "").slice(0,120).replace(/\s+/g," ") };
}

// ---- Discord ----
async function postDiscord(msg){
  if (!DISCORD) { console.log("[DRY]\n"+msg); return; }
  try {
    const r = await fetch(DISCORD, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ content: msg })
    });
    if (DEBUG) console.log("Discord status:", r.status);
  } catch(e) {
    console.error("Discord send error:", e.message);
  }
}

// ---- main ----
(async function(){
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive:true });
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { lol:{}, vgc:null };

  const results = await Promise.all(REGIONS.map(async r => [r, await getLol(r)]));
  const lolNow  = Object.fromEntries(results.map(([r,obj]) => [r, obj.value]));

  const vgc = await getVgc();

  let any = false;
  const lines = ["📊 Versions"];
  for (const [region, obj] of results) {
    const cur = obj.value || null;
    const old = prev.lol?.[region] || null;
    if (cur && cur !== old) any = true;

    lines.push(`🌍 ${region.toUpperCase()}`);
    lines.push(`① 🎮 OLD LOL version ➜ ${old || "—"}`);
    lines.push(`② 🔴 Latest LOL version       ➜ ${cur || "—"}`);
    if (DEBUG) lines.push(`↳ debug: ${obj.debug.join(" | ")}`);
  }

  if (vgc.v && vgc.v !== (prev.vgc || null)) any = true;
  lines.push("────────────────────────────────");
  lines.push(`③ 🛡️ OLD VGC version ➜ ${prev.vgc || "—"}`);
  lines.push(`④ 🟢 Latest VGC version       ➜ ${vgc.v || "—"}${DEBUG ? ` (status:${vgc.status}, peek:${vgc.peek})` : ""}`);

  if (any || ALWAYS || DEBUG) {
    await postDiscord(lines.join("\n"));
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lol: lolNow, vgc: vgc.v || null }, null, 2), "utf8");
    console.log("Message sent & state updated.");
  } else {
    console.log("No changes.");
  }
})();
