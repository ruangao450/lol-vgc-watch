import fs from 'fs';
import path from 'path';

const STATE_DIR = '.state';
const STATE_FILE = path.join(STATE_DIR, 'versions.json');

const DISCORD = process.env.DISCORD_WEBHOOK;
const REGIONS = (process.env.LOL_REGIONS || 'euw,na,kr,br,lan,tr')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const LIVE_URL = r => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${r}-win.json`;
const VGC_URL = 'https://clientconfig.rpg.riotgames.com/api/v1/config/public';

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR);

async function jget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
async function tget(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}
function extractLoLBuild(liveJson) {
  const direct = liveJson?.version || null;
  const rel = liveJson?.releases?.[0];
  const labels = rel?.release?.labels;
  const artifact = labels?.['riot:artifact_version_id']?.values?.[0] || null;
  const manifest = rel?.download?.url || null;
  return { direct, artifact, manifest };
}
function shortenArtifact(v) {
  if (!v) return null;
  return v.split('+')[0];
}
async function fetchLoLLong(region) {
  const live = await jget(LIVE_URL(region));
  const { direct, artifact, manifest } = extractLoLBuild(live);
  let chosen = direct || artifact || null;

  if (!chosen && manifest) {
    try {
      const text = await tget(manifest);
      const m = text.match(/riot:artifact_version_id[^"\n]*"(.*?)"/);
      if (m) chosen = m[1];
    } catch {}
  }
  return shortenArtifact(chosen);
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
  await fetch(DISCORD, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  });
}

(async () => {
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { lol: {}, vgc: null };

  const lolPairs = await Promise.all(
    REGIONS.map(async region => {
      try {
        const v = await fetchLoLLong(region);
        return [region, v];
      } catch (e) {
        return [region, null];
      }
    })
  );
  const lolCurrent = Object.fromEntries(lolPairs);
  const vgcCurrent = await fetchVGC();

  let anyChange = false;
  const regionBlocks = [];

  for (const region of REGIONS) {
    const oldV = prev.lol?.[region] || null;
    const newV = lolCurrent[region] || null;
    if (newV && oldV !== newV) anyChange = true;

    const title = `🌍 ${region.toUpperCase()}`;
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
  } else {
    console.log('No changes.');
  }
})().catch(async e => {
  const err = `⚠️ Hata: ${e.message}`;
  console.error(err);
  try { await postDiscord(err); } catch {}
  process.exit(1);
});
