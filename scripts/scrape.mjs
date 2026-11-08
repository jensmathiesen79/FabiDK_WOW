// Fallback: scraper Armory-siden med Puppeteer, hvis profil-API'et ikke svarer.
// Skriver data/scraped.json (uden stats -> ingen opgraderingsforslag i denne tilstand).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
await page.goto(cfg.armoryUrl, { waitUntil: 'networkidle2', timeout: 90000 });
await new Promise((r) => setTimeout(r, 3000));

const result = await page.evaluate(() => {
  // 1) Armory-sider indlejrer typisk en initial state med hele karakteren
  const state = window.characterProfileInitialState;
  if (state?.character) {
    const c = state.character;
    const eq = state.equipment?.items || state.items || [];
    return {
      fromState: true,
      profile: {
        name: c.name, surname: c.surname || null, level: c.level,
        race: c.race?.name, class: c.class?.name, faction: c.faction?.name,
        guild: c.guild?.name || null, ruleset: null, averageItemLevel: c.averageItemLevel ?? null,
      },
      equipment: eq.map((i) => ({
        slot: (i.slot?.type || i.slot || '').toString().toUpperCase() || null,
        slotName: i.slot?.name || null,
        id: i.id || i.item?.id || null, name: i.name,
        quality: (i.quality?.type || i.quality || 'common').toString().toLowerCase(),
        icon: i.icon?.url || i.icon || null, st: {},
      })),
    };
  }

  // 2) DOM-fallback (skrøbelig – afhænger af Blizzards markup)
  const txt = document.body.innerText;
  const m = txt.match(/(\d+)\s+Dwarf\s+Shaman/i) || txt.match(/Level\s+(\d+)/i);
  const items = [];
  document.querySelectorAll('.GameIcon-icon').forEach((icon) => {
    let el = icon.parentElement;
    for (let i = 0; i < 5 && el && (el.innerText || '').trim().length < 3; i++) el = el.parentElement;
    const name = (el?.innerText || '').trim().split('\n').map((s) => s.trim()).find((s) => s.length > 2);
    if (!name || /level|specialization/i.test(name) || items.some((x) => x.name === name)) return;
    const html = (el.className + el.innerHTML).toLowerCase();
    const q = ['epic', 'rare', 'uncommon', 'poor'].find((k) => html.includes(k)) || 'common';
    const bg = icon.style.backgroundImage || '';
    items.push({ slot: null, id: null, name, quality: q, icon: bg.replace(/^url\(["']?|["']?\)$/g, '') || null, st: {} });
  });
  return { fromState: false, profile: { name: 'Fabi', surname: 'Stormhammer', level: m ? +m[1] : null }, equipment: items };
});

await browser.close();
fs.writeFileSync(path.join(ROOT, 'data', 'scraped.json'), JSON.stringify(result, null, 2));
console.log(`[scrape] ${result.equipment.length} items (initial state: ${result.fromState})`);
