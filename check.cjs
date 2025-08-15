// Vanguard (VGC) sürüm izleyici – Discord EMBED ile bildirim
// Kaynak: https://clientconfig.rpg.riotgames.com/api/v1/config/public

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const STATE_DIR  = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const ALWAYS = process.env.ALWAYS_SEND === "1"; // test için
const DEBUG  = process.env.DEBUG === "1";       // test için
const MENTION = process.env.MENTION || "";      // örn: "<@&1234567890>" veya "@everyone"

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---- Zaman/format yardımcıları ----
function fmt(ts, tz = "Europe/Istanbul", locale = "tr-TR") {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz, dateStyle: "medium", timeStyle: "short"
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}
const nowISO = () => new Date().toISOString();

// ---- HTTP helper ----
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent":"vgc-watch/1.2", "Accept":"application/json" } });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, json, text };
  } catch {
    return { ok:false, status:0, json:null, text:"" };
  }
}

// ---- Discord helper (embed) ----
async function sendEmbed(embed, content) {
  if (!DISCORD) { 
    console.log("[DRY EMBED]", JSON.stringify({ content, embeds:[embed] }, null, 2));
    return;
  }
  const body = { embeds: [embed] };
  if (content) body.content = content;
  try {
    const r = await fetch(DISCORD, {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    if (DEBUG) console.log("Discord status:", r.status);
  } catch (e) {
    console.error("Discord send error:", e.message);
  }
}

// ---- VGC sürümü ----
async function getVgcVersion() {
  const res = await fetchJSON(VGC_URL);
  let v = null;

  // 1) Düz anahtar / nested
  if (res.json && typeof res.json === "object") {
    v = res.json["anticheat.vanguard.version"]
     || res.json?.anticheat?.vanguard?.version
     || null;
  }
  // 2) Regex fallback
  if (!v && res.text) {
    let m = res.text.match(/"anticheat\.vanguard\.version"\s*:\s*"([^"]+)"/i);
    if (!m) m = res.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }

  return { version: v, status: res.status, peek: (res.text || "").slice(0, 120).replace(/\s+/g," ") };
}

// ---- main ----
(async function main(){
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive:true });

  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { vgc: null, changedAt: null };

  const vgc = await getVgcVersion();
  const oldV = prev.vgc || null;
  const newV = vgc.version || null;

  const changed = !!(newV && newV !== oldV);

  // Zaman bilgileri
  const now = nowISO();
  const changedAtISO = changed ? now : (prev.changedAt || null);

  const istNow  = fmt(now, "Europe/Istanbul", "tr-TR");
  const utcNow  = fmt(now, "UTC", "en-GB");
  const istLast = changedAtISO ? fmt(changed ? now : changedAtISO, "Europe/Istanbul", "tr-TR") : "—";
  const utcLast = changedAtISO ? fmt(changed ? now : changedAtISO, "UTC", "en-GB") : "—";

  // Renk: güncellendiyse yeşil, değilse gri
  const COLOR_UPDATED   = 0x2ecc71; // 3066993
  const COLOR_NOCHANGE  = 0x95a5a6; // 9807270
  const color = changed ? COLOR_UPDATED : COLOR_NOCHANGE;

  const title = "🛡️ Vanguard (VGC) Sürüm Takibi";
  const url   = VGC_URL;
  const description = changed ? "✅ **Güncellendi!**" : "ℹ️ **Değişiklik yok.**";

  const fields = [
    {
      name: "Sürüm",
      value: changed ? `\`${oldV || "—"}\` → \`${newV || "—"}\`` : `\`${newV || "—"}\``,
      inline: false
    },
    {
      name: "Son değişim",
      value: `${istLast} (İstanbul) • ${utcLast} UTC`,
      inline: false
    },
    {
      name: "Kaynak",
      value: `[clientconfig.rpg.riotgames.com](${VGC_URL})`,
      inline: false
    }
  ];

  if (DEBUG) {
    fields.push({
      name: "Debug",
      value: `status: \`${vgc.status}\`\npeek: \`${vgc.peek}\``,
      inline: false
    });
  }

  const embed = {
    title,
    url,
    description,
    color,
    fields,
    timestamp: now, // Discord embed timestamp ISO 8601
    footer: { text: "Europe/Istanbul • UTC gösterimi üstte" }
  };

  // Değişiklik varsa opsiyonel mention at
  const content = changed && MENTION ? MENTION : undefined;

  if (changed || ALWAYS) {
    await sendEmbed(embed, content);

    // state güncelle
    const nextState = {
      vgc: newV,
      changedAt: changed ? now : (prev.changedAt || null)
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2), "utf8");
    console.log("Embed sent & state updated.");
  } else {
    console.log("No changes.");
  }
})().catch(async (e) => {
  console.error("Fatal error:", e);
  if (process.env.POST_ERRORS === "1") {
    await sendEmbed({
      title: "❌ VGC watcher error",
      description: "Çalışma sırasında bir hata oluştu.",
      color: 0xe74c3c,
      fields: [{ name: "Hata", value: `\`${e?.message || e}\`` }],
      timestamp: nowISO()
    });
  }
  process.exit(1);
});
