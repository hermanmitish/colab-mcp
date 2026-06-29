// Bundles the server to a single ESM file for the .mcpb (runs on Claude
// Desktop's bundled Node). The banner shims CommonJS globals that some
// transitive deps (e.g. `open`, pulled in by @google-cloud/local-auth) expect
// at module scope but which don't exist in ESM.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/index.mjs',
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'module';",
      "import { fileURLToPath as __fileURLToPath } from 'url';",
      "import { dirname as __pathDirname } from 'path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
});

console.error('built dist/index.mjs');
