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
    const m = text.match(/riot:artifact_versi_
