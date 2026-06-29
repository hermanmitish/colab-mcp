// Live end-to-end test of the TS spike against a REAL Colab tab.
//
//   cd ts && npm run build && node scripts/live-test.mjs
//
// It launches the built server over stdio, calls open_colab_browser_connection
// (which opens a Colab tab in your browser), then — once you're connected —
// drives a full add -> run -> read round-trip through the live notebook.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content?.map((c) => c.text).join('\n') ?? '';
};

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.mjs'] });
const client = new Client({ name: 'live-test', version: '0' });
await client.connect(transport);

console.log('\n1) Opening Colab in your browser — sign in if needed, and click "Allow" on');
console.log('   any Chrome Local Network Access prompt. Waiting up to 60s...\n');
console.log(await call(client, 'open_colab_browser_connection'));

console.log('\n2) Adding a code cell...');
console.log(await call(client, 'add_code_cell', { code: 'print("hello from the TS port")', cellIndex: 0 }));

console.log('\n3) Reading notebook state (get_cells)...');
const cells = await call(client, 'get_cells');
console.log(cells);

// Grab the first cellId from get_cells output if present and run it.
const match = cells.match(/"?(?:cellId|id)"?\s*[:=]\s*"?([\w-]+)"?/i);
if (match) {
  console.log(`\n4) Running cell ${match[1]}...`);
  console.log(await call(client, 'run_code_cell', { cellId: match[1] }));
  console.log('\n5) Re-reading after run...');
  console.log(await call(client, 'get_cells'));
} else {
  console.log('\n(could not auto-detect a cellId from get_cells output — inspect above)');
}

await client.close();
process.exit(0);
