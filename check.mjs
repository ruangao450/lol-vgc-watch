import fs from 'fs';
import path from 'path';

const STATE_DIR = '.state';
const STATE_FILE = path.join(STATE_DIR, 'versions.json');

const DISCORD = process.env.DISCORD_WEBHOOK;
const REGIONS = (process.env.LOL_REGIONS || 'tr,euw,na,kr,br,lan,las')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// --- Bölge -> olası patchline slug adayları ---
// İlk başarılı olan kullanılır.
const PATCHLINE_CANDIDATES = {
  tr:  ['tr'],
  euw: ['euw','eu-west','euw1'],
  eune:['eune','eu-east','eun1'],
  na:  ['na','na1','north-america'],
  kr:  ['kr','ko','kr1'],
  jp:  ['jp','jp1'],
  oce: ['oce','oc1'],
  br:  ['br','br1'],
  lan: ['lan','la1','latam-north'],
  las: ['las','la2','latam-south'],
  ru:  ['ru','ru1'],
  me:  ['me','me1','mena']
};

// Riot CDN canlı patchline JSON (Windows)
const LIVE_URL = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
// Vanguard public config
const VGC_URL = 'https://clientconfig.rpg.riotgames.com/api/v1/config/public';

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

async function jget(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error(`[jget] ${url} -> ${e.message}`);
    return { __error: e.message };
  }
}
async function tget(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    console.error(`[tget] ${url} -> ${e.message}`);
    return null;
  }
}

function extractLoLBuild(liveJson) {
  if (!liveJson || liveJson.__error) return { direct: null, artifact: null, manifest: null };
  // Bazı patchline JSON’larında kökte 'version' var
  const direct = liveJson?.version || null;
  const rel = Array.isArray(liveJson?.releases) ? liveJson.releases[0] : null;
  const artifact = rel?.release?.labels?.['riot:artifact_version_id']?.values?.[0] || null;
  const manifest = rel?.download?.url || null;
  return { direct, artifact, manifest };
}
function shortenArtifact(v) {
  if (!v) return null;
  return v.split('+')[0];
}

// --- Bölge için çoklu slug dene, ilk başarılıyı kullan ---
async function fetchLoLLongForRegion(regionKey) {
  const candidates = PATCHLINE_CANDIDATES[regionKey] || [regionKey];
  const tried = [];
  for (const slug of candidates) {
    const url = LIVE_URL(slug);
    tried.push(url);
    const live = await jget(url);
    if (live && !live.__error) {
      const { direct, artifact, manifest } = extractLoLBuild(live);
      let chosen = direct || artifact || null;

      if (!chosen && manifest) {
        const text = await tget(manifest);
        if (text) {
          const m = text.match(/riot:artifact_version_id[^"\n]*"(.*?)"/);
          if (m) chosen = m[1];
        }
      }
      if (chosen) {
        return { version: shortenArtifact(chosen), tried, used: url };
      }
      // JSON geldi ama içinde beklenen alan yoksa diğer adaya geç
    }
    // JSON gelmediyse (404/403 vs) diğer adayı dene
  }
  // Hiçbiri olmadı
  return { version: null, tried, used: null };
}

async function fetchVGC() {
  const conf = await jget(VGC_URL);
  return conf?.anticheat?.vanguard?.version || null;
}
async function postDiscord(content) {
  if (!DISCORD) {
    console.log('[DRY RUN] Discord tanımsız. Mesaj:\n' + content);
    return;
  }
  try {
    const r = await fetch(DISCORD, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    console.log(`[Discord] HTTP ${r.status}`);
  } catch (e) {
    console.error(`[Discord] gönderim hatası: ${e.message}`);
  }
}

(async () => {
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { lol: {}, vgc: null };

  // Bölgeleri paralel çek
  const results = await Promise.all(
    REGIONS.map(async r => {
      const res = await fetchLoLLongForRegion(r);
      return [r, res];
    })
  );
  const lolCurrent = Object.fromEntries(results.map(([r, res]) => [r, res.version]));

  const vgcCurrent = await fetchVGC();

  // Değişiklik algılama
  let anyChange = false;
  const regionBlocks = [];

  for (const [region, res] of results) {
    const oldV = prev.lol?.[region] || null;
    const newV = res.version || null;
    if (newV && oldV !== newV) anyChange = true;

    const title = `🌍 ${region.toUpperCase()}`;
    const oldLine = `① 🎮 OLD LOL version ➜ ${oldV || '—'}`;
    const newLine = `② 🔴 Latest LOL version       ➜ ${newV || '—'}`;
    // Eğer hiç bulunamadıysa küçük bir ipucu ekleyelim (ilk denenen URL'yi gösterir)
    const hint = newV ? '' : ` (not found; tried: ${res.tried[0]})`;
    regionBlocks.push(`${title}\n${oldLine}\n${newLine}${hint}`);
  }

  const oldVGC = prev.vgc || null;
  const newVGC = vgcCurrent || null;
  if (newVGC && oldVGC !== newVGC) anyChange = true;

  const vgcBlock = [
    `③ 🛡️ OLD VGC version ➜ ${oldVGC || '—'}`,
    `④ 🟢 Latest VGC version       ➜ ${newVGC || '—'}`
  ].join('\n');

  if (anyChange) {
    const header = '📊 Versions';
    const sep = '────────────────────────────────';
    const msg = [header, ...regionBlocks, sep, vgcBlock].join('\n');
    await postDiscord(msg);

    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lol: lolCurrent, vgc: newVGC }, null, 2),
      'utf8'
    );
    console.log('State updated and message sent.');
  } else {
    console.log('No changes.');
  }
})().catch(e => console.error(`Uncaught error: ${e.message}`));
