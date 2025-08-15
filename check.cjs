// LoL uzun build (15.16.704.6097) + VGC izleme
// DEBUG=1 iken: HER ÇALIŞMADA mesaj atar ve denenen URL'leri HTTP kodlarıyla yazar.
// PROD'da: ALWAYS_SEND ve DEBUG environment değişkenlerini kaldır.

const fs = require("fs");
const path = require("path");

const DISCORD = process.env.DISCORD_WEBHOOK || "";
const REGIONS = (process.env.LOL_REGIONS || "euw,na,kr,br,lan,tr")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "versions.json");
const ALWAYS_SEND = process.env.ALWAYS_SEND === "1";
const DEBUG = process.env.DEBUG === "1";

// Bölge slug adayları
const SLUGS = {
  euw: ["euw", "euw1", "eu-west"],
  na:  ["na", "na1", "north-america"],
  kr:  ["kr", "kr1"],
  br:  ["br", "br1"],
  lan: ["lan", "la1", "latam-north"],
  tr:  ["tr", "tr1"]
};

// Riot CDN URL yardımcıları
const LIVE = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
const RELS = id => [
  // yaygın varyantlar
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`,
  // bazı ortamlarda "release-<id>" ön ekini de görürsün:
  `https://lol.secure.dyn.riotcdn.net/channels/public/release-${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/release-${id}.json`
];

const VGC_URL = "https://clientconfig.rpg.riotgames.com/api/v1/config/public";

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

const shorten = s => (s ? String(s).split("+")[0] : null);

function pickFromLive(obj) {
  const direct = obj && obj.version != null ? String(obj.version) : null; // 263 vb.
  const artifact = obj?.releases?.[0]?.release?.labels?.["riot:artifact_version_id"]?.values?.[0] || null;
  const manifestUrl = obj?.releases?.[0]?.download?.url || null;
  return { direct, artifact, manifestUrl };
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

async function getLoLRegion(region) {
  const tried = [];
  const candidates = SLUGS[region] || [region];

  for (const slug of candidates) {
    const liveUrl = LIVE(slug);
    const live = await fetchJSON(liveUrl);
    tried.push(`live:${slug}:${live.status}`);

    if (!live.ok || !live.json) continue;

    const { direct, artifact, manifestUrl } = pickFromLive(live.json);

    // (a) artifact doğrudan varsa
    if (artifact) {
      return { value: shorten(artifact), debug: tried.concat("artifact:live") };
    }

    // (b) manifest URL verildiyse
    if (manifestUrl) {
      const man = await fetchText(manifestUrl);
      tried.push(`manifestUrl:${man.status}`);
      if (man.ok) {
        const art = artifactFrom(man.text, null);
        if (art) return { value: shorten(art), debug: tried.concat("artifact:manifestUrl") };
      }
    }

    // (c) sadece "version: N" geldiyse: releases/N.* deneyelim
    if (direct) {
      const id = String(direct).trim();
      for (const url of RELS(id)) {
        const isJson = url.endsWith(".json");
        const resp = isJson ? await fetchJSON(url) : await fetchText(url);
        tried.push(`${url.split("/releases/")[1] || url.split("/channels/public/")[1]}:${resp.status}`);
        if (resp.ok) {
          const art = artifactFrom(resp.text, resp.json || null);
          if (art) return { value: shorten(art), debug: tried.concat("artifact:releases") };
        }
      }
      // artifact bulunamadıysa kısa sürümü yine verelim
      return { value: id, debug: tried.concat("fallback:short") };
    }
  }

  return { value: null, debug: tried.concat("no-live") };
}

async function getVGC() {
  const r = await fetchJSON(VGC_URL);
  let v = r.json?.anticheat?.vanguard?.version || null;
  if (!v && r.text) {
    const m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return { v, status: r.status, peek: (r.text || "").slice(0, 120) };
}

async function postDiscord(message) {
  if (!DISCORD) { console.log("[DRY]\n" + message); return; }
  try {
    const r = await fetch(DISCORD, {
      met
