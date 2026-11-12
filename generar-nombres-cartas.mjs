import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./cartas.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { timeout: 3000 });
const cards = sandbox.window.CARTAS || [];

const sets = {
  A1: 'genetic-apex',
  A1a: 'mythical-island',
  A2: 'space-time-smackdown',
  A2a: 'triumphant-light',
  A2b: 'shining-revelry',
  A3: 'celestial-guardians',
  A3a: 'extradimensional-crisis',
  A3b: 'eevee-grove',
  A4: 'wisdom-of-sea-and-sky',
  A4a: 'secluded-springs',
  A4b: 'deluxe-pack-ex',
  B1: 'mega-rising',
  B1a: 'crimson-blaze',
  B2: 'fantastical-parade',
  B2a: 'paldean-wonders',
  B2b: 'mega-shine',
  B3: 'pulsing-aura',
  B3a: 'paradox-drive',
  B3b: 'everyday-wonders',
  B4: 'ruler-of-the-skies',
  B4a: 'team-rockets-ambition',
  'P-A': 'promos-a',
  'P-B': 'promos-b'
};

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseCards(html, setId) {
  const result = new Map();
  const links = /<a\b[^>]*href="\/en\/card\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(links)) {
    const imageAlt = match[2].match(/<img\b[^>]*\balt="([^"]+)"/i)?.[1];
    if (imageAlt) {
      const code = match[1].includes('-') ? match[1] : `${setId}-${match[1]}`;
      result.set(code, decodeHtml(imageAlt));
    }
  }
  return result;
}

function cardCode(card) {
  const promo = card.n.match(/^PROMO ([AB]) (\d{3})/i);
  if (promo) return `P-${promo[1].toUpperCase()}-${promo[2]}`;
  const regular = card.n.match(/^([A-Z]\d[a-z]?) (\d{3})/);
  return regular ? `${regular[1]}-${regular[2]}` : null;
}

const requiredCodes = new Set(cards.map(cardCode).filter(Boolean));
const unrecognized = cards.filter(card => !cardCode(card));
if (unrecognized.length) {
  console.log('Elementos sin código de carta:', unrecognized.map(card => `${card.e}: ${card.n}`).join(' | '));
}
const names = {};
const failures = [];
for (const [setId, slug] of Object.entries(sets)) {
  const response = await fetch(`https://pokemontcgpocket.app/en/set/${slug}`);
  if (!response.ok) {
    failures.push(`${setId}: HTTP ${response.status}`);
    continue;
  }
  const html = await response.text();
  const setCards = parseCards(html, setId);
  for (const [code, name] of setCards) {
    if (requiredCodes.has(code)) names[code] = name;
  }
}

const missing = [...requiredCodes].filter(code => !names[code]);
if (missing.length) {
  console.error(`Nombres no encontrados (${missing.length}): ${missing.join(', ')}`);
  if (failures.length) console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  const output = `window.TCG_CARD_NAMES=${JSON.stringify(names)};\n`;
  fs.writeFileSync(new URL('./nombres-cartas.js', import.meta.url), output, 'utf8');
  console.log(`Nombres generados: ${Object.keys(names).length} códigos; ${unrecognized.length} artículos sin código de carta.`);
}
