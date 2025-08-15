// LoL uzun build (örn. 15.16.704.6097) + VGC sürümü izleme
// Bölgeler: euw, na, kr, br, lan, tr  (LOL_REGIONS ile değiştirilebilir)
// - LoL: live-<slug>-win.json -> (artifact || manifest) -> uzun sürüm
//        olmazsa releases/<N>.*; o da olmazsa (bölgesel VE global) releaselisting -> solution/release manifest
//        hiçbiri yoksa kısa patchline (263 vb.) yazılır
// - VGC: "anticheat.vanguard.version" düz anahtarı + nested/regex fallback
// - Sadece değişince mesaj atar; test için ALWAYS_SEND=1 / DEBUG=1 kullan

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const STATE_DIR  = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const ALWAYS = process.env.ALWAYS_SEND === "1";
const DEBUG  = process.env.DEBUG === "1";

// ---- Bölge slug & listing kodları ----
const SLUGS = {
  euw: ["euw","euw1","eu-west"],
  na:  ["na","na1","north-america"],
  kr:  ["kr","kr1"],
  br:  ["br","br1"],
  lan: ["lan","la1","latam-north"],
  tr:  ["tr","tr1"]
};
const LISTING_REGION = { euw:"EUW", na:"NA", kr:"KR", br:"BR", lan:"LA1", tr:"TR" };

// ---- Riot URL'leri ----
const LIVE = s => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${s}-win.json`;
const RELS = id => [
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`
];
const LISTING = R => `https://lol.secure.dyn.riotcdn.net/releases/live/solutions/lol_game_client_sln/releases/releaselisting_${R}`;
// GLOBAL fallback (suffix yok)
const LISTING_GLOBAL_SOL = `https://lol.secure.dyn.riotcdn.net/releases/live/solutions/lol_game_client_sln/releases/releaselisting`;
const LISTING_GLOBAL_PROJ = `https://lol.secure.dyn.riotcdn.net/releases/live/projects/lol_game_client/releases/releaselisting`;

const SOLMAN  = id => `https://lol.secure.dyn.riotcdn.net/releases/live/solutions/lol_game_client_sln/releases/${id}/solutionmanifest`;
const PROJMAN = id => `https://lol.secure.dyn.riotcdn.net/releases/live/projects/lol_game_client/releases/${id}/releasemanifest`;

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---- HTTP helpers ----
async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"lol-vgc-watch/1.0" } });
    const t = await r.text();
    return { ok:r.ok, status:r.status, text:t };
  } catch { return { ok:false, status:0, text:"" }; }
}
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"lol-vgc-watch/1.0", "Accept":"application/json" } });
    const t = await r.text();
    let j=null; try { j = JSON.parse(t); } catch {}
    return { ok:r.ok, status:r.status, json:j, text:t };
  } catch { return { ok:false, status:0, json:null, text:"" }; }
}
const shorten = v => (v ? String(v).split("+")[0] : null);

// ---- JSON yardımcıları ----
function fromLiveLoose(live) {
  const obj = live.json;
  const text = live.text || "";

  let direct = null;
  let artifact = null;
  let manifestUrl = null;

  if (obj && obj.version != null) direct = String(obj.version);

  // Metin tabanlı artifact
  {
    const m = text.match(/"riot:artifact_version_id"\s*:\s*{[^}]*"values"\s*:\s*\[\s*"([^"]+)"/i);
    if (m) artifact = m[1];
  }
  // Metin tabanlı manifest URL
  {
    const m = text.match(/"download"\s*:\s*{[^}]*"url"\s*:\s*"([^"]+\/channels\/public\/releases\/[^"]+\.manifest)"/i);
    if (m) manifestUrl = m[1];
  }
  // Nesne ağacı üzerinde güvenli yürüyüş
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const labels = node.labels;
    if (!artifact && labels && typeof labels === "object") {
      const a = labels["riot:artifact_version_id"];
      if (a?.values?.[0]) artifact = a.values[0];
    }
    if (!manifestUrl && node.download?.url && typeof node.download.url === "string") {
      if (node.download.url.includes("/channels/public/releases/") && node.download.url.endsWith(".manifest")) {
        manifestUrl = node.download.url;
      }
    }
    for (const k in node) if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
  };
  if (obj) walk(obj);

  return { direct, artifact, manifestUrl, peek: text.slice(0, 160).replace(/\s+/g," ") };
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
const pickReleaseId = txt => {
  const m = txt.match(/\b\d+\.\d+\.\d+\.\d+\b/); // 0.0.0.#### benzeri
  return m ? m[0] : null;
};

