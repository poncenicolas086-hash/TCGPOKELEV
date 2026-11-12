import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'copy-static-game-assets',
    closeBundle() {
      const output = resolve('dist');
      mkdirSync(output, { recursive: true });
      cpSync(resolve('cartas.js'), resolve(output, 'cartas.js'));
      cpSync(resolve('assets'), resolve(output, 'assets'), { recursive: true });
    }
  }]
});
