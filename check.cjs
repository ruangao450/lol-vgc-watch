// VGC Version Watch — "Supported vs Updated" with auto-warning

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

// ---- Config (env) ----
const SUPPORTED = process.env.SUPPORTED_VGC || "1.17.12.4"; // <— istediğin desteklenen sürüm
const ALWAYS = process.env.ALWAYS_SEND === "1";              // test için her çalıştırmada gönder
const DEBUG  = process.env.DEBUG === "1";                    // debug alanını göster
const MENTION = process.env.MENTION || "";                   // örn "<@&ROLE_ID>" veya "@everyone"
const ALERT_ON_MISMATCH = process.env.ALERT_ON_MISMATCH === "1"; // mismatch devam ettiği sürece her run’da uyar

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";
const ICON    = "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f6e1.png"; // 🛡️

// ----- HTTP -----
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"vgc-watch/2.0", "Accept":"application/json" } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok:r.ok, status:r.status, json, text };
  } catch {
    return { ok:false, status:0, json:null, text:"" };
  }
}

// ----- Discord -----
async function sendEmbed(embed, content) {
  const body = { embeds: [embed] };
  if (content) body.content = content;
  if (!DISCORD) { console.log("[DRY EMBED]", JSON.stringify(body, null, 2)); return; }
  const r = await fetch(DISCORD, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if (DEBUG) console.log("Discord status:", r.status);
}

// ----- VGC version -----
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

// ----- main -----
(async function main() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive:true });

  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { vgc: null, changedAt: null };

  const vgc = await getVgcVersion();
  const oldV = prev.vgc || null;
  const newV = vgc.version || null;

  const changed = !!(newV && newV !== oldV);
  const mismatch = !!(newV && newV !== SUPPORTED);

  // times (UTC)
  const now = new Date();
  const nowISO = now.toISOString();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const changedAtISO = changed ? nowISO : (prev.changedAt || null);
  const changedAtUnix = changedAtISO ? Math.floor(new Date(changedAtISO).getTime()/1000) : null;

  // colors
  const COLOR_OK      = 0x2ecc71; // green
  const COLOR_STABLE  = 0x7f8c8d; // gray
  const COLOR_ALERT   = 0xe74c3c; // red
  const color = mismatch ? COLOR_ALERT : (changed ? COLOR_OK : COLOR_STABLE);

  // top line + fields
  const firstTwoLines =
    `**Supported VGC Version** ➜ \`${SUPPORTED}\`\n` +
    `**Updated VGC Version** ➜ \`${newV || "—"}\``;

  const fields = [
    {
      name: "🗓️ Last change",
      value: changedAtUnix ? `<t:${changedAtUnix}:F> • <t:${changedAtUnix}:R>` : "—",
      inline: false
    },
    {
      name: "⏱️ Checked",
      value: `<t:${nowUnix}:F> • <t:${nowUnix}:R>`,
      inline: false
    }
  ];

  if (DEBUG) {
    fields.push({ name: "🪲 Debug", value: `status: \`${vgc.status}\`\npeek: \`${vgc.peek}\``, inline: false });
  }

  const embed = {
    author: { name: "Vanguard (VGC) Version Watch", icon_url: ICON },
    description: (mismatch
      ? "⚠️ **Action required**\n🛑 Please stop using the software until a compatibility update is released."
      : (changed ? "🎉 **Updated**" : "ℹ️ **Up-to-date**")
    ) + `\n\n${firstTwoLines}`,
    color,
    fields,
    timestamp: nowISO
  };

  // who to ping
  const content = (mismatch && MENTION) ? MENTION : undefined;

  // when to send
  const shouldSend = changed || ALWAYS || (ALERT_ON_MISMATCH && mismatch);

  if (shouldSend) {
    await sendEmbed(embed, content);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      vgc: newV,
      changedAt: changed ? nowISO : (prev.changedAt || null)
    }, null, 2), "utf8");
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
    timestamp: new Date().toISOString()
  });
  process.exit(1);
});
