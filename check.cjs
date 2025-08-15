// LoL uzun build (15.16.704.x) + VGC sürümü izleme (bölgeler: euw, na, kr, br, lan, tr)
// - Önce live-<slug>-win.json -> (artifact || manifest) -> uzun sürüm
// - Olmazsa releases/<N>.* dener
// - Olmazsa "releaselisting_<REGION> -> solutionmanifest" fallback'ı dener
// - VGC: 'anticheat.vanguard.version' düz anahtarını ve regex fallback'ı okur
// - ONLY CHANGE'de mesaj atar; test için ALWAYS_SEND=1 kullanabilirsin

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");
const ALWAYS = process.env.ALWAYS_SEND === "1";
const DEBUG  = process.env.DEBUG === "1";

// ----- bölge slug/region kodları -----
const SLUGS = {
  euw: ["euw","euw1","eu-west"],
  na:  ["na","na1","north-america"],
  kr:  ["kr","kr1"],
  br:  ["br","br1"],
  lan: ["lan","la1","latam-north"],
  tr:  ["tr","tr1"]
};
// releaselisting bölge kodları (büyük harf)
const LISTING_REGION = { euw:"EUW", na:"NA", kr:"KR", br:"BR", lan:"LA1", tr:"TR" };

// ----- URL yardımcıları -----
const LIVE = s => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${s}-win.json`;
const RELS = id => [
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`,
];
const LISTING = R => `https://lol.secure.dyn.riotcdn.net/releases/live/solutions/lol_game_client_sln/releases/releaselisting_${R}`;
const SOLMAN  = id => `https://lol.secure.dyn.riotcdn.net/releases/live/solutions/lol_game_client_sln/releases/${id}/solutionmanifest`;
const PROJMAN = id => `https://lol.secure.dyn.riotcdn.net/releases/live/projects/lol_game_client/releases/${id}/releasemanifest`;

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ----- HTTP helpers -----
async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "lol-vgc-watch/1.0" } });
    const t = await r.text();
    return { ok: r.ok, status: r.status, text: t };
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
const shorten = v => v ? String(v).split("+")[0] : null;

// ----- LoL çıkarıcılar -----
function fromLive(obj){
  const direct   = (obj && obj.version!=null) ? String(obj.version) : null; // 263 vb.
  const artifact = obj?.releases?.[0]?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
  const manifest = obj?.releases?.[0]?.download?.url || null;
  return { direct, artifact, manifest };
}
function artifactFrom(text, json){
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
  // releaselisting_* içinde en yeni sürüm en üstte olur; 0.0.0.### gibi sürümü yakala
  const m = txt.match(/\b\d+\.\d+\.\d+\.\d+\b/);
  return m ? m[0] : null;
};

// ----- LoL ana fonksiyon -----
async function getLol(region){
  const tried = [];
  const cands = SLUGS[region] || [region];

  // 1) live-<slug>-win.json
  for (const slug of cands) {
    const live = await fetchJSON(LIVE(slug));
    tried.push(`live:${slug}:${live.status}`);
    if (!live.ok || !live.json) continue;

    const { direct, artifact, manifest } = fromLive(live.json);

    if (artifact) return { value: shorten(artifact), debug: tried.concat("artifact:live") };

    if (manifest) {
      const man = manifest.endsWith(".json") ? await fetchJSON(manifest) : await fetchText(manifest);
      tried.push(`manifestUrl:${man.status}`);
      if (man.ok) {
        const art = artifactFrom(man.text, man.json || null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:manifestUrl") };
      }
    }

    if (direct) {
      const id = String(direct).trim();
      for (const u of RELS(id)) {
        const r = u.endsWith(".json") ? await fetchJSON(u) : await fetchText(u);
        const key = u.includes("/releases/") ? u.split("/releases/")[1] : u;
        tried.push(`${key}:${r.status}`);
        if (r.ok) {
          const art = artifactFrom(r.text, r.json || null);
          if (art) return { value: shorten(art), debug: tried.concat("artifact:releases") };
        }
      }
      // live JSON verdiği kısa sürümü en azından döndür
      return { value: id, debug: tried.concat("fallback:short") };
    }
  }

  // 2) releaselisting_<REGION> -> solutionmanifest / releasemanifest
  const R = (LISTING_REGION[region] || region.toUpperCase());
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

  return { value: null, debug: tried.concat("no-hit") };
}

// ----- VGC -----
async function getVgc(){
  const r = await fetchJSON(VGC_URL);
  // 1) düz anahtar (en güvenilir)
  let v = null;
  if (r.json) {
    v = r.json["anticheat.vanguard.version"]
     || r.json?.anticheat?.vanguard?.version
     || null;
  }
  // 2) regex fallback
  if (!v && r.text) {
    let m = r.text.match(/"anticheat\.vanguard\.version"\s*:\s*"([^"]+)"/i);
    if (!m) m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return { v, status: r.status, peek: (r.text || "").slice(0, 120).replace(/\s+/g," ") };
}

// ----- Discord -----
async function postDiscord(msg){
  if (!DISCORD) { console.log("[DRY]\n"+msg); return; }
  try {
    const r = await fetch(DISCORD, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: msg })
    });
    if (DEBUG) console.log("Discord status:", r.status);
  } catch(e) {
    console.error("Discord send error:", e.message);
  }
}

// ----- main -----
(async function(){
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive:true });
  const prev = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { lol:{}, vgc:null };

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
