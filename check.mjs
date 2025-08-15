// LoL uzun build (15.16.704.6097 gibi) + VGC sürümü izleme
// - Bölgeler: EUW, NA, KR, BR, LAN, TR
// - Değişiklik olursa Discord'a "OLD → Latest" formatında gönderir
// - State: .state/versions.json
// - LoL: live-<slug>-win.json -> version N -> releases/N.(manifest|json|manifest.json|manifest)
// - VGC: clientconfig JSON + regex fallback

import fs from 'fs';
import path from 'path';

const STATE_DIR  = '.state';
const STATE_FILE = path.join(STATE_DIR, 'versions.json');

const DISCORD = process.env.DISCORD_WEBHOOK || '';
const REGIONS = (process.env.LOL_REGIONS || 'euw,na,kr,br,lan,tr')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const DEBUG = process.env.DEBUG === '1';

// Patchline slug adayları
const CAND = {
  euw: ['euw','euw1','eu-west'],
  na:  ['na','na1','north-america'],
  kr:  ['kr','kr1'],
  br:  ['br','br1'],
  lan: ['lan','la1','latam-north'],
  tr:  ['tr','tr1'],
};

const LIVE = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
const REL = id => [
  // en yaygın varyantlar
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest`,
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/manifest.json`,
  // bazı CDN’lerde alt klasör:
  `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}/release.manifest`,
];

const VGC_URL = 'https://clientconfig.rpg.riotgames.com/api/v1/config/public';

async function req(url, mode = 'auto') {
  // mode: 'json' -> JSON beklenir, 'text' -> düz metin, 'auto' -> önce text, sonra JSON parse dener
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0' } });
    const status = r.status;
    const text = await r.text();
    let json = null;
    if (mode !== 'text') { try { json = JSON.parse(text); } catch {} }
    return { ok: r.ok, status, text, json };
  } catch (e) {
    return { ok: false, status: 0, err: e.message };
  }
}

const shorten = v => v ? String(v).split('+')[0] : null;

function pickFromLiveJson(obj) {
  const direct = obj?.version ?? null; // 263 vb.
  const artifact =
    obj?.releases?.[0]?.release?.labels?.['riot:artifact_version_id']?.values?.[0] ??
    obj?.release?.labels?.['riot:artifact_version_id']?.values?.[0] ??
    obj?.labels?.['riot:artifact_version_id']?.values?.[0] ?? null;
  const manifestUrl = obj?.releases?.[0]?.download?.url ?? null;
  return { direct, artifact, manifestUrl };
}

function artifactFromTextOrJson({ text, json }) {
  if (text) {
    const m = text.match(/riot:artifact_version_id[^"\n]*"([^"]+)"/);
    if (m) return m[1];
  }
  if (json) {
    const a =
      json?.release?.labels?.['riot:artifact_version_id']?.values?.[0] ??
      json?.labels?.['riot:artifact_version_id']?.values?.[0] ?? null;
    if (a) return a;
  }
  return null;
}

async function getLoLForRegion(region) {
  const tried = [];
  for (const slug of (CAND[region] || [region])) {
    // 1) live JSON
    const liveUrl = LIVE(slug);
    const live = await req(liveUrl, 'auto');
    tried.push(`live:${slug}:${live.status}`);
    if (!live.ok || !live.json) continue;

    const { direct, artifact, manifestUrl } = pickFromLiveJson(live.json);

    // (a) artifact doğrudan varsa
    if (artifact) {
      return { long: shorten(artifact), short: direct ?? null, debug: tried.concat('artifact:live') };
    }

    // (b) live JSON manifest URL veriyorsa, onu dene
    if (manifestUrl) {
      const man = await req(manifestUrl, 'auto');
      tried.push(`manifestUrl:${man.status}`);
      if (man.ok) {
        const art = artifactFromTextOrJson(man);
        if (art) return { long: shorten(art), short: direct ?? null, debug: tried.concat('artifact:manifestUrl') };
      }
    }

    // (c) sadece "version: N" verdiyse: releases/N.* adaylarını dene
    if (typeof direct !== 'undefined' && direct !== null) {
      const id = String(direct).trim();
      for (const url of REL(id)) {
        const r = await req(url, 'auto');
        tried.push(`${url.split('/releases/')[1]}:${r.status}`);
        if (r.ok) {
          const art = artifactFromTextOrJson(r);
          if (art) return { long: shorten(art), short: id, debug: tried.concat('artifact:releases') };
        }
      }
      // artifact bulunamazsa en azından kısa sürümü ver
      return { long: null, short: id, debug: tried.concat('fallback:short') };
    }
  }
  return { long: null, short: null, debug: tried.concat('no-live') };
}

async function getVGC() {
  const r = await req(VGC_URL, 'auto');
  let v = r.json?.anticheat?.vanguard?.version ?? null;
  if (!v && r.text) {
    const m = r.text.match(/"vanguard"\s*:\s*{[^}]*"version"\s*:\s*"([^"]+)"/i);
    if (m) v = m[1];
  }
  return { vgc: v, status: r.status };
}

async function postDiscord(content) {
  if (!DISCORD) { console.log('[DRY]\n' + content); return; }
  try {
    const r = await fetch(DISCORD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (DEBUG) console.log(`[Discord] HTTP ${r.status}`);
  } catch (e) {
    console.error(`[Discord] gönderim hatası: ${e.message}`);
  }
}

(async () => {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { lol: {}, vgc: null };

  // Bölgeler
  const perRegion = await Promise.all(REGIONS.map(async r => [r, await getLoLForRegion(r)]));
  const lolCurrent = Object.fromEntries(perRegion.map(([r, res]) => [r, res.long || res.short || null]));

  // VGC
  const vgcRes = await getVGC();
  const vgcCurrent = vgcRes.vgc || null;

  // Mesaj + değişiklik
  let anyChange = false;
  const blocks = [];

  for (const [region, res] of perRegion) {
    const now = res.long || res.short || null;
    const old = prev.lol?.[region] || null;
    if (now && now !== old) anyChange = true;

    const title = `🌍 ${region.toUpperCase()}`;
    const oldLine = `① 🎮 OLD LOL version ➜ ${old || '—'}`;
    const newLine = `② 🔴 Latest LOL version       ➜ ${now || '—'}`;
    const dbg = DEBUG ? `\n↳ debug: ${res.debug.join(' | ')}` : '';
    blocks.push(`${title}\n${oldLine}\n${newLine}${dbg}`);
  }

  const oldVGC = prev.vgc || null;
  const newVGC = vgcCurrent || null;
  if (newVGC && newVGC !== oldVGC) anyChange = true;

  const vgcBlock = [
    `③ 🛡️ OLD VGC version ➜ ${oldVGC || '—'}`,
    `④ 🟢 Latest VGC vers
