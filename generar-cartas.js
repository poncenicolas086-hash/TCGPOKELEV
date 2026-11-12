
// Uso: node generar-cartas.js
// Genera cartas.js leyendo la carpeta "cartas".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dir = path.join(__dirname, 'cartas');
const IMG = /\.(png|jpe?g|webp)$/i;
const VALID = ['C', 'UC', 'R', 'SR', 'UR'];

const SUPABASE_STORAGE_URL =
  'https://irqccifpkkpgpbaepgbo.supabase.co/storage/v1/object/public/cartas/';

if (!fs.existsSync(dir)) {
  console.error('No encuentro la carpeta "cartas".');
  process.exit(1);
}

// Normaliza las rutas para que PNG, JPG y WEBP
// puedan coincidir aunque tengan extensiones diferentes.
function normalizarRuta(ruta) {
  return ruta
    .replace(/\\/g, '/')
    .replace(IMG, '')
    .toLowerCase();
}

// Cargar rarezas manuales.
const ovF = path.join(__dirname, 'rarezas.json');
let ov = {};

if (fs.existsSync(ovF)) {
  try {
    const txt = fs.readFileSync(ovF, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/,\s*([}\]])/g, '$1');

    const original = JSON.parse(txt);

    for (const [ruta, rareza] of Object.entries(original)) {
      ov[normalizarRuta(ruta)] = rareza;
    }
  } catch (e) {
    console.error('ERROR en rareza.json:', e.message);
    process.exit(1);
  }
}

const TOP = /charizard|mewtwo|rayquaza|lugia|umbreon|gengar|dragonite|arceus|lucario|greninja|pikachu|mew\b/i;

const hash = s => {
  let h = 0;
  for (const ch of s) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return h % 100;
};

function rareza(exp, file, name) {
  const claveCompleta = normalizarRuta(exp + '/' + file);
  const claveArchivo = normalizarRuta(file);

  const manual = ov[claveCompleta] || ov[claveArchivo];

  if (VALID.includes(manual)) return manual;

  if (/vmax|vstar|\bgx\b|-gx|rainbow|secret|gold|full.?art/i.test(name)) {
    return 'UR';
  }

  if (/(^|[\s_-])(ex|v)([\s_-]|$)/i.test(name) || TOP.test(name)) {
    return 'SR';
  }

  const h = hash(exp + file);
  return h < 55 ? 'C' : h < 85 ? 'UC' : 'R';
}

const lista = [];

function add(exp, file) {
  const name = file.replace(IMG, '').replace(/[_-]+/g, ' ').trim();

  const rutaImagen = exp === 'General'
    ? encodeURIComponent(file)
    : encodeURIComponent(exp) + '/' + encodeURIComponent(file);

  lista.push({
    id: lista.length,
    n: name,
    e: exp,
    r: rareza(exp, file, name),
    f: SUPABASE_STORAGE_URL + rutaImagen
  });
}

// Leer expansiones y cartas.
const carpetas = fs.readdirSync(dir, { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name));

for (const elemento of carpetas) {
  if (elemento.isDirectory()) {
    const carpeta = path.join(dir, elemento.name);

    const archivos = fs.readdirSync(carpeta)
      .filter(file => IMG.test(file))
      .sort();

    for (const file of archivos) {
      add(elemento.name, file);
    }
  } else if (IMG.test(elemento.name)) {
    add('General', elemento.name);
  }
}

// Generar catálogo.
const destino = path.join(__dirname, 'cartas.js');

fs.writeFileSync(
  destino,
  'window.CARTAS=' + JSON.stringify(lista) + ';\n',
  'utf8'
);

// Resumen.
const cnt = {};

lista.forEach(c => {
  cnt[c.r] = (cnt[c.r] || 0) + 1;
});

console.log('Cartas generadas:', lista.length);
console.log('Rarezas:', cnt);
console.log('Catálogo generado correctamente:', destino);
