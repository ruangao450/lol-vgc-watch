// DEBUG sürüm: HER ZAMAN kanala mesaj atar.
// Hangi URL'ler denendi, ne HTTP kodu geldi -> Discord mesajına da yazar.
// Çalıştığını görünce DEBUG env'ini kaldırıp "yalnız değişince gönder" moduna döneceğiz.

import fs from 'fs';
import path from 'path';

const DISCORD = process.env.DISCORD_WEBHOOK || '';
const REGIONS = (process.env.LOL_REGIONS || 'euw,na,kr,br,lan,tr')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DEBUG = true; // bu dosyada hep true; PROD'da env okumaya döndüreceğiz

// Bölge -> olası slug adayları (ilk başarılı olan kullanılır)
const CAND = {
  euw: ['euw','euw1','eu-west'],
  na:  ['na','na1','north-america'],
  kr:  ['kr','kr1'],
  br:  ['br','br1'],
  lan: ['lan','la1','latam-north'],
  tr:  ['tr','tr1'],
};

const LIVE = s => `https://lol.secure.dyn.riotcdn.net/channels/public/live-${s}-win.json`;
const VGC_URL = 'https://clientconfig.rpg.riotgames.com/api/v1/config/public';

async function req(url, asText=false) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'lol-vgc-watch/1.0', 'Accept': asText ? '*/*' : 'application/json' } });
    const status = r.status;
    const body = asText ? await r.text() : await r.text(); // önce text al, JSON'a sonra deneyelim
    let json = null;
    if (!asText) {
      try { json = JSON.parse(body); } catch { json = null; }
    }
    return { status, ok: r.ok, text: body, json };
  } catch (e) {
    return { status: 0, ok: false, err: e.message };
  }
}

function pickArtifact(obj) {
  // 3 farklı şemayı dene
  const a1 = obj?.releases?.[0]?.release?.labels?.['riot:artifact_version_id']?.values?.[0];
  const a2 = obj?.release?.labels?.['riot:artifact_version_id']?.values?.[0];
  const a3 = obj?.labels?.['riot:artifact_version_id']?.values?.[0];
  const direct = obj?.version; // bazı minimal JSON'lar sadece 'version' döndürebilir
  return (a1 || a2 || a3 || direct || null);
}
const shorten = v => v ? String(v).split('+')[0] : null;

async function getLoLForRegion(region) {
  const tried = [];
  for (const slug of (CAND[region] || [region])) {
    const url = LIVE(slug);
    const res = await req(url);
    tried.push(`${slug}:${res.status}`);
    if (res.ok && res.json) {
      let ver = pickArtifact(res.json);
      // artifact bulunamadıysa manifest'ten bakmayı dene
      const manifest = res.json?.releases?.[0]?.download?.url;
      if (!ver && manifest) {
        const m = await req(manifest, true);
        tried.push(`manifest:${m.status}`);
        if (m.ok && m.text) {
          const mm = m.text.match(/riot:artifact_version_id[^"\n]*"(.*?)"/);
          if (mm) ver = mm[1];
        }
      }
      if (ver) return { version: shorten(ver), debug: tried };
    }
  }
  return { version: null, debug: tried };
}

async function getVGC() {
  const res = await req(VGC_URL);
  const ver = res.json?.anticheat?.vanguard?.version || null;
  return { version: ver, status: res.status };
}

async function postDiscord(content) {
  if (!DISCORD) { console.log('[DRY]\n' + content); return; }
  const r = await fetch(DISCORD, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ content }) });
  console.log(`[Discord] HTTP ${r.status}`);
}

(async () => {
  const lines = ['📊 Versions'];
  const lol = {};
  for (const region of REGIONS) {
    const res = await getLoLForRegion(region);
    lol[region] = res.version || null;
    lines.push(`🌍 ${region.toUpperCase()}`);
    lines.push(`① 🎮 OLD LOL version ➜ —`);
    lines.push(`② 🔴 Latest LOL version       ➜ ${res.version || '—'}`);
    lines.push(`↳ debug: ${res.debug.join(' | ')}`);
  }

  const vgc = await getVGC();
  lines.push('────────────────────────────────');
  lines.push(`③ 🛡️ OLD VGC version ➜ —`);
  lines.push(`④ 🟢 Latest VGC version       ➜ ${vgc.version || '—'} (status: ${vgc.status})`);

  await postDiscord(lines.join('\n'));

  // Ayrıca runner loguna da yaz
  console.log(lines.join('\n'));
})();
