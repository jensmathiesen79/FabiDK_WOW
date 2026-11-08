# Fabi Stormhammer – WoW Forever tracker

Statisk GitHub Pages-side, der hver 6. time henter karakter, udstyr og auktionshus-data via Battle.net API'et.

## Opsætning

1. **Nyt secret:** Generér et nyt Client Secret på develop.battle.net (det gamle har været delt i et screenshot).
2. **GitHub Secrets:** Repo → Settings → Secrets and variables → Actions → *New repository secret*:
   - `BNET_CLIENT_ID`
   - `BNET_CLIENT_SECRET`
3. **Filer:** Læg filerne fra denne mappe i roden af repoet. Slet det gamle workflow og den gamle `character.json` i roden (data ligger nu i `data/`).
4. **Kør:** Actions → *Update character + AH data* → *Run workflow*. Første kørsel tager længst, fordi item-data caches i `data/item-cache.json`.
5. **Pages:** Settings → Pages → Deploy from branch `main` / root (som i dag).

## Filer

| Fil | Formål |
| --- | --- |
| `scripts/update.mjs` | API: profil, udstyr, character-media, completed quests, auktionshus, item-stats |
| `scripts/scrape.mjs` | Fallback med Puppeteer, hvis profil-API'et fejler (giver ingen stats → ingen AH-forslag) |
| `config.json` | Karakter-slug, AH-filter, prisloft, stat-vægte, tilladte armor/våben-typer |
| `quests.json` | Kurateret liste over class-quests og milepæle (ret frit) |
| `index.html` | Selve siden |

## Justeringer i `config.json`

- `auction.houseIds`: Forever har flere auktionshuse med samme fraktionsnavn. Find ID'et på dit eget AH i `data/market.json` → `houses`, og lås det her (fx `[110]`).
- `upgrades.maxBuyoutGold`: prisloft pr. item.
- `upgrades.levelLookahead`: hvor mange levels frem forslagene må række.
- `upgrades.weights`: stat-vægte. Rækkefølgen Agi > Str > Sta > Int følger Method.gg. `DPS: 6` svarer til ca. 14 AP pr. våben-DPS omregnet til Str-ækvivalent. Det er en tommelfingerregel.
- `upgrades.armorSubclasses`: 0 = misc (ringe/hals/trinkets), 1 = cloth, 2 = leather, 6 = shield. Tilføj 3 (mail) ved level 40.
- `upgrades.weaponSubclasses`: 0/1 = 1H/2H axe, 4/5 = 1H/2H mace, 10 = stav, 13 = fist, 15 = dagger. Fjern typer, du ikke har trænet.

## Forbehold

Forever-API'et er udokumenteret (nov. 2026). Stierne bygger på community-probing:
https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334

Kendte forhold: karakterer er realm-løse (`fabi-stormhammer` = navn + efternavn), og ca. 40 % af AH-items svarer 404 fra item-endpointet. De udelades.
