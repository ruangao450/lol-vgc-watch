// VGC Version Watcher — warn on Riot updates until you bump SUPPORTED_VGC
// - Riot VGC update (mismatch)  -> red embed + optional ping + voice channel "🔴 Vanguard: <ver>"
// - You bump SUPPORTED_VGC      -> green embed + optional ping + voice channel "✅ Vanguard: <ver>"
// - Up-to-date (no change)      -> gray embed (only if ALWAYS_SEND=1); no ping; voice channel stays green

const fs = require("fs");
const path = require("path");

// ------- ENV -------
const DISCORD_WEBHOOK   = process.env.DISCORD_WEBHOOK || "";      // webhook for embeds
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";    // bot token to rename voice channel
const VOICE_CHANNEL_ID  = process.env.VOICE_CHANNEL_ID || "";     // target voice channel id

const SUPPORTED         = process.env.SUPPORTED_VGC || "1.17.12.4";
const ALWAYS            = process.env.ALWAYS_SEND === "1";        // test: always send embed
const DEBUG             = process.env.DEBUG === "1";
const ALERT_ON_MISMATCH = process.env.ALERT_ON_MISMATCH === "1";

const MENTION_ALERT     = process.env.MENTION || "";              // e.g. '@everyone' or '<@&ROLE_ID>'
const MENTION_SAFE      = process.env.MENTION_SAFE || "";         // ping when compatibility restored

// ------- CONST -------
const STATE_DIR  = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");
const ICON       = "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f6e1.png"; // 🛡️
const VGC_URL    = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ------- HTTP helpers -------
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "vgc-watcher/2.6", "Accept": "application/json" } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, text, json };
  } catch {
    return { ok: false, status: 0, text: "", json: null };
  }
}

// allow @everyone / roles / users explicitly
function buildAllowedMentions(str = "") {
  const allowed = { parse: [] };
  if (str.includes("@everyone") || str.includes("@here")) allowed.parse.push("everyone");
  const roleIds = [...str.matchAll(/<@&(\d+)>/g)].map(m => m[1]);
  if (roleIds.length) allowed.roles = roleIds;
  const userIds = [...str.matchAll(/<@!?(\d+)>/g)].map(m => m[1]).filter(id => !roleIds.includes(id));
  if (userIds.length) allowed.users = userIds;
  return allowed;
}

