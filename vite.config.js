import {defineConfig} from 'vite';
import {viteSingleFile} from 'vite-plugin-singlefile';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

const single = process.env.BUILD_TARGET === 'single';
const version = Date.now().toString(36);

/* stamp the service worker cache version after the bundle is written */
const stampSw = () => ({
  name: 'stamp-sw',
  closeBundle() {
    const p = join(process.env.BUILD_OUT || (single ? 'dist-single' : 'dist'), 'sw.js');
    if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replace('__SW_VERSION__', version));
  },
});

export default defineConfig({
  base: single ? './' : '/endustrie-tracker/',
  build: {
    outDir: single ? 'dist-single' : 'dist',
    target: 'es2022',
  },
  plugins: single ? [viteSingleFile(), stampSw()] : [stampSw()],
  test: {
    environment: 'node',
  },
});
