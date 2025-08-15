// VGC Version Watch — Always warn on Riot updates until you bump SUPPORTED_VGC

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const SUPPORTED = process.env.SUPPORTED_VGC || "1.17.12.4";
const ALWAYS    = process.env.ALWAYS_SEND === "1";           // test mode
const DEBUG     = process.env.DEBUG === "1";
const ALERT_ON_MISMATCH = process.env.ALERT_ON_MISMATCH === "1";

// Mentions (optional)
const MENTION_ALERT = process.env.MENTION || "";             // ping on mismatch
const MENTION_SAFE  = process.env.MENTION_SAFE || "";        // ping when compatibility restored

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";
const ICON    = "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f6e1.png"; // 🛡️

async function fetchJSON(url){
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"vgc-watch/2.4", "Accept":"application/json" } });
    const text = await r.text();
    let json=null; try{ json=JSON.parse(text); }catch{}
    return { ok:r.ok, status:r.status, json, text };
  } catch { return { ok:false, status:0, json:null, text:"" }; }
}

async function sendEmbed(embed, content){
  const body = { embeds:[embed] };
  if (content) body.content = content;
  if (!DISCORD) { console.log("[DRY EMBED]", JSON.stringify(body,null,2)); return; }
  const r = await fetch(DISCORD, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if (DEBUG) console.log("Discord status:", r.status);
}

async function getVgc(){
  const res = await fetchJSON(VGC_URL);
  let v=null;
  if (res.json) v = res.json["anticheat.vanguard.version"] ?? res.json?.anticheat?.vanguard?.version ?? null;
  if (!v && res.text){
    let m = res.text.match(/"anticheat\.vanguard\.version"\s*:\s*"([^"]+)"/i)
          || res.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return { v, status:res.status, peek:(res.text||"").slice(0,110).replace(/\s+/g," ") };
}

(async function(){
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR,{recursive:true});

  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE,"utf8"))
    : { vgc:null, changedAt:null, mismatch:false, supported: SUPPORTED };

  const { v:newV, status, peek } = await getVgc();
  const oldV = prev.vgc ?? null;

  const firstRun       = oldV === null;
  const versionChanged = !firstRun && newV && newV !== oldV;       // Riot yeni VGC yayınladı
  const mismatch       = newV && newV !== SUPPORTED;               // henüz desteklemiyorsun (kırmızı)

  // Daha güvenli "compat restored" (yalnız geçmişte mismatch vardıysa ve SUPPORTED’ı yeni sürüme çektiysen)
  const hadPrevSupported = typeof prev.supported === "string" && prev.supported.length > 0;
  const oldMismatch = (typeof prev.mismatch === "boolean")
    ? prev.mismatch
    : (hadPrevSupported ? !!(prev.vgc && prev.vgc !== prev.supported) : false);
  const supportedChanged = hadPrevSupported ? (prev.supported !== SUPPORTED) : false;
  const compatRestored = !!(!firstRun && supportedChanged && oldMismatch === true && !mismatch && newV && newV === SUPPORTED);

  // Zamanlar (UTC)
  const now = new Date();
  const nowISO = now.toISOString();
  const nowUnix = Math.floor(now.getTime()/1000);

  // Riot VGC güncellendiğinde o anı kaydet (ilk tespit edildiği an)
  const changedAtISO = versionChanged ? nowISO : (prev.changedAt || null);
  const changedAtUnix = changedAtISO ? Math.floor(new Date(changedAtISO).getTime()/1000) : null;

  // Renkler
  const COLOR_OK   = 0x2ecc71; // yeşil
  const COLOR_INFO = 0x7f8c8d; // gri
  const COLOR_WARN = 0xe74c3c; // kırmızı

  // Üst iki satır
  const headerLines =
    `**Supported VGC Version** ➜ \`${SUPPORTED}\`\n` +
    `**Updated VGC Version** ➜ \`${newV || "—"}\``;

  // Açıklama: İSTEDİĞİN MANTIK — "Updated" YEŞİL YOK; yalnızca:
  // - mismatch -> KIRMIZI uyarı
  // - compatRestored -> YEŞİL "Software updated"
  // - diğerleri -> GRİ "Up-to-date (safe)"
  let description, color;
  if (compatRestored) {
    description = `✅ **Software updated**\nIt is now safe to use the software with the new VGC version.\n\n${headerLines}`;
    color = COLOR_OK;
  } else if (mismatch) {
    description = `⚠️ **Action required**\n🛑 Please stop using the software until a compatibility update is released.\n\n${headerLines}`;
    color = COLOR_WARN;
  } else {
    description = `ℹ️ **Up-to-date**\n✅ Software is up-to-date and safe to use with the current VGC version.\n\n${headerLines}`;
    color = COLOR_INFO;
  }

  const fields = [
    {
      name: "🆙 VGC updated at",
      value: changedAtUnix ? `<t:${changedAtUnix}:F> • <t:${changedAtUnix}:R>` : "—",
      inline: false
    }
  ];