// ---- LoL ana fonksiyonu ----
async function getLol(region){
  const tried = [];
  const cands = SLUGS[region] || [region];

  let shortCandidate = null;

  // 1) live-<slug>-win.json ve türevleri
  for (const slug of cands) {
    const liveUrl = LIVE(slug);
    const live = await fetchJSON(liveUrl);
    tried.push(`live:${slug}:${live.status}`);
    if (!live.ok || (!live.json && !live.text)) continue;

    const { direct, artifact, manifestUrl, peek } = fromLiveLoose(live);
    if (DEBUG && peek) tried.push(`livepeek:${peek}`);

    if (artifact) return { value: shorten(artifact), debug: tried.concat("artifact:live") };

    if (manifestUrl) {
      const man = manifestUrl.endsWith(".json") ? await fetchJSON(manifestUrl) : await fetchText(manifestUrl);
      tried.push(`manifestUrl:${man.status}`);
      if (man.ok) {
        const art = artifactFrom(man.text, man.json || null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:manifestUrl") };
      }
    }

    if (direct && !shortCandidate) shortCandidate = String(direct).trim();

    // direct varsa releases/<N>.* dene
    if (direct) {
      const id = String(direct).trim();
      for (const url of RELS(id)) {
        const resp = url.endsWith(".json") ? await fetchJSON(url) : await fetchText(url);
        const key = url.includes("/releases/") ? url.split("/releases/")[1] : url;
        tried.push(`${key}:${resp.status}`);
        if (resp.ok) {
          const art = artifactFrom(resp.text, resp.json || null);
          if (art) return { value: shorten(art), debug: tried.concat("artifact:releases") };
        }
      }
    }
  }

  // 2) Bölgesel releaselisting (EUW/NA/KR/BR/LA1/TR)
  const R = LISTING_REGION[region] || region.toUpperCase();
  const list = await fetchText(LISTING(R));
  tried.push(`releaselisting_${R}:${list.status}`);
  if (list.ok && list.text) {
    const relId = pickReleaseId(list.text);
    if (relId) {
      const sol = await fetchText(SOLMAN(relId));
      tried.push(`solutionmanifest:${sol.status}`);
      if (sol.ok) {
        const art = artifactFrom(sol.text, null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:solutionmanifest") };
      }
      const prm = await fetchText(PROJMAN(relId));
      tried.push(`releasemanifest:${prm.status}`);
      if (prm.ok) {
        const art = artifactFrom(prm.text, null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:releasemanifest") };
      }
    }
  }

  // 3) GLOBAL releaselisting fallback (suffix yok)
  const gl1 = await fetchText(LISTING_GLOBAL_SOL);
  tried.push(`releaselisting_global_sol:${gl1.status}`);
  if (gl1.ok && gl1.text) {
    const rid = pickReleaseId(gl1.text);
    if (rid) {
      const sol = await fetchText(SOLMAN(rid));
      tried.push(`solutionmanifest(global):${sol.status}`);
      if (sol.ok) {
        const art = artifactFrom(sol.text, null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:solutionmanifest(global)") };
      }
      const prm = await fetchText(PROJMAN(rid));
      tried.push(`releasemanifest(global):${prm.status}`);
      if (prm.ok) {
        const art = artifactFrom(prm.text, null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:releasemanifest(global)") };
      }
    }
  }

  const gl2 = await fetchText(LISTING_GLOBAL_PROJ);
  tried.push(`releaselisting_global_proj:${gl2.status}`);
  if (gl2.ok && gl2.text) {
    const rid = pickReleaseId(gl2.text);
    if (rid) {
      const sol = await fetchText(SOLMAN(rid));
      tried.push(`solutionmanifest(global2):${sol.status}`);
      if (sol.ok) {
        const art = artifactFrom(sol.text, null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:solutionmanifest(global2)") };
      }
      const prm = await fetchText(PROJMAN(rid));
      tried.push(`releasemanifest(global2):${prm.status}`);
      if (prm.ok) {
        const art = artifactFrom(prm.text, null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:releasemanifest(global2)") };
      }
    }
  }

  // 4) Kısa patchline'a düş
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
