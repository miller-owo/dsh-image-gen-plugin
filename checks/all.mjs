import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;

for (const suite of ['host.mjs', 'client.mjs', 'live.mjs', 'pressure.mjs']) {
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
  if (result.status !== 0) failed += 1;
}

process.exitCode = failed === 0 ? 0 : 1;
