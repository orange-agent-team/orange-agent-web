import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const tls = process.env.ORANGE_USER_TLS_DIR;
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: tls ? 43122 : 43120, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
    ...(tls ? { https: { key: readFileSync(resolve(tls, 'key.pem')), cert: readFileSync(resolve(tls, 'cert.pem')) },
      proxy: { '/api/v1': { target: 'http://127.0.0.1:43103', changeOrigin: false, ws: true },
        '/admin/v1': { target: 'http://127.0.0.1:43103', changeOrigin: false, ws: true } } } : {}),
  },
  preview: { host: '127.0.0.1', port: 43121, strictPort: true },
  build: { sourcemap: false, manifest: true, rolldownOptions: { output: { codeSplitting: { groups: [
    { name: 'react-core', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, includeDependenciesRecursively: false },
    { name: 'schema-engine', test: /node_modules[\\/]ajv[\\/]/, includeDependenciesRecursively: false },
  ] } } } },
});
