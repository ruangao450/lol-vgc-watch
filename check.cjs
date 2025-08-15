// LoL uzun build (15.16.704.6097) + VGC sürümü izleme
// - Bölgeler: EUW, NA, KR, BR, LAN, TR
// - Değişince Discord'a gönderir (ALWAYS_SEND=1 ise her seferinde gönderir)

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");
const ALWAYS = process.env.ALWAYS_SEND === "1";

const SLUGS = {
  euw: ["euw", "euw1", "eu-west"],
  na:  ["na", "na1", "north-america"],
  kr:  ["kr", "kr1"],
  br:  ["br", "br1"],
  lan: ["lan", "la1", "latam-north"],
  tr:  ["tr", "tr1"]
};

const LIVE = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
const RELS = id => [
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`
];
const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

async function fetchText(url){
  try{
    const r = await fetch(url,{headers:{"User-Agent":"lol-vgc-watch/1.0"}});
    return {ok:r.ok,status:r.status,text:await r.text()};
  }catch(e){
    return {ok:false,status:0,text:""};
  }
}
async function fetchJSON(url){
  try{
    const r = await fetch(url,{headers:{"User-Agent":"lol-vgc-watch/1.0","Accept":"application/json"}});
    const t = await r.text();
    let j=null; try{ j=JSON.parse(t);}catch(e){}
    return {ok:r.ok,status:r.status,json:j,text:t};
  }catch(e){
    return {ok:false,status:0,json:null,text:""};
  }
}
const shorten = v => v ? String(v).split("+")[0] : null;

function parseLive(obj){
  const direct = (obj && obj.version!=null) ? String(obj.version) : null; // 263 vb.
  const artifact = obj?.releases?.[0]?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
  const manifest = obj?.releases?.[0]?.download?.url || null;
  return {direct,artifact,manifest};
}
function artifactFrom(text,json){
  if(text){
    const m = text.match(/riot:artifact_version_id[^"\n]*"([^"]+)"/);
    if(m) return m[1];
  }
  if(json){
    const a = json?.release?.labels?.["riot:artifact_version_id"]?.values?.[0]
           || json?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
    if(a) return a;
  }
  return null;
}

async function getLol(region){
  const cands = SLUGS[region] || [region];
  for(const slug of cands){
    const live = await fetchJSON(LIVE(slug));
    if(!live.ok || !live.json) continue;

    const {direct,artifact,manifest} = parseLive(live.json);
    if(artifact) return shorten(artifact) || direct || null;

    if(manifest){
      const man = manifest.endsWith(".json") ? await fetchJSON(manifest) : await fetchText(manifest);
      if(man.ok){
        const art = artifactFrom(man.text, man.json || null);
        if(art) return shorten(art) || direct || null;
      }
    }

    if(direct){
      for(const url of RELS(direct)){
        const resp = url.endsWith(".json") ? await fetchJSON(url) : await fetchText(url);
        if(resp.ok){
          const art = artifactFrom(resp.text, resp.json || null);
          if(art) return shorten(art) || String(direct);
        }
      }
      return String(direct);
    }
  }
  return null;
}

async function getVgc(){
  const r = await fetchJSON(VGC_URL);
  let v = r.json?.anticheat?.vanguard?.version || null;
  if(!v && r.text){
    const m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if(m) v = m[1];
  }
  return v;
}

async function postDiscord(msg){
  if(!DISCORD){ console.log("[DRY]\n"+msg); return; }
  try{
    const r = await fetch(DISCORD,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:msg})});
    console.log("Discord status:", r.status);
  }catch(e){
    console.error("Discord send error:", e.message);
  }
}

(async function(){
  if(!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR,{recursive:true});
  const prev = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE,"utf8")) : {lol:{},vgc:null};

  const pairs = await Promise.all(REGIONS.map(async r => [r, await getLol(r)]));
  const lolNow = Object.fromEntries(pairs);
  const vgcNow = await getVgc();

  let any = false;
  const lines = ["📊 Versions"];
  for(const [region,ver] of pairs){
    const old = prev.lol?.[region] || null;
    if(ver && ver !== old) any = true;
    lines.push(`🌍 ${region.toUpperCase()}`);
    lines.push(`① 🎮 OLD LOL version ➜ ${old || "—"}`);
    lines.push(`② 🔴 Latest LOL version       ➜ ${ver || "—"}`);
  }
  if(vgcNow && vgcNow !== (prev.vgc || null)) any = true;
  lines.push("────────────────────────────────");
  lines.push(`③ 🛡️ OLD VGC version ➜ ${prev.vgc || "—"}`);
  lines.push(`④ 🟢 Latest VGC version       ➜ ${vgcNow || "—"}`);

  if(any || ALWAYS){
    await postDiscord(lines.join("\n"));
    fs.writeFileSync(STATE_FILE, JSON.stringify({lol:lolNow, vgc:vgcNow}, null, 2), "utf8");
    console.log("Message sent & state updated.");
  }else{
    console.log("No changes.");
  }
})();
