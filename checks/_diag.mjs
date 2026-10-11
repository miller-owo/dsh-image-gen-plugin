import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Read-only diagnostic: parse the profile patch, find this plugin's row, and compare the
// secret that would reach the plugin against the secret in the file. The value itself is
// never printed; only its length and a short hash, so two reads can be compared.
const require = createRequire(import.meta.url);
const YAML = require('yaml');

const patchPath = process.argv[2];
const configPath = process.argv[3];

const text = readFileSync(patchPath, 'utf8');
const doc = YAML.parse(text);
const rows = [...(doc ?? []), ...(doc ?? []).flatMap((entry) => entry?.insert ?? [])];
const row = rows.find((entry) => entry && (entry.id === 'dsh-image-generation' || entry.name === 'dsh-image-gen-plugin'));
if (!row) {
  console.log('no row found');
  process.exit(1);
}
const digest = (value) => {
  const s = String(value ?? '');
  return { length: s.length, hash: s ? createHash('sha256').update(s).digest('hex').slice(0, 12) : null };
};
console.log('row id:      ', row.id);
console.log('row name:    ', row.name);
console.log('apiUrl:      ', row.config?.apiUrl);
console.log('model:       ', row.config?.model);
console.log('config key count:', Object.keys(row.config ?? {}).length);
console.log('secret from patch:', JSON.stringify(digest(row.config?.secret)));

// What the plugin actually reads: the same row, through its own effectiveConfig.
const host = await import(configPath);
const effective = host.effectiveConfig(row.config ?? {});
console.log('secret via effectiveConfig:', JSON.stringify(digest(effective.secret)));
console.log('same value:', digest(row.config?.secret).hash === digest(effective.secret).hash);
console.log('effective apiUrl:', effective.apiUrl);
console.log('effective model: ', effective.model);
