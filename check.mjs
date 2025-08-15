// LoL uzun build sürümü (15.16.704.6097) + VGC sürümü izleme
// - Her bölge ayrı ayrı kontrol edilir
// - Sadece versiyon değişince Discord'a mesaj atılır
// - Önceki değerler .state/versions.json içinde saklanır

import fs from 'fs';
import path from 'path';

// ---------- Ayarlar ----------
const STATE_DIR  = '.state';
const STATE_FILE = path.join(STATE_DIR, 'versions.json');

const DISCORD    = process.env.DISCORD_WEBHOOK || '';
const REGIONS    = (process.env.LOL_REGIONS || 'euw,na,kr,br,lan,tr')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const DEBUG = process.env.DEBUG === '1';

// Riot CDN patchline aday slug'ları (ilk başarılı olan kullanılır)
const PATCHLINE_CANDIDATES = {
  euw: ['euw','euw1','eu-west'],
  na:  ['na','na1','north-america'],
  kr:  ['kr','kr1'],
  br:  ['br','br1'],
  lan: ['lan','la1','latam-north'],
  tr:  ['tr','tr1'],
};

// Riot CDN canlı patchline JSON (Windows)
const LIVE_URL = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
// Vanguard public config
const VGC_URL  = 'https://clientconfig.rpg.riotgames.com/api/v1/config/public';

// Klasör hazırla
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------- Yardımcılar ----------
async function jget(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'lol-vgc-watch/1.0',
        'Accept': 'application/json'
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (DEBUG) console.error(`[jget] ${url} -> ${e.message}`);
    return null;
  }
}

async function tget(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    if (DEBUG) console.error(`[tget] ${url} -> ${e.message}`);
    return null;
  }
}

// Canlı JSON'dan sürüm alanlarını dene
function extractLoLBuild(liveJson) {
  if (!liveJson) return { direct: null, artifact: null, manifest: null };

  // Bazı patchline JSON'larında kökte 'version' string'i bulunabiliyor
  const direct = liveJson?.version || null;

  // Standart yol: releases[0] -> labels['riot:artifact_version_id'] -> values[0]
  const rel      = Array.isArray(liveJson?.releases) ? liveJson.releases[0] : null;
  const labels   = rel?.release?.labels || {};
  const artifact = labels?.['riot:artifact_version_id']?.values?.[0] || null;

  // releases[0].download.url içinde manifest linki yer alır
  const manifest = rel?.download?.url || null;

  return { direct, artifact, manifest };
}

// "15.16.704.6097+branch...." -> "15.16.704.6097"
const shortenArtifact = v => (v ? v.split('+')[0] : null);

// Bölge için çoklu slug dene, ilk başarılıyı kullan
async function fetchLoLLongForRegion(regionKey) {
  const candidates = PATCHLINE_CANDIDATES[regionKey] || [regionKey];
  const tried = [];

  for (const slug of candidates) {
    const url  = LIVE_URL(slug);
    const live = await jget(url);
    tried.push(slug);

    if (live) {
      const { direct, artifact, manifest } = extractLoLBuild(live);
      let chosen = direct || artifact || null;

      // Eğer artifact yoksa manifest'i açıp 'riot:artifact_version_id' ara
      if (!chosen && manifest) {
        const text = await tget(manifest);
        if (text) {
          const m = text.match(/riot:artifact_version_id[^"\n]*"(.*?)"/);
          if (m) chosen = m[1];
        }
      }

      if (chosen) {
        if (DEBUG) console.log(`[${regionKey}] using slug=${slug}`);
        return { version: shortenArtifact(chosen), used: slug, tried };
      }
    }
  }

  if (DEBUG) console.warn(`[${regionKey}] no version found. tried: ${tried.join(', ')}`);
  return { version: null, used: null, tried };
}

async function fetchVGC() {
  const conf = await jget(VGC_URL);
  return conf?.anticheat?.vanguard?.version || null;
}

async function postDiscord(content) {
  if (!DISCORD) {
    console.log('[DRY RUN] Discord webhook tanımlı değil. Mesaj:\n' + content);
    return;
  }
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

// ---------- Ana akış ----------
(async () => {
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { lol: {}, vgc: null };

  // Bölgeleri paralel çek
  const results = await Promise.all(
    REGIONS.map(async r => [r, await fetchLoLLongForRegion(r)])
  );
  const lolCurrent = Object.fromEntries(results.map(([r, res]) => [r, res.version]));

  // VGC
  const vgcCurrent = await fetchVGC();

  // Değişiklik algılama
  let anyChange = false;
  const regionBlocks = [];

  for (const [region, res] of results) {
    const oldV = prev.lol?.[region] || null;
    const newV = res.version || null;

    if (newV && oldV !== newV) anyChange = true;

    const title   = `🌍 ${region.toUpperCase()}`;
    const oldLine = `① 🎮 OLD LOL version ➜ ${oldV || '—'}`;
    const newLine = `② 🔴 Latest LOL version       ➜ ${newV || '—'}`;
    regionBlocks.push(`${title}\n${oldLine}\n${newLine}`);
  }

  const oldVGC = prev.vgc || null;
  const newVGC = vgcCurrent || null;
  if (newVGC && oldVGC !== newVGC) anyChange = true;

  const vgcBlock = [
    `③ 🛡️ OLD VGC version ➜ ${oldVGC || '—'}`,
    `④ 🟢 Latest VGC version       ➜ ${newVGC || '—'}`
  ].join('\n');

  // Mesajı yalnızca değişiklik olduğunda gönder
  if (anyChange || DEBUG) {
    const header = '📊 Versions';
    const sep    = '────────────────────────────────';
    const msg    = [header, ...regionBlocks, sep, vgcBlock].join('\n');
    await postDiscord(msg);

    // State'i güncelle
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lol: lolCurrent, vgc: newVGC }, null, 2),
      'utf8'
    );
    if (DEBUG) console.log('State updated.');
  } else {
    console.log('No changes.');
  }
})().catch(e => console.error(`Uncaught error: ${e.message}`));
