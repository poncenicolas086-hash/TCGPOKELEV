// Uso: node generar-cartas.js   (genera cartas.js leyendo la carpeta "cartas")
// Rarezas: C, UC, R, SR, UR. Para forzar una rareza creá rarezas.json, ej:
//   { "base1/charizard.png": "UR", "pikachu.png": "SR" }
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, 'cartas'), IMG = /\.(png|jpe?g|webp)$/i, VALID = ['C', 'UC', 'R', 'SR', 'UR'];
if (!fs.existsSync(dir)) { console.error('No encuentro la carpeta "cartas" junto a este archivo.'); process.exit(1); }
const ovF = path.join(__dirname, 'rarezas.json');
let ov = {};
if (fs.existsSync(ovF)) {
  const txt = fs.readFileSync(ovF, 'utf8').replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1');
  try { ov = JSON.parse(txt); }
  catch (e) { console.error('ERROR en rarezas.json: ' + e.message + '\nRevisa ese archivo (comas, comillas, llaves) o volve a copiar el original.'); process.exit(1); }
}
const TOP = /charizard|mewtwo|rayquaza|lugia|umbreon|gengar|dragonite|arceus|lucario|greninja|pikachu|mew\b/i;
const hash = s => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 100; };
function rareza(exp, file, name) {
  const o = ov[exp + '/' + file] || ov[file]; if (VALID.includes(o)) return o;
  if (/vmax|vstar|\bgx\b|-gx|rainbow|secret|gold|full.?art/i.test(name)) return 'UR';
  if (/(^|[\s_-])(ex|v)([\s_-]|$)/i.test(name) || TOP.test(name)) return 'SR';
  const h = hash(exp + file); return h < 55 ? 'C' : h < 85 ? 'UC' : 'R';
}

const SUPABASE_STORAGE_URL = 'https://irqccifpkkpgpbaepgbo.supabase.co/storage/v1/object/public/cartas/';
const lista = [];
const add = (exp, file, rel) => {
  const name = file.replace(IMG, '').replace(/[_-]+/g, ' ').trim();
  lista.push({ id: lista.length, n: name, e: exp, r: rareza(exp, file, name), f: SUPABASE_STORAGE_URL + rel });
};
for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (d.isDirectory()) {
    for (const f of fs.readdirSync(path.join(dir, d.name)).filter(f => IMG.test(f)).sort())
      add(d.name, f, encodeURIComponent(d.name) + '/' + encodeURIComponent(f));
  } else if (IMG.test(d.name)) add('General', d.name, encodeURIComponent(d.name));
}
fs.writeFileSync(path.join(__dirname, 'cartas.js'), 'window.CARTAS=' + JSON.stringify(lista) + ';\n');
const cnt = {}; lista.forEach(c => cnt[c.r] = (cnt[c.r] || 0) + 1);
console.log('Listo: ' + lista.length + ' cartas en cartas.js', cnt);
