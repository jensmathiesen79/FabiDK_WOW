// Fallback: scraper Armory-siden med Puppeteer, hvis profil-API'et ikke svarer.
// Skriver data/scraped.json. Stats/slots slås bagefter op i update.mjs via item-API'et.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

// Opsaml JSON-svar, som siden selv henter (Armory loader ofte udstyr via XHR)
const captured = [];
page.on('response', async (res) => {
  try {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const body = await res.json();
    captured.push({ url: res.url(), body });
  } catch { /* ignorer */ }
});

await page.goto(cfg.armoryUrl, { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 4000));

const fromPage = await page.evaluate(() => {
  const state = window.characterProfileInitialState || null;

  // Beskriv strukturen (til fejlfinding)
  const shape = (o, depth = 0) => {
    if (depth > 3 || o == null) return typeof o;
    if (Array.isArray(o)) return [o.length, o.length ? shape(o[0], depth + 1) : null];
    if (typeof o !== 'object') return typeof o;
    return Object.fromEntries(Object.keys(o).slice(0, 40).map((k) => [k, shape(o[k], depth + 1)]));
  };

  // DOM-fallback: navne, ikoner, kvalitet og evt. item-id fra links/attributter
  const dom = [];
  document.querySelectorAll('.GameIcon-icon, [data-item-id]').forEach((icon) => {
    let el = icon.parentElement;
    for (let i = 0; i < 5 && el && (el.innerText || '').trim().length < 3; i++) el = el.parentElement;
    if (!el) return;
    const name = (el.innerText || '').trim().split('\n').map((s) => s.trim()).find((s) => s.length > 2);
    if (!name || /level|specialization|item level/i.test(name) || dom.some((x) => x.name === name)) return;
    const html = (el.className + ' ' + el.innerHTML).toLowerCase();
    const q = ['legendary', 'epic', 'rare', 'uncommon', 'poor'].find((k) => html.includes(k)) || 'common';
    const iconEl = el.querySelector('.GameIcon-icon') || icon;
    const bg = iconEl.style?.backgroundImage || '';
    const idAttr = el.querySelector('[data-item-id]')?.getAttribute('data-item-id') || icon.getAttribute?.('data-item-id');
    const href = el.closest('a')?.href || el.querySelector('a')?.href || '';
    const idHref = (href.match(/item[=/](\d+)/) || [])[1];
    dom.push({ name, quality: q, icon: bg.replace(/^url\(["']?|["']?\)$/g, '') || null, id: Number(idAttr || idHref) || null, slot: null });
  });

  const txt = document.body.innerText;
  const m = txt.match(/(\d+)\s+Dwarf\s+Shaman/i);
  return { state, stateShape: state ? shape(state) : null, dom, level: m ? +m[1] : null };
});
await browser.close();

// ---------- Find udstyr i vilkårlig JSON ----------
const SLOT_ALIAS = {
  SHOULDERS: 'SHOULDER', CLOAK: 'BACK', GLOVES: 'HANDS', HAND: 'HANDS', BELT: 'WAIST', BOOTS: 'FEET',
  BRACERS: 'WRIST', MAINHAND: 'MAIN_HAND', OFFHAND: 'OFF_HAND', RING1: 'FINGER_1', RING2: 'FINGER_2',
  FINGER1: 'FINGER_1', FINGER2: 'FINGER_2', TRINKET1: 'TRINKET_1', TRINKET2: 'TRINKET_2', RANGE: 'RANGED',
};
const VALID = new Set(['HEAD','NECK','SHOULDER','BACK','CHEST','SHIRT','TABARD','WRIST','HANDS','WAIST','LEGS','FEET',
  'FINGER_1','FINGER_2','TRINKET_1','TRINKET_2','MAIN_HAND','OFF_HAND','RANGED']);
function normSlot(s) {
  if (!s) return null;
  let v = (typeof s === 'object' ? s.type || s.slug || s.name : s);
  if (!v) return null;
  v = String(v).toUpperCase().replace(/[-\s]/g, '_');
  const compact = v.replace(/_/g, '');
  v = SLOT_ALIAS[compact] || SLOT_ALIAS[v] || v;
  return VALID.has(v) ? v : null;
}
const str = (x) => (typeof x === 'string' ? x : x?.en_US || x?.en_GB || x?.name || null);
function normEntry(e) {
  const name = str(e.name) || str(e.item?.name);
  if (!name) return null;
  const q = e.quality?.type || e.quality?.slug || e.quality?.name || e.quality || e.item?.quality?.type || 'common';
  const icon = e.icon?.url || (typeof e.icon === 'string' ? e.icon : null) || e.media?.assets?.[0]?.value || e.media?.url || null;
  return {
    slot: normSlot(e.slot || e.inventoryType || e.inventory_type || e.slotType),
    id: Number(e.item?.id || e.itemId || e.item_id || e.id) || null,
    name, quality: String(q).toLowerCase(), icon,
    ilvl: e.level?.value ?? e.itemLevel ?? e.item_level ?? null,
  };
}
function findEquipment(root) {
  let best = [];
  const seen = new Set();
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8 || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      const objs = o.filter((x) => x && typeof x === 'object');
      const looks = objs.filter((x) => (x.name || x.item?.name) && (x.slot || x.inventoryType || x.inventory_type || x.quality));
      // arrays med slot-felter vægtes højest (undgår fx achievement-lister)
      const rank = (arr) => arr.length + (arr.filter((x) => x.slot || x.inventoryType || x.inventory_type).length >= 2 ? 1000 : 0);
      if (looks.length >= 2 && rank(looks) > rank(best)) best = looks;
      o.forEach((x) => walk(x, depth + 1));
    } else Object.values(o).forEach((x) => walk(x, depth + 1));
  })(root, 0);
  return best.map(normEntry).filter(Boolean);
}
function findMedia(root) {
  const out = {};
  const seen = new Set();
  (function walk(o, d) {
    if (!o || d > 8) return;
    if (typeof o === 'string') {
      if (/render\.worldofwarcraft\.com/.test(o)) {
        if (/avatar/.test(o) && !out.avatar) out.avatar = o;
        else if (/main/.test(o) && !out.main) out.main = o;
      }
      return;
    }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    Object.values(o).forEach((x) => walk(x, d + 1));
  })(root, 0);
  return out;
}

const st = fromPage.state;
const c = st?.character || {};
let equipment = st ? findEquipment(st) : [];
let equipmentSource = equipment.length ? 'state' : null;
if (!equipment.length) {
  for (const cap of captured) {
    const found = findEquipment(cap.body);
    if (found.length > equipment.length) { equipment = found; equipmentSource = 'xhr:' + cap.url.split('?')[0]; }
  }
}
if (!equipment.length && fromPage.dom.length) { equipment = fromPage.dom; equipmentSource = 'dom'; }

const result = {
  profile: {
    name: str(c.name) || 'Fabi', surname: str(c.surname) || 'Stormhammer',
    level: c.level ?? fromPage.level, race: str(c.race), class: str(c.class) || str(c.character_class),
    faction: str(c.faction), guild: str(c.guild), ruleset: null,
    averageItemLevel: c.averageItemLevel ?? c.average_item_level ?? null,
  },
  media: findMedia(st || {}),
  equipment,
  debug: {
    equipmentSource,
    stateFound: !!st,
    stateShape: fromPage.stateShape,
    xhrUrls: captured.map((x) => x.url.split('?')[0]).slice(0, 30),
    domItems: fromPage.dom.length,
  },
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'scraped.json'), JSON.stringify(result, null, 2));
console.log(`[scrape] ${equipment.length} items (kilde: ${equipmentSource}), state: ${!!st}, xhr: ${captured.length}`);
