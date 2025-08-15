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
  const artifact = rel
