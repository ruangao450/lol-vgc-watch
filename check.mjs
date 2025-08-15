// LoL uzun build (15.16.704.6097 gibi) + VGC sürümü izleme
// - Her bölge ayrı ayrı kontrol edilir
// - Sadece değişiklik olduğunda Discord'a mesaj atar
// - Önceki değerler .state/versions.json içinde saklanır
// - Manifest fallback: live-<slug>-win.json -> version N -> releases/N.(manifest|json)

import fs from 'fs';
import path from 'path';

const STATE_DIR  = '.state';
const STATE_FILE = path.join(STATE_DIR, 'versions.json');

const DISCORD = process.env.DISCORD_WEBHOOK || '';
const REGIONS = (process.env.LOL_REGIONS || 'euw,na,kr,br,lan,tr')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const DEBUG = process.env.DEBUG === '1';

// Patchline slug adayları (ilk başarılı kullanılır)
const CAND = {
  euw: ['euw','euw1','eu-west'],
  na:  ['na','na1','north-america'],
  kr:  ['kr','kr1'],
  br:  ['br','br1'],
  lan: ['lan','la1','latam-north'],
  tr:  ['tr','tr1'],
};

const LIVE = slug => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${slug}-win.json`;
const REL_MANIFEST = id => `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.manifest`;
const REL_JSON     = id => `https://lol.secure.dyn.riotcdn.net/channels/public/releases/${id}.json`;

const VGC_URL = 'https://clientconfig.rpg.riotgames.com/api/v1/config/public';

async function req(url, wantText = false) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0', 'Accept': wantText ? '*/*' : 'application/json' } });
    const status = r.status;
    const text = await r.text(); // önce text
    let json = null;
    if (!wantText) { try { json = JSON.parse(text); } catch {} }
    return { ok: r.ok, status, text, json };
  } catch (e) {
    return { ok: false, status: 0, err: e.message };
  }
}

const shorten = v => v ? String(v).split('+')[0] : null;

// live JSON içinden olabildiğince çok ipucu topla
function pickFromLiveJson(obj) {
  const direct = obj?.version ?? null; // 263 gibi
  const artifact =
    obj?.releases?.[0]?.release?.labels?.['riot:artifact_version_id']?.values?.[0] ??
    obj?.release?.labels?.['riot:artifact_version_id']?.values?.[0] ??
    obj?.labels?.['riot:artifact_version_id']?.values?.[0] ?? null;
  const manifestUrl = obj?.releases?.[0]?.download?.url ?? null;
  return { direct, artifact, manifestUrl };
}

// releases/N.manifest veya releases/N.json içinden artifact çıkar
function pickArtifactFromTextOrJson({ text, json }) {
  // 1) düz metin manifest: ... riot:artifact_version_id "15.16.704.6097+..."
  if (text) {
    const m = text.match(/riot:artifact_version_id[^"\n]*"([^"]+)"/);
    if (m) return m[1];
  }
  // 2) JSON manifest (bazı kanallarda oluyor)
  if (json) {
    const a1 =
      json?.release?.labels?.['riot:artifact_version_id']?.values?.[0] ??
      json?.labels?.['riot:artifact_version_id']?.values?.[0] ?? null;
    if (a1) return a1;
  }
  return null;
}

async function getLoLForRegion(region) {
  const tried = [];
  for (const slug of (CAND[region] || [region])) {
    const liveUrl = LIVE(slug);
    const live = await req(liveUrl);
    tried.push(`${slug}:${live.status}`);

    if (live.ok && live.json) {
      const { direct, artifact, manifestUrl } = pickFromLiveJson(live.json);

      // 1) doğrudan artifact varsa hemen dön
      if (artifact) {
        return { long: shorten(artifact), short: direct ?? null, debug: tried.concat('artifact:live') };
      }

      // 2) live JSON manifest URL veriyorsa, onu dene
      if (manifestUrl) {
        const man = await req(manifestUrl, true);
        tried.push(`manifest:${man.status}`);
        if (man.ok) {
          const art = pickArtifactFromTextOrJson(man);
          if (art) return { long: shorten(art), short: direct ?? null, debug: tried.concat('artifact:manifestURL') };
        }
      }

      // 3) live JSON sadece "version: N" verdiyse: releases/N.(manifest|json) tahmini
      if (typeof direct !== 'undefined' && direct !== null) {
        const id = String(direct).trim();
        // .manifest
        const man1 = await req(REL_MANIFEST(id), true);
        tried.push(`releases/${id}.manifest:${man1.status}`);
        if (man1.ok) {
          const art = pickArtifactFromTextOrJson(man1);
          if (art) return { long: shorten(art), short: id, debug: tried.concat('artifact:releases.manifest') };
        }
        // .json (bazı kanallarda JSON meta)
        const man2 = await req(REL_JSON(id), false);
        tried.push(`releases/${id}.json:${man2.status}`);
        if (man2.ok) {
          const art = pickArtifactFromTextOrJson(man2);
          if (art) return { long: shorten(art), short: id, debug: tried.concat('artifact:releases.json') };
        }
        // artifact bulunamazsa en azından kısa sürümü döndür
        return { long: null, short: id, debug: tried.concat('fallback:short') };
      }
    }
  }
  return { long: null, short: null, debug: tried.concat('no-live') };
}

async function getVGC() {
  const r = await req(VGC_URL);
  // 1) normal yol
  let v = r.json?.anticheat?.vanguard?.version ?? null;
  // 2) regex fallback (JSON şeması değişirse)
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
  // Önceki durum
  const prev = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : { lol: {}, vgc: null };

  // Bölgeleri çek
  const perRegion = await Promise.all(REGIONS.map(async r => [r, await getLoLForRegion(r)]));
  const lolCurrent = Object.fromEntries(perRegion.map(([r, res]) => [r, res.long || res.short || null]));

  // VGC
  const vgcRes = await getVGC();
  const vgcCurrent = vgcRes.vgc || null;

  // Mesajı oluştur + değişiklik algıla
  let anyChange = false;
  const regionBlocks = [];

  for (const [region, res] of perRegion) {
    const now = res.long || res.short || null;     // uzun varsa onu, yoksa kısa
    const old = prev.lol?.[region] || null;

    if (now && now !== old) anyChange = true;

    const title   = `🌍 ${region.toUpperCase()}`;
    const oldLine = `① 🎮 OLD LOL version ➜ ${old || '—'}`;
    const newLine = `② 🔴 Latest LOL version       ➜ ${now || '—'}`;
    const dbg     = DEBUG ? `\n↳ debug: ${res.debug.join(' | ')}` : '';
    regionBlocks.push(`${title}\n${oldLine}\n${newLine}${dbg}`);
  }

  const oldVGC = prev.vgc || null;
  const newVGC = vgcCurrent || null;
  if (newVGC && newVGC !== oldVGC) anyChange = true;

  const vgcBlock = [
    `③ 🛡️ OLD VGC version ➜ ${oldVGC || '—'}`,
    `④ 🟢 Latest VGC version       ➜ ${newVGC || '—'}${DEBUG ? ` (status: ${vgcRes.status})` : ''}`
  ].join('\n');

  if (anyChange || DEBUG) {
    const header = '📊 Versions';
    const sep    = '────────────────────────────────';
    const msg    = [header, ...regionBlocks, sep, vgcBlock].join('\n');
    await postDiscord(msg);

    // state güncelle
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lol: lolCurrent, vgc: newVGC }, null, 2), 'utf8');
    if (DEBUG) console.log('State updated.');
  } else {
    console.log('No changes.');
  }
})().catch(e => console.error(`Uncaught error: ${e.message}`));
