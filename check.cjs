// LoL uzun build (15.16.704.6097 vb.) + VGC izleme (DEBUG'li)
// - DEBUG=1: her çalıştırmada mesaj atar, denenen URL ve HTTP kodlarını yazar
// - PROD: DEBUG ve ALWAYS_SEND kaldırılır, sadece değişince gönderir

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");

const ALWAYS = process.env.ALWAYS_SEND === "1";
const DEBUG  = process.env.DEBUG === "1";

// Bölge slug adayları
const SLUGS = {
  euw: ["euw","euw1","eu-west"],
  na:  ["na","na1","north-america"],
  kr:  ["kr","kr1"],
  br:  ["br","br1"],
  lan: ["lan","la1","latam-north"],
  tr:  ["tr","tr1"]
};

// URL yardımcıları
const LIVE = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
const RELS = id => [
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`,
  // bazı CDN’lerde "release-<id>" düzeyi
  `https://lol.secure.dyn.riotcdn.net/channels/public/release-${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/release-${id}.json`
];

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

// ---- HTTP yardımcıları (Node 20'de global fetch var) ----
async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "lol-vgc-watch/1.0" } });
    const t = await r.text();
    return { ok: r.ok, status: r.status, text: t };
  } catch (e) {
    return { ok: false, status: 0, text: "" };
  }
}
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "lol-vgc-watch/1.0", "Accept": "application/json" } });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { ok: r.ok, status: r.status, json: j, text: t };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: "" };
  }
}
const shorten = v => (v ? String(v).split("+")[0] : null);

// ---- LoL sürüm çıkarma ----
function parseLive(obj) {
  const direct = (obj && obj.version != null) ? String(obj.version) : null; // 263 vb.
  const artifact = obj?.releases?.[0]?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
  const manifest = obj?.releases?.[0]?.download?.url || null;
  return { direct, artifact, manifest };
}
function artifactFrom(text, json) {
  if (text) {
    const m = text.match(/riot:artifact_version_id[^"\n]*"([^"]+)"/);
    if (m) return m[1];
  }
  if (json) {
    const a =
      json?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] ||
      json?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
    if (a) return a;
  }
  return null;
}

async function getLol(region) {
  const tried = [];
  const cands = SLUGS[region] || [region];

  for (const slug of cands) {
    // 1) live JSON
    const liveUrl = LIVE(slug);
    const live = await fetchJSON(liveUrl);
    tried.push(`live:${slug}:${live.status}`);
    if (!live.ok || !live.json) continue;

    const { direct, artifact, manifest } = parseLive(live.json);

    // (a) artifact doğrudan varsa
    if (artifact) return { value: shorten(artifact), debug: tried.concat("artifact:live") };

    // (b) manifest URL verildiyse
    if (manifest) {
      const m = manifest.endsWith(".json") ? await fetchJSON(manifest) : await fetchText(manifest);
      tried.push(`manifestUrl:${m.status}`);
      if (m.ok) {
        const art = artifactFrom(m.text, m.json || null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:manifestUrl") };
      }
    }

    // (c) yalnız "version: N" geldiyse: releases/N.* adaylarını dene
    if (direct) {
      const id = String(direct).trim();
      for (const url of RELS(id)) {
        const isJson = url.endsWith(".json");
        const r = isJson ? await fetchJSON(url) : await fetchText(url);
        const key = url.includes("/releases/") ? url.split("/releases/")[1] : url.split("/channels/public/")[1];
        tried.push(`${key}:${r.status}`);
        if (r.ok) {
          const art = artifactFrom(r.text, r.json || null);
          if (art) return { value: shorten(art), debug: tried.concat("artifact:releases") };
        }
      }
      // artifact bulunamadı: kısa sürümü yine ver
      return { value: id, debug: tried.concat("fallback:short") };
    }
  }
  return { value: null, debug: tried.concat("no-live") };
}

// ---- VGC ----
async function getVgc() {
  const r = await fetchJSON(VGC_URL);
  let v = r.json?.anticheat?.vanguard?.version || null;
  if (!v && r.text) {
    const m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  const peek = (r.text || "").slice(0, 120).replace(/\s+/g, " ");
  return { v, status: r.status, peek };
}

// ---- Discord ----
async function postDiscord(msg) {
  if (!DISCORD) { console.log("[DRY]\n" + msg); return; }
  try {
    const r = await fetch(DISCORD, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: msg })
    });
    if (DEBUG) console.log("Discord status:", r.status);
  } catch (e) {
    console.error("Discord send error:", e.message);
  }
}

// ---- Main ----
(async function () {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { lol: {}, vgc: null };

  // LoL
  const results = await Promise.all(REGIONS.map(async r => [r, await getLol(r)]));
  const lolNow = Object.fromEntries(results.map(([r, obj]) => [r, obj.value]));

  // VGC
  const vgc = await getVgc();

  // Mesaj ve değişiklik
  let any = false;
  const lines = ["📊 Versions"];
  for (const [region, obj] of results) {
    const cur = obj.value || null;
    const old = prev.lol?.[region] || null;
    if (cur && cur !== old) any = true;

    lines.push(`🌍 ${region.toUpperCase()}`);
    lines.push(`① 🎮 OLD LOL version ➜ ${old || "—"}`);
    lines.push(`② 🔴 Latest LOL version       ➜ ${cur || "—"}`);
    if (DEBUG) lines.push(`↳ debug: ${obj.debug.join(" | ")}`);
  }

  if (vgc.v && vgc.v !== (prev.vgc || null)) any = true;
  lines.push("────────────────────────────────");
  lines.push(`③ 🛡️ OLD VGC version ➜ ${prev.vgc || "—"}`);
  lines.push(`④ 🟢 Latest VGC version       ➜ ${vgc.v || "—"}${DEBUG ? ` (status:${vgc.status}, peek:${vgc.peek})` : ""}`);

  if (any || ALWAYS || DEBUG) {
    await postDiscord(lines.join("\n"));
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lol: lolNow, vgc: vgc.v || null }, null, 2), "utf8");
    console.log("Message sent & state updated.");
  } else {
    console.log("No changes.");
  }
})();
