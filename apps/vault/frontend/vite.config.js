import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const __dirname = resolve();

function readDfxEnv() {
  const envPath = resolve(__dirname, '../.env');
  if (!existsSync(envPath)) return {};
  const raw = readFileSync(envPath, 'utf-8');
  return Object.fromEntries(
    raw.split('\n')
      .filter(l => l.includes('='))
      .map(l => {
        const [k, ...rest] = l.split('=');
        return [k.trim(), rest.join('=').trim().replace(/^['"](.*)['"]$/, '$1')];
      })
  );
}

// Shared root — librerie JS condivise (core, ui, capabilities)
const sharedRoot = resolve(__dirname, '../../../shared/src');

export default defineConfig(() => {
  const dfxEnv = readDfxEnv();
  const network = process.env.DFX_NETWORK || 'local';
  const canisterId = dfxEnv['CANISTER_ID_VAULT'] || '';

  return {
    root: '.',
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
    resolve: {
      dedupe: [
        '@dfinity/agent',
        '@dfinity/auth-client',
        '@dfinity/candid',
        '@dfinity/principal',
        '@dfinity/identity',
        '@dfinity/vetkeys',
      ],
      alias: {
        '@shared': sharedRoot,
      },
    },
    define: {
      'import.meta.env.CANISTER_ID': JSON.stringify(canisterId),
      'import.meta.env.DFX_NETWORK': JSON.stringify(network),
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4943',
          changeOrigin: true,
        },
      },
    },
  };
});