async function postWebhook({ embeds, content }) {
  const payload = { embeds: embeds || [] };
  if (content) {
    payload.content = content;
    payload.allowed_mentions = buildAllowedMentions(content);
  }
  if (!DISCORD_WEBHOOK) { console.log("[DRY webhook]", JSON.stringify(payload, null, 2)); return; }
  await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function discordBot(path, method = "GET", body) {
  if (!DISCORD_BOT_TOKEN) return { ok: false, status: 0, text: "", json: null, skipped: true };
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { "Authorization": `Bot ${DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok, status: r.status, text: t, json: j };
}

async function setVoiceChannelName(channelId, name) {
  if (!channelId || !DISCORD_BOT_TOKEN) return { ok: false, status: 0, skipped: true };
  return await discordBot(`/channels/${channelId}`, "PATCH", { name });
}

// ------- Riot fetch -------
async function getVgc() {
  const res = await fetchJSON(VGC_URL);
  let v = null;
  if (res.json) v = res.json["anticheat.vanguard.version"] ?? res.json?.anticheat?.vanguard?.version ?? null;
  if (!v && res.text) {
    let m = res.text.match(/"anticheat\.vanguard\.version"\s*:\s*"([^"]+)"/i)
         || res.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return { v, status: res.status, peek: (res.text || "").slice(0, 110).replace(/\s+/g, " ") };
}

// ------- Main -------
(async function main() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { vgc: null, changedAt: null, mismatch: false, supported: SUPPORTED, lastChannelName: null };

  const { v: newV, status, peek } = await getVgc();
  const oldV = prev.vgc ?? null;

  const firstRun       = oldV === null;
  const versionChanged = !firstRun && newV && newV !== oldV;          // Riot updated NOW
  const mismatch       = newV && newV !== SUPPORTED;                  // you don't support it yet

  // safer compat-restored (only if there WAS a mismatch in the past and you bumped SUPPORTED)
  const hadPrevSupported = typeof prev.supported === "string" && prev.supported.length > 0;
  const oldMismatch = (typeof prev.mismatch === "boolean")
    ? prev.mismatch
    : (hadPrevSupported ? !!(prev.vgc && prev.vgc !== prev.supported) : false);
  const supportedChanged = hadPrevSupported ? (prev.supported !== SUPPORTED) : false;
  const compatRestored   = !!(!firstRun && supportedChanged && oldMismatch === true && !mismatch && newV && newV === SUPPORTED);

  // times (UTC)
  const now = new Date();
  const nowISO = now.toISOString();
  const nowUnix = Math.floor(now.getTime() / 1000);

  // remember first detection time of Riot update (optional state)
  const changedAtISO  = versionChanged ? nowISO : (prev.changedAt || null);
  const changedAtUnix = changedAtISO ? Math.floor(new Date(changedAtISO).getTime() / 1000) : null;

  // desired voice channel name by state
  const desiredName = mismatch ? `🔴 Vanguard: ${newV || "?"}` : `✅ Vanguard: ${newV || "?"}`;
  if (VOICE_CHANNEL_ID && DISCORD_BOT_TOKEN && desiredName !== prev.lastChannelName) {
    const r = await setVoiceChannelName(VOICE_CHANNEL_ID, desiredName);
    if (!r.ok) console.warn("Channel rename failed:", r.status, r.text?.slice(0, 120));
    else prev.lastChannelName = desiredName;
    if (DEBUG) console.log("Channel rename:", r.status);
  }

  // embed build
  const COLOR_OK = 0x2ecc71, COLOR_INFO = 0x7f8c8d, COLOR_WARN = 0xe74c3c;
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
  // Show "VGC updated at" ONLY at the moment Riot update is first detected
  if (versionChanged) {
    fields.push({ name: "🆙 VGC updated at", value: `<t:${nowUnix}:F> • <t:${nowUnix}:R>`, inline: false });
  }
  if (compatRestored) {
    fields.push({ name: "🔧 Compatibility restored", value: `<t:${nowUnix}:F> • <t:${nowUnix}:R>`, inline: false });
  }
  if (DEBUG) fields.push({ name: "🪲 Debug", value: `status: \`${status}\`\npeek: \`${peek}\``, inline: false });

  const embed = {
    author: { name: "Vanguard (VGC) Version Watcher", icon_url: ICON },
    description, color, fields, timestamp: nowISO
  };

  // mentions only for critical states
  let content;
  if (compatRestored && MENTION_SAFE) content = MENTION_SAFE;
  else if ((versionChanged && mismatch) || (ALERT_ON_MISMATCH && mismatch)) content = MENTION_ALERT;

  // when to send
  const shouldSend =
    versionChanged                 // Riot updated -> alert
    || compatRestored              // you bumped SUPPORTED -> green notice
    || ALWAYS                      // test mode
    || (ALERT_ON_MISMATCH && mismatch);

  if (shouldSend) {
    await postWebhook({ embeds: [embed], content });
  }

  // persist state
  const next = {
    vgc: newV,
    changedAt: changedAtISO,
    mismatch,
    supported: SUPPORTED,
    lastChannelName: prev.lastChannelName || desiredName
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
  console.log("Done.");
})().catch(async (e) => {
  console.error("Fatal:", e);
  await postWebhook({
    embeds: [{
      title: "❌ VGC watcher error",
      description: "An error occurred while running.",
      color: 0xe74c3c,
      fields: [{ name: "Error", value: `\`${e?.message || e}\`` }],
      timestamp: new Date().toISOString()
    }]
  });
  process.exit(1);
});
