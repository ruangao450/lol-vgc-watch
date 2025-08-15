// Vanguard (VGC) Version Watch — Discord embed (English)
// Source: https://clientconfig.rpg.riotgames.com/api/v1/config/public

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const ALWAYS = process.env.ALWAYS_SEND === "1";   // for testing
const DEBUG  = process.env.DEBUG === "1";         // show debug field
const MENTION = process.env.MENTION || "";        // e.g. "<@&ROLE_ID>" or "@everyone"

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---------- Time helpers ----------
function fmt(ts, tz = "Europe/Istanbul", locale = "en-GB") {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, dateStyle: "medium", timeStyle: "short"
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}
const nowISO = () => new Date().toISOString();

// ---------- HTTP ----------
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "vgc-watch/1.3", "Accept": "application/json" } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch {
    return { ok:false, status:0, json:null, text:"" };
  }
}

// ---------- Discord embed ----------
async function sendEmbed(embed, content) {
  if (!DISCORD) { console.log("[DRY EMBED]", JSON.stringify({ content, embeds:[embed] }, null, 2)); return; }
  const body = { embeds: [embed] };
  if (content) body.content = content;
  const r = await fetch(DISCORD, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if (DEBUG) console.log("Discord status:", r.status);
}

// ---------- VGC version ----------
async function getVgcVersion() {
  const res = await fetchJSON(VGC_URL);
  let v = null;

  // flat key or nested
  if (res.json && typeof res.json === "object") {
    v = res.json["anticheat.vanguard.version"]
     || res.json?.anticheat?.vanguard?.version
     || null;
  }
  // regex fallback
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

  const now = nowISO();
  const changedAt = changed ? now : (prev.changedAt || null);

  // Visuals
  const COLOR_UPDATED  = 0x2ecc71; // green
  const COLOR_STABLE   = 0x3498db; // blue
  const color = changed ? COLOR_UPDATED : COLOR_STABLE;

  const istNow = fmt(now, "Europe/Istanbul", "en-GB");
  const utcNow = fmt(now, "UTC", "en-GB");
  const istLast = changedAt ? fmt(changed ? now : changedAt, "Europe/Istanbul", "en-GB") : "—";
  const utcLast = changedAt ? fmt(changed ? now : changedAt, "UTC", "en-GB") : "—";

  const fields = [];

  if (changed) {
    fields.push(
      { name: "Previous", value: `\`${oldV || "—"}\``, inline: true },
      { name: "Current",  value: `\`${newV || "—"}\``, inline: true },
    );
  } else {
    fields.push({ name: "Current", value: `\`${newV || "—"}\``, inline: true });
  }

  fields.push(
    { name: "Last change", value: `${istLast} (Istanbul) • ${utcLast} UTC`, inline: false },
    { name: "Source", value: `[clientconfig.rpg.riotgames.com](${VGC_URL})`, inline: false },
  );

  if (DEBUG) {
    fields.push({ name: "Debug", value: `status: \`${vgc.status}\`\npeek: \`${vgc.peek}\``, inline: false });
  }

  const embed = {
    title: "🛡️ Vanguard (VGC) Version Watch",
    description: changed ? "✅ **Updated**" : "ℹ️ **Up-to-date**",
    color,
    fields,
    timestamp: now,
    footer: { text: `Checked • ${istNow} (Istanbul) • ${utcNow} UTC` }
  };

  const content = changed && MENTION ? MENTION : undefined;

  if (changed || ALWAYS) {
    await sendEmbed(embed, content);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ vgc: newV, changedAt: changed ? now : (prev.changedAt || null) }, null, 2), "utf8");
    console.log("Embed sent & state updated.");
  } else {
    console.log("No changes.");
  }
})().catch(async (e) => {
  console.error("Fatal error:", e);
  if (process.env.POST_ERRORS === "1") {
    await sendEmbed({
      title: "❌ VGC watcher error",
      description: "An error occurred while running.",
      color: 0xe74c3c,
      fields: [{ name: "Error", value: `\`${e?.message || e}\`` }],
      timestamp: nowISO()
    });
  }
  process.exit(1);
});
