// Vanguard (VGC) sürüm izleyici
// - Kaynak: https://clientconfig.rpg.riotgames.com/api/v1/config/public
// - "anticheat.vanguard.version" düz anahtarı ve nested/regex fallback destekli
// - Sadece değişince Discord'a mesaj atar (ALWAYS_SEND=1 ile her seferinde atar)

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const STATE_DIR  = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const ALWAYS = process.env.ALWAYS_SEND === "1";
const DEBUG  = process.env.DEBUG === "1";

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// --- HTTP yardımcıları (Node 20'de global fetch var) ---
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"vgc-watch/1.0", "Accept":"application/json" } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch {
    return { ok:false, status:0, json:null, text:"" };
  }
}

async function postDiscord(content) {
  if (!DISCORD) { console.log("[DRY]\n" + content); return; }
  try {
    const r = await fetch(DISCORD, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ content })
    });
    if (DEBUG) console.log("Discord status:", r.status);
  } catch (e) {
    console.error("Discord send error:", e.message);
  }
}

// --- VGC sürümünü çıkar ---
async function getVgcVersion() {
  const res = await fetchJSON(VGC_URL);
  let v = null;

  // 1) Düz anahtar
  if (res.json && typeof res.json === "object") {
    v = res.json["anticheat.vanguard.version"]
     || res.json?.anticheat?.vanguard?.version
     || null;
  }
  // 2) Regex fallback (şema değişirse)
  if (!v && res.text) {
    let m = res.text.match(/"anticheat\.vanguard\.version"\s*:\s*"([^"]+)"/i);
    if (!m) m = res.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }

  return { version: v, status: res.status, peek: (res.text || "").slice(0, 120).replace(/\s+/g," ") };
}

// --- main ---
(async function main(){
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive:true });

  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { vgc: null };

  const vgc = await getVgcVersion();
  const oldV = prev.vgc || null;
  const newV = vgc.version || null;

  const changed = newV && newV !== oldV;

  if (changed || ALWAYS) {
    const lines = [
      "📊 VGC Version",
      `① 🛡️ OLD VGC version ➜ ${oldV || "—"}`,
      `② 🟢 Latest VGC version ➜ ${newV || "—"}${DEBUG ? ` (status:${vgc.status}, peek:${vgc.peek})` : ""}`
    ];
    await postDiscord(lines.join("\n"));
    fs.writeFileSync(STATE_FILE, JSON.stringify({ vgc: newV }, null, 2), "utf8");
    console.log("Message sent & state updated.");
  } else {
    console.log("No changes.");
  }
})().catch(async (e) => {
  console.error("Fatal error:", e);
  if (process.env.POST_ERRORS === "1") {
    await postDiscord(`❌ VGC watcher error: ${e?.message || e}`);
  }
  process.exit(1);
});
