// VGC Version Watch — voice channel status + embeds
// - When Riot updates VGC -> red voice channel + "Action required" embed
// - When you bump SUPPORTED_VGC to new version -> green voice channel + "Software updated" embed

const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || "";
const BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN || ""; // needs Manage Channels
const VOICE_CHANNEL_ID= process.env.VOICE_CHANNEL_ID || "";  // target voice channel

const STATE_DIR  = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const SUPPORTED  = process.env.SUPPORTED_VGC || "1.17.12.4";
const ALWAYS     = process.env.ALWAYS_SEND === "1";        // testing: send every run
const DEBUG      = process.env.DEBUG === "1";
const ALERT_ON_MISMATCH = process.env.ALERT_ON_MISMATCH === "1";

const MENTION_ALERT = process.env.MENTION || "";
const MENTION_SAFE  = process.env.MENTION_SAFE || "";

const ICON = "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f6e1.png";
const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---------- HTTP helpers ----------
async function fetchJSON(url){
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"vgc-watch/2.5", "Accept":"application/json" } });
    const t = await r.text();
    let j=null; try{ j=JSON.parse(t);}catch{}
    return { ok:r.ok, status:r.status, json:j, text:t };
  } catch(e){ return { ok:false, status:0, json:null, text:"" }; }
}

async function postWebhook(content){
  if (!DISCORD_WEBHOOK){ console.log("[DRY webhook]\n"+content); return; }
  await fetch(DISCORD_WEBHOOK, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(content)
  });
}

async function discordBot(path, method="GET", body){
  if (!BOT_TOKEN) return { ok:false, status:0, text:"", json:null, skipped:true };
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers:{
      "Authorization": `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text(); let j=null; try{ j=JSON.parse(t);}catch{}
  return { ok:r.ok, status:r.status, json:j, text:t };
}

async function setVoiceChannelName(channelId, name){
  if (!channelId || !BOT_TOKEN) return { ok:false, status:0, skipped:true };
  return await discordBot(`/channels/${channelId}`, "PATCH", { name });
}

// ---------- Data fetch ----------
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

// ---------- Main ----------
(async function(){
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive:true });
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE,"utf8"))
    : { vgc:null, changedAt:null, mismatch:false, supported: SUPPORTED, lastChannelName:null };

  const { v:newV, status, peek } = await getVgc();
  const oldV = prev.vgc ?? null;

  const firstRun       = oldV === null;
  const versionChanged = !firstRun && newV && newV !== oldV;        // Riot updated now
  const mismatch       = newV && newV !== SUPPORTED;

  // safer "compat restored" calc
  const hadPrevSupported = typeof prev.supported === "string" && prev.supported.length > 0;
  const oldMismatch = (typeof prev.mismatch === "boolean")
    ? prev.mismatch
    : (hadPrevSupported ? !!(prev.vgc && prev.vgc !== prev.supported) : false);
  const supportedChanged = hadPrevSupported ? (prev.supported !== SUPPORTED) : false;
  const compatRestored = !!(!firstRun && supportedChanged && oldMismatch === true && !mismatch && newV && newV === SUPPORTED);

  // times
  const now = new Date(); const nowISO = now.toISOString(); const nowUnix = Math.floor(now.getTime()/1000);

  // keep first detection of Riot update
  const changedAtISO = versionChanged ? nowISO : (prev.changedAt || null);
  const changedAtUnix = changedAtISO ? Math.floor(new Date(changedAtISO).getTime()/1000) : null;

  // desired voice channel name
  const desiredChannelName = mismatch
    ? `🔴 Vanguard: ${newV || "?"}`
    : `✅ Vanguard: ${newV || "?"}`;

  // update voice channel name only if needed
  if (VOICE_CHANNEL_ID && BOT_TOKEN && desiredChannelName !== prev.lastChannelName) {
    const res = await setVoiceChannelName(VOICE_CHANNEL_ID, desiredChannelName);
    if (DEBUG) console.log("PATCH /channels:", res.status, res.text?.slice(0,80));
    if (!res.ok) console.warn("Channel rename failed:", res.status, res.text);
    else prev.lastChannelName = desiredChannelName; // optimistic save in memory; persisted below
  }

  // embed content
  const COLOR_OK=0x2ecc71, COLOR_INFO=0x7f8c8d, COLOR_WARN=0xe74c3c;
  const headerLines =
    `**Supported VGC Version** ➜ \`${SUPPORTED}\`\n` +
    `**Updated VGC Version** ➜ \`${newV || "—"}\``;

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

  const fields = [];
  // Show "VGC updated at" ONLY on the run where Riot update is detected
  if (versionChanged) {
    fields.push({ name: "🆙 VGC updated at", value: `<t:${nowUnix}:F> • <t:${nowUnix}:R>`, inline:false });
  }
  if (compatRestored) {
    fields.push({ name: "🔧 Compatibility restored", value: `<t:${nowUnix}:F> • <t:${nowUnix}:R>`, inline:false });
  }
  if (DEBUG) fields.push({ name:"🪲 Debug", value:`status: \`${status}\`\npeek: \`${peek}\``, inline:false });

  const embed = {
    author: { name: "Vanguard (VGC) Version Watch", icon_url: ICON },
    description, color, fields, timestamp: nowISO
  };

  let content;
  if (compatRestored && MENTION_SAFE) content = MENTION_SAFE;
  else if ((versionChanged && mismatch) || (ALERT_ON_MISMATCH && mismatch)) content = MENTION_ALERT;

  const shouldSend =
    versionChanged || compatRestored || ALWAYS || (ALERT_ON_MISMATCH && mismatch);

  if (shouldSend) {
    await postWebhook({ embeds:[embed], ...(content ? { content } : {}) });
  }

  // persist state
  const next = {
    vgc: newV,
    changedAt: changedAtISO,
    mismatch,
    supported: SUPPORTED,
    lastChannelName: prev.lastChannelName || desiredChannelName
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  console.log("Done.");
})().catch(async (e)=>{
  console.error("Fatal:", e);
  await postWebhook({
    embeds:[{
      title:"❌ VGC watcher error",
      description:"An error occurred while running.",
      color:0xe74c3c,
      fields:[{ name:"Error", value:`\`${e?.message || e}\`` }],
      timestamp:new Date().toISOString()
    }]
  });
  process.exit(1);
});
