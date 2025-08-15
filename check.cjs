// Vanguard (VGC) Version Watch — Discord embed (UTC-only, polished)

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const ALWAYS  = process.env.ALWAYS_SEND === "1"; // testing
const DEBUG   = process.env.DEBUG === "1";       // show debug field
const MENTION = process.env.MENTION || "";       // e.g. "<@&ROLE_ID>" or "@everyone"

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";
const ICON    = "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f6e1.png"; // shield emoji

// ---------- HTTP ----------
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"vgc-watch/1.4", "Accept":"application/json" } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok:r.ok, status:r.status, json, text };
  } catch {
    return { ok:false, status:0, json:null, text:"" };
  }
}

// ---------- Discord ----------
async function sendEmbed(embed, content) {
  const payload = { embeds: [embed] };
  if (content) payload.content = content;
  if (!DISCORD) { console.log("[DRY EMBED]", JSON.stringify(payload, null, 2)); return; }
  const r = await fetch(DISCORD, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if (DEBUG) console.log("Discord status:", r.status);
}

// ---------- VGC version ----------
async function getVgcVersion() {
  const res = await fetchJSON(VGC_URL);
  let v = null;

  if (res.json && typeof res.json === "object") {
    v = res.json["anticheat.vanguard.version"]
     || res.json?.anticheat?.vanguard?.version
     || null;
  }
  if (!v && res.text) {
    let m = res.text.match(/"anticheat\.vanguard\.version"\s*:\s*"([^"]+)"/i);
    if (!m) m = res.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return { version: v, status: res.status, peek: (res.text || "").slice(0, 110).replace(/\s+/g," ") };
}

// ---------- main ----------
(async function main(){
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive:true });

  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { vgc: null, changedAt: null };

  const vgc = await getVgcVersion();
  const oldV = prev.vgc || null;
  const newV = vgc.version || null;

  const changed = !!(newV && newV !== oldV);

  // UTC timestamps
  const now = new Date();
  const nowISO = now.toISOString();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const changedAtISO = changed ? nowISO : (prev.changedAt || null);
  const changedAtUnix = changedAtISO ? Math.floor(new Date(changedAtISO).getTime()/1000) : null;

  // Colors
  const COLOR_UPDATED = 0x2ecc71; // green
  const COLOR_STABLE  = 0x7f8c8d; // gray
  const color = changed ? COLOR_UPDATED : COLOR_STABLE;

  const fields = [];
  if (changed) {
    fields.push(
      { name: "Previous", value: `\`${oldV || "—"}\``, inline: true },
      { name: "Current",  value: `\`${newV || "—"}\``, inline: true }
    );
  } else {
    fields.push({ name: "Current", value: `\`${newV || "—"}\``, inline: true });
  }

  fields.push(
    {
      name: "Last change (UTC)",
      value: changedAtUnix ? `<t:${changedAtUnix}:F> • <t:${changedAtUnix}:R>` : "—",
      inline: false
    },
    {
      name: "Checked (UTC)",
      value: `<t:${nowUnix}:F> • <t:${nowUnix}:R>`,
      inline: false
    },
    { name: "Source", value: `[clientconfig.rpg.riotgames.com](${VGC_URL})`, inline: false }
  );

  if (DEBUG) {
    fields.push({ name: "Debug", value: `status: \`${vgc.status}\`\npeek: \`${vgc.peek}\``, inline: false });
  }

  const embed = {
    author: { name: "Vanguard (VGC) Version Watch", icon_url: ICON },
    description: changed ? "✅ **Updated**" : "ℹ️ **Up-to-date**",
    color,
    fields,
    timestamp: nowISO, // Discord renders this in the embed header
    footer: { text: "UTC+0" }
  };

  const content = changed && MENTION ? MENTION : undefined;

  if (changed || ALWAYS) {
    await sendEmbed(embed, content);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ vgc: newV, changedAt: changed ? nowISO : (prev.changedAt || null) }, null, 2), "utf8");
    console.log("Embed sent & state updated.");
  } else {
    console.log("No changes.");
  }
})().catch(async (e) => {
  console.error("Fatal error:", e);
  await sendEmbed({
    title: "❌ VGC watcher error",
    description: "An error occurred while running.",
    color: 0xe74c3c,
    fields: [{ name: "Error", value: `\`${e?.message || e}\`` }],
    timestamp: new Date().toISOString(),
    footer: { text: "UTC+0" }
  });
  process.exit(1);
});
