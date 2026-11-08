// Henter karakter, udstyr og auktionshus-data for WoW Forever via Battle.net API
// og skriver data/character.json + data/market.json.
//
// Kræver env: BNET_CLIENT_ID, BNET_CLIENT_SECRET
// Valgfri env: USE_SCRAPED=1 (brug data/scraped.json hvis profil-API fejler)
//
// Forever-API'et er udokumenteret (nov. 2026). Stier er baseret på community-probing:
// https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, 2)); };
const log = (...a) => console.log('[update]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHAMAN_CLASS_ID = 7;
const ITEM_CACHE_RETRY_DAYS = 7;

// inventory_type -> hvilke equipment-slots det sammenlignes med
export const INV_TO_SLOTS = {
  HEAD: ['HEAD'], NECK: ['NECK'], SHOULDER: ['SHOULDER'], CLOAK: ['BACK'],
  CHEST: ['CHEST'], ROBE: ['CHEST'], WRIST: ['WRIST'], HAND: ['HANDS'],
  WAIST: ['WAIST'], LEGS: ['LEGS'], FEET: ['FEET'],
  FINGER: ['FINGER_1', 'FINGER_2'], TRINKET: ['TRINKET_1', 'TRINKET_2'],
  WEAPON: ['MAIN_HAND'], WEAPONMAINHAND: ['MAIN_HAND'], TWOHWEAPON: ['MAIN_HAND'],
  SHIELD: ['OFF_HAND'], HOLDABLE: ['OFF_HAND'],
};

// ---------- Battle.net API ----------
export function makeApi({ region, locale, clientId, clientSecret, fetchImpl = fetch }) {
  const host = `https://${region}.api.blizzard.com`;
  let token = null;

  async function getToken() {
    const res = await fetchImpl('https://oauth.battle.net/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`OAuth fejlede: HTTP ${res.status}`);
    token = (await res.json()).access_token;
  }

  // nsType: 'profile' | 'dynamic' | 'static'
  async function get(p, nsType) {
    if (!token) await getToken();
    const sep = p.includes('?') ? '&' : '?';
    const url = `${host}${p}${sep}namespace=${nsType}-forever-${region}&locale=${locale}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      if (res.status === 401 && attempt === 0) { await getToken(); continue; }
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(`HTTP ${res.status} på ${p}`);
    }
    throw new Error(`Gav op efter gentagne fejl på ${p}`);
  }

  return { get, init: getToken };
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// ---------- Normalisering ----------
function statsMap(list) {
  const st = {};
  for (const s of list || []) {
    if (s.is_negated) continue;
    const k = s.type?.type; if (!k) continue;
    st[k] = (st[k] || 0) + (s.value || 0);
  }
  return st;
}

// Fra /data/wow/item/{id}
export function normItem(d) {
  const p = d.preview_item || {};
  return {
    n: d.name,
    q: (d.quality?.type || 'COMMON').toLowerCase(),
    c: d.item_class?.id,
    sc: d.item_subclass?.id,
    inv: d.inventory_type?.type,
    il: d.level ?? p.level?.value ?? null,
    rl: d.required_level ?? p.requirements?.level?.value ?? 0,
    st: statsMap(p.stats),
    ar: p.armor?.value || 0,
    dps: p.weapon?.dps?.value || 0,
    cls: (p.requirements?.playable_classes?.links || []).map((x) => x.id),
    m: d.media?.id ?? d.id,
  };
}

// Fra equipment-endpointet
export function normEquipped(e) {
  return {
    slot: e.slot?.type,
    slotName: e.slot?.name,
    id: e.item?.id,
    name: e.name,
    quality: (e.quality?.type || 'COMMON').toLowerCase(),
    inv: e.inventory_type?.type,
    c: e.item_class?.id,
    sc: e.item_subclass?.id,
    ilvl: e.level?.value ?? null,
    st: statsMap(e.stats),
    ar: e.armor?.value || 0,
    dps: e.weapon?.dps?.value || 0,
    mediaId: e.media?.id ?? e.item?.id,
    icon: null,
  };
}

export function score(it, w) {
  let s = 0;
  for (const [k, v] of Object.entries(it.st || {})) s += (w[k] || 0) * v;
  s += (w.ARMOR || 0) * (it.ar || 0);
  if (it.c === 2) s += (w.DPS || 0) * (it.dps || 0);
  return Math.round(s * 10) / 10;
}

// ---------- Opgraderinger ----------
export function computeUpgrades({ equipment, level, itemCache, prices, cfg }) {
  const w = cfg.weights;
  const bySlot = Object.fromEntries(equipment.map((e) => [e.slot, { ...e, score: score(e, w) }]));
  const mh = bySlot.MAIN_HAND;
  const mhIs2H = mh?.inv === 'TWOHWEAPON';
  const maxCopper = cfg.maxBuyoutGold * 10000;
  const equippedIds = new Set(equipment.map((e) => e.id));
  const out = [];

  for (const [idStr, price] of Object.entries(prices)) {
    const id = Number(idStr);
    const it = itemCache[idStr];
    if (!it || it.miss || equippedIds.has(id)) continue;
    const slots = INV_TO_SLOTS[it.inv];
    if (!slots) continue;
    if (it.c === 4 && !cfg.armorSubclasses.includes(it.sc)) continue;
    if (it.c === 2 && !cfg.weaponSubclasses.includes(it.sc)) continue;
    if (it.c !== 2 && it.c !== 4) continue;
    if (it.cls?.length && !it.cls.includes(SHAMAN_CLASS_ID)) continue;
    if (it.rl > level + cfg.levelLookahead) continue;
    if (price.min > maxCopper) continue;

    let current, currentLabel;
    if (it.inv === 'TWOHWEAPON') {
      current = (mh?.score || 0) + (mhIs2H ? 0 : bySlot.OFF_HAND?.score || 0);
      currentLabel = mhIs2H ? mh?.name : [mh?.name, bySlot.OFF_HAND?.name].filter(Boolean).join(' + ');
    } else if (slots[0] === 'OFF_HAND') {
      if (mhIs2H) continue; // skjold giver ikke mening med 2H
      current = bySlot.OFF_HAND?.score || 0; currentLabel = bySlot.OFF_HAND?.name;
    } else {
      // ved ring/trinket: sammenlign med det svageste af de to
      const cands = slots.map((s) => bySlot[s]);
      const weakest = cands.reduce((a, b) => ((a?.score ?? 0) <= (b?.score ?? 0) ? a : b));
      current = weakest?.score || 0; currentLabel = weakest?.name;
    }

    const s = score(it, w);
    const delta = Math.round((s - current) * 10) / 10;
    if (delta <= 0) continue;

    out.push({
      id, name: it.n, quality: it.q, inv: it.inv, slotGroup: slots[0].replace(/_\d$/, ''),
      requiredLevel: it.rl, usableNow: it.rl <= level, itemLevel: it.il,
      stats: it.st, armor: it.ar, dps: it.dps,
      score: s, delta, current: { name: currentLabel || null, score: current },
      price: { copper: price.min, houseId: price.houseId, listings: price.count },
      mediaId: it.m, icon: it.icon || null,
    });
  }

  // top N pr. slotgruppe, sorteret efter forbedring
  const groups = {};
  for (const u of out.sort((a, b) => b.delta - a.delta)) {
    (groups[u.slotGroup] ||= []);
    if (groups[u.slotGroup].length < cfg.perSlot) groups[u.slotGroup].push(u);
  }
  return Object.values(groups).flat().sort((a, b) => b.delta - a.delta);
}

// ---------- Main ----------
export async function main({ fetchImpl = fetch, env = process.env } = {}) {
  const cfg = readJson(path.join(ROOT, 'config.json'));
  const { region, locale, character: slug } = cfg;
  if (!env.BNET_CLIENT_ID || !env.BNET_CLIENT_SECRET) throw new Error('Mangler BNET_CLIENT_ID / BNET_CLIENT_SECRET');
  const api = makeApi({ region, locale, clientId: env.BNET_CLIENT_ID, clientSecret: env.BNET_CLIENT_SECRET, fetchImpl });
  await api.init(); // fejler tydeligt ved forkert Client ID/Secret

  const cachePath = path.join(DATA, 'item-cache.json');
  const itemCache = readJson(cachePath, {});
  const now = new Date();

  async function iconFor(mediaId) {
    const key = `m${mediaId}`;
    if (itemCache[key]) return itemCache[key];
    try {
      const m = await api.get(`/data/wow/media/item/${mediaId}`, 'static');
      const url = m?.assets?.find((a) => a.key === 'icon')?.value || null;
      if (url) itemCache[key] = url;
      return url;
    } catch { return null; }
  }

  // --- Karakter ---
  const base = `/profile/wow/character/${slug}`;
  const warnings = [];
  const safe = (p, label) => p.then((r) => { if (r == null) warnings.push(`${label}: 404`); return r; })
    .catch((e) => { warnings.push(`${label}: ${e.message}`); log('advarsel:', label, e.message); return null; });
  const [profile, equipRes, media, quests] = await Promise.all([
    safe(api.get(base, 'profile'), 'profile'),
    safe(api.get(`${base}/equipment`, 'profile'), 'equipment'),
    safe(api.get(`${base}/character-media`, 'profile'), 'character-media'),
    safe(api.get(`${base}/quests/completed`, 'profile'), 'quests/completed'),
  ]);

  let source = 'api';
  let charProfile, equipment, scrapeDebug = null, scrapedMedia = null;
  if (profile && equipRes) {
    charProfile = {
      name: profile.name,
      surname: profile.surname || null,
      level: profile.level,
      race: profile.race?.name,
      class: profile.character_class?.name,
      faction: profile.faction?.name,
      guild: profile.guild?.name || null,
      ruleset: profile.ruleset ? { id: profile.ruleset.id, name: profile.ruleset.name } : null,
      averageItemLevel: profile.average_item_level ?? null,
      equippedItemLevel: profile.equipped_item_level ?? null,
      lastLogin: profile.last_login_timestamp ? new Date(profile.last_login_timestamp).toISOString() : null,
    };
    equipment = (equipRes.equipped_items || []).map(normEquipped);
    await pool(equipment, 6, async (e) => { e.icon = await iconFor(e.mediaId); });
  } else if (env.USE_SCRAPED === '1' && fs.existsSync(path.join(DATA, 'scraped.json'))) {
    const sc = readJson(path.join(DATA, 'scraped.json'));
    source = 'scrape';
    charProfile = sc.profile;
    scrapeDebug = sc.debug || null;
    scrapedMedia = sc.media || null;
    equipment = await enrichScraped(sc.equipment || []);
  } else {
    log('Profil/udstyr kunne ikke hentes via API -> fallback til scraping');
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'needs_scrape=true\n');
    return { needsScrape: true };
  }

  // Slå scrapede items op i item-API'et for at få slot, stats og ikon
  async function enrichScraped(list) {
    const used = new Set();
    const out = [];
    for (const e of list) {
      let id = e.id;
      if (!id && e.name) {
        try {
          const r = await api.get(`/data/wow/search/item?name.${locale}=${encodeURIComponent(e.name)}&orderby=id&_pageSize=20`, 'static');
          const hit = (r?.results || []).find((x) => (x.data?.name?.[locale] || x.data?.name) === e.name);
          id = hit?.data?.id || null;
          if (!id) warnings.push(`item-search: intet match for "${e.name}"`);
        } catch (err) { warnings.push(`item-search "${e.name}": ${err.message}`); }
      }
      let it = null;
      if (id) {
        try { const d = await api.get(`/data/wow/item/${id}`, 'static'); it = d ? normItem(d) : null; if (!d) warnings.push(`item ${id}: 404`); }
        catch (err) { warnings.push(`item ${id}: ${err.message}`); }
      }
      let slot = e.slot;
      if (!slot && it?.inv && INV_TO_SLOTS[it.inv]) {
        slot = INV_TO_SLOTS[it.inv].find((s) => !used.has(s)) || INV_TO_SLOTS[it.inv][0];
      }
      if (slot) used.add(slot);
      out.push({
        slot: slot || null, slotName: null, id: id || null, name: e.name,
        quality: it?.q || e.quality || 'common', inv: it?.inv || null, c: it?.c, sc: it?.sc,
        ilvl: e.ilvl ?? it?.il ?? null, st: it?.st || {}, ar: it?.ar || 0, dps: it?.dps || 0,
        mediaId: it?.m ?? id, icon: e.icon || (id ? await iconFor(it?.m ?? id) : null),
        enriched: !!it,
      });
    }
    return out;
  }

  const mediaAssets = Object.fromEntries((media?.assets || []).map((a) => [a.key, a.value]));
  const character = {
    last_updated: now.toISOString(),
    source,
    profile: charProfile,
    media: {
      main: mediaAssets['main-raw'] || mediaAssets.main || scrapedMedia?.main || null,
      avatar: mediaAssets.avatar || scrapedMedia?.avatar || null,
    },
    equipment,
    completed_quests: quests?.quests ? quests.quests.map((q) => ({ id: q.id, name: q.name })) : null,
    debug: { apiWarnings: warnings, scrape: scrapeDebug },
  };
  writeJson(path.join(DATA, 'character.json'), character);
  log(`character.json skrevet (${source}, level ${charProfile.level}, ${equipment.length} items)`);

  // --- Auktionshus ---
  let market = { last_updated: now.toISOString(), error: null, houses: [], upgrades: [] };
  try {
    if (!equipment.some((e) => e.c != null)) throw new Error('Ingen item-stats for dit udstyr – kan ikke sammenligne');
    const rulesetId = charProfile.ruleset?.id ?? cfg.auction.rulesetIdFallback;
    const index = await api.get(`/data/wow/ruleset/${rulesetId}/auctions/`, 'dynamic');
    if (!index?.auctions?.length) throw new Error('Auktionshus-indeks tomt eller utilgængeligt');

    const filter = (cfg.auction.houseNameFilter || '').toLowerCase();
    const houses = index.auctions.filter((h) =>
      cfg.auction.houseIds.length ? cfg.auction.houseIds.includes(h.id) : (h.name || '').toLowerCase().includes(filter));

    const prices = {};
    for (const h of houses) {
      const data = await api.get(`/data/wow/ruleset/${rulesetId}/auctions/${h.id}`, 'dynamic');
      const list = data?.auctions || [];
      market.houses.push({ id: h.id, name: h.name, auctions: list.length });
      for (const a of list) {
        if (!a.buyout || !a.item?.id) continue;
        const unit = Math.round(a.buyout / (a.quantity || 1));
        const p = (prices[a.item.id] ||= { min: Infinity, houseId: null, count: 0 });
        p.count++;
        if (unit < p.min) { p.min = unit; p.houseId = h.id; }
      }
    }
    log(`Scannede ${houses.length} auktionshuse, ${Object.keys(prices).length} unikke items`);

    // Hent item-data for ukendte IDs (caches i repoet)
    const stale = (e) => !e || (e.miss && (now - new Date(e.miss)) / 864e5 > ITEM_CACHE_RETRY_DAYS);
    const missing = Object.keys(prices).filter((id) => stale(itemCache[id]));
    log(`Henter ${missing.length} nye items fra static-namespace`);
    await pool(missing, 8, async (id) => {
      try {
        const d = await api.get(`/data/wow/item/${id}`, 'static');
        itemCache[id] = d ? normItem(d) : { miss: now.toISOString() };
      } catch (e) { log(`item ${id}:`, e.message); }
    });

    const upgrades = computeUpgrades({ equipment, level: charProfile.level, itemCache, prices, cfg: cfg.upgrades });
    await pool(upgrades, 6, async (u) => { u.icon = await iconFor(u.mediaId); });

    market = {
      ...market,
      rulesetId,
      scannedItems: Object.keys(prices).length,
      unknownItems: Object.keys(prices).filter((id) => itemCache[id]?.miss).length,
      weights: cfg.upgrades.weights,
      upgrades,
    };
  } catch (e) {
    log('Auktionshus-fejl:', e.message);
    market.error = e.message;
  }

  writeJson(path.join(DATA, 'market.json'), market);
  writeJson(cachePath, itemCache);
  log(`market.json skrevet (${market.upgrades.length} forslag)`);
  return { character, market };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
