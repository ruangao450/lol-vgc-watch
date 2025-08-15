// VGC Version Watch — Supported vs Updated with "VGC updated at" & "Software updated" notices

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const SUPPORTED = process.env.SUPPORTED_VGC || "1.17.12.4";
const ALWAYS    = process.env.ALWAYS_SEND === "1";          // testing
const DEBUG     = process.env.DEBUG === "1";                // debug field
const ALERT_ON_MISMATCH = process.env.ALERT_ON_MISMATCH === "1";

// Mentions
const MENTION_ALERT = process.env.MENTION || "";            // ping on mismatch (e.g. "<@&ROLE_ID>" or "@everyone")
const MENTION_SAFE  = process.env.MENTION_SAFE || "";       // ping when compatibility is restored

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";
const ICON    = "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f6e1.png"; // 🛡️

async function fetchJSON(url){
  try {
    const r = await fetch(url, { headers:{ "User-Agent":"vgc-watch/2.2", "Accept":"application/json" } });
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

  // Backward-compatible default state
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE,"utf8"))
    : { vgc:null, changedAt:null, mismatch:false, supported: SUPPORTED };

  const { v:newV, status, peek } = await getVgc();
  const oldV = prev.vgc ?? null;

  const firstRun       = oldV === null;
  const versionChanged = !firstRun && newV && newV !== oldV;
  const mismatch       = newV && newV !== SUPPORTED;

  // Detect if you bumped SUPPORTED and compatibility is now restored
  const oldMismatch    = typeof prev.mismatch === "boolean" ? prev.mismatch : (prev.vgc && prev.vgc !== prev.supported);
  const supportedChanged = prev.supported !== SUPPORTED;
  const compatRestored = !!(supportedChanged && oldMismatch && !mismatch && newV && newV === SUPPORTED);

  // Timestamps (UTC)
  const now = new Date();
  const nowISO = now.toISOString();
  const nowUnix = Math.floor(now.getTime()/1000);

  // When VGC changes, record that moment in state as "changedAt"
  const changedAtISO = versionChanged ? nowISO : (prev.changedAt || null);
  const changedAtUnix = changedAtISO ? Math.floor(new Date(changedAtISO).getTime()/1000) : null;

  // Colors
  const COLOR_OK   = 0x2ecc71; // green
  const COLOR_INFO = 0x7f8c8d; // gray
  const COLOR_WARN = 0xe74c3c; // red

  // Top two lines (always shown)
  const headerLines =
    `**Supported VGC Version** ➜ \`${SUPPORTED}\`\n` +
    `**Updated VGC Version** ➜ \`${newV || "—"}\``;

  // Description by case
  let description, color;
  if (compatRestored) {
    description = `✅ **Software updated**\nYour software has been updated and is now safe to use with the new VGC version.\n\n${headerLines}`;
    color = COLOR_OK;
  } else if (mismatch) {
    description = `⚠️ **Action required**\n🛑 Please stop using the software until a compatibility update is released.\n\n${headerLines}`;
    color = COLOR_WARN;
  } else if (versionChanged) {
    description = `🎉 **Updated**\n\n${headerLines}`;
    color = COLOR_OK;
  } else {
    description = `ℹ️ **Up-to-date**\n\n${headerLines}`;
    color = COLOR_INFO;
  }

  // Fields
  const fields = [];
  // Show when Riot updated VGC (the moment we detected the change)
  fields.push({
    name: "🆙 VGC updated at",
    value: changedAtUnix ? `<t:${changedAtUnix}:F> • <t:${changedAtUnix}:R>` : "—",
    inline: false
  });
  // If compatibility has just been restored (you bumped SUPPORTED), show that moment too
  if (compatRestored) {
    fields.push({
      name: "🔧 Compatibility restored",
      value: `<t:${nowUnix}:F> • <t:${nowUnix}:R>`,
      inline: false
    });
  }
  if (DEBUG) fields.push({ name:"🪲 Debug", value:`status: \`${status}\`\npeek: \`${peek}\``, inline:false });

  const embed = {
    author: { name: "Vanguard (VGC) Version Watch", icon_url: ICON },
    description,
    color,
    fields,
    timestamp: nowISO
  };

  // Who to ping?
  let content;
  if (compatRestored && MENTION_SAFE) content = MENTION_SAFE;
  else if ((versionChanged && mismatch) || (ALERT_ON_MISMATCH && mismatch)) content = MENTION_ALERT;

  // When to send?
  const shouldSend =
    versionChanged            // VGC changed → notify (green or red)
    || compatRestored         // you updated software to support the new VGC → notify (green)
    || (ALWAYS && !firstRun)  // test mode (skip baseline noise)
    || (ALERT_ON_MISMATCH && mismatch); // repeating alert while mismatch persists

  if (shouldSend){
    await sendEmbed(embed, content);
    // Persist new state
    const next = {
      vgc: newV,
      changedAt: changedAtISO,   // when VGC changed
      mismatch,
      supported: SUPPORTED
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
    console.log("Embed sent & state updated.");
  } else {
    // Still persist supported/mismatch so we can detect compatRestored later
    const next = {
      vgc: newV,
      changedAt: changedAtISO,
      mismatch,
      supported: SUPPORTED
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
    console.log("No changes.");
  }
})().catch(async (e)=>{
  console.error("Fatal:", e);
  await sendEmbed({
    title:"❌ VGC watcher error",
    description:"An error occurred while running.",
    color:0xe74c3c,
    fields:[{ name:"Error", value:`\`${e?.message || e}\`` }],
    timestamp:new Date().toISOString()
  });
  process.exit(1);
});
