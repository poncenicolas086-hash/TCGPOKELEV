// Ejecutar localmente: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node supabase/seed-cards.mjs
// Nunca subas estas variables ni la service_role key al repositorio.
import fs from 'node:fs';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY');
const source = fs.readFileSync(new URL('../cartas.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox, { timeout: 3000 });
const namesSource = fs.readFileSync(new URL('../nombres-cartas.js', import.meta.url), 'utf8');
vm.runInNewContext(namesSource, sandbox, { timeout: 3000 });
const nameMap = sandbox.window.TCG_CARD_NAMES || {};
const codeFor = card => {
  const promo = card.n.match(/^PROMO ([AB]) (\d{3})/i);
  if (promo) return `P-${promo[1].toUpperCase()}-${promo[2]}`;
  const regular = card.n.match(/^([A-Z]\d[a-z]?) (\d{3})/);
  return regular ? `${regular[1]}-${regular[2]}` : null;
};
const cards = (sandbox.window.CARTAS || []).map(c => ({
  id: c.id, name: c.name || nameMap[codeFor(c)] || c.n, expansion: c.e, rarity: c.r, image_path: c.f
}));
if (!cards.length) throw new Error('cartas.js no contiene cartas');
const supabase = createClient(url, key, { auth: { persistSession: false } });
for (let i = 0; i < cards.length; i += 500) {
  const { error } = await supabase.from('cards').upsert(cards.slice(i, i + 500), { onConflict: 'id' });
  if (error) throw error;
}
console.log(`Catálogo sincronizado: ${cards.length} cartas.`);
