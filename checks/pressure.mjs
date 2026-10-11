import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

const outbound = [];
globalThis.fetch = (...args) => {
  outbound.push(String(args[0]));
  throw new Error('network disabled for the pressure run');
};

function dshRoots() {
  const roots = [];
  const require = createRequire(import.meta.url);
  for (const specifier of ['@deepseek-ai/dsh-tools/package.json', '@deepseek-ai/schemastery/package.json']) {
    try {
      roots.push(join(require.resolve(specifier), '..', '..'));
    } catch {
      // not installed in this checkout
    }
  }
  if (process.env.DSH_PACKAGE_ROOT) roots.push(process.env.DSH_PACKAGE_ROOT);
  const globalRoot = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
  if (existsSync(globalRoot)) roots.push(globalRoot);
  return [...new Set(roots)];
}

const packageRoots = dshRoots();
const targets = { schemastery: 'lib/index.mjs', 'dsh-tools': 'lib/index.js' };
register(
  `data:text/javascript;base64,${Buffer.from(`
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const roots = ${JSON.stringify(packageRoots)};
    const targets = ${JSON.stringify(targets)};
    export async function resolve(specifier, context, next) {
      const name = specifier.startsWith('@deepseek-ai/') ? specifier.slice('@deepseek-ai/'.length) : '';
      if (targets[name]) {
        for (const root of roots) {
          const candidate = join(root, name, targets[name]);
          if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    }
  `).toString('base64')}`,
);

const host = await import('../index.js');

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(`ok   ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`);
  }
};

let registered;
host.apply(
  {
    effect: (fn) => fn(),
    inject: (names, fn) => {
      if (names.includes('webServer')) fn({ webServer: { register: () => () => {} } });
    },
    tools: { register: (definition) => ((registered = definition), () => {}) },
  },
  host.Config({ secret: 'sk-test', outputDir: join(process.cwd(), 'tmp-pressure') }),
);

const config = host.effectiveConfig(host.Config({ secret: 'sk-test', apiUrl: 'https://example.invalid/v1' }));
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64',
);

const expectNoCrash = (label, fn, sink) => {
  try {
    fn();
  } catch (error) {
    const message = String(error?.message ?? error);

    if (/Unexpected|TypeError|ReferenceError|Cannot read|is not a function|is not iterable/.test(message)) {
      sink.push(`${label}: ${message.slice(0, 90)}`);
    }
  }
};

await check('no malformed size string can crash the size rules', () => {
  const crashes = [];
  const inputs = [];
  for (const a of ['', '0', '1', '15', '16', '17', '3840', '3841', '999999999999', '-16', '1e9', 'NaN', 'Infinity']) {
    for (const b of ['', '0', '1', '15', '16', '17', '2160', '3840', '999999999999', '-16']) inputs.push(`${a}x${b}`);
  }
  const alphabet = ['0', '1', '9', 'x', 'X', '*', '-', '+', ' ', '.', ',', 'e', 'E', '中', '\u0000', '\n'];
  for (let index = 0; index < 400; index += 1) {
    let value = '';
    const length = 1 + (index % 12);
    for (let offset = 0; offset < length; offset += 1) value += alphabet[(index * 7 + offset * 13) % alphabet.length];
    inputs.push(value);
  }
  for (const value of inputs) {
    const label = JSON.stringify(value.slice(0, 24));
    expectNoCrash(`inspectSize(${label})`, () => host.inspectSize(value, { maxEdge: 3840 }), crashes);
    expectNoCrash(`parseSize(${label})`, () => host.parseSize(value, { maxEdge: 3840 }), crashes);
  }
  if (crashes.length > 0) throw new Error(`${crashes.length} crashes, first: ${crashes[0]}`);
});

await check('no malformed base64 payload can crash the decoder', () => {
  const crashes = [];
  const inputs = ['', '=', '==', '===', 'A', 'AB', 'ABC', '!!!!', 'AAAA', 'aaaa', '////', '++++', '\u0000', '中文', 'A==='];
  for (let index = 0; index < 300; index += 1) inputs.push('A'.repeat(index % 40) + (index % 3 === 0 ? '=' : ''));
  for (const value of inputs) {
    expectNoCrash(`decodeImage(${JSON.stringify(value.slice(0, 20))})`, () => host.decodeImage(value, 'X'), crashes);
  }
  for (const odd of [undefined, null, 12345, {}, [], true]) {
    expectNoCrash(`decodeImage(${String(odd)})`, () => host.decodeImage(odd, 'X'), crashes);
  }
  if (crashes.length > 0) throw new Error(`${crashes.length} crashes, first: ${crashes[0]}`);
});

await check('no malformed name pattern or prompt can crash the namer', () => {
  const crashes = [];
  const patterns = ['', '   ', '{}', '{time}', '{prompt}', '{index}', '{uniq}', '{time}{prompt}{index}{uniq}',
    '{'.repeat(200), '}'.repeat(200), '{prompt}'.repeat(100), '\u0000', '../'.repeat(50), 'CON', 'NUL', 'a'.repeat(5000)];
  const prompts = ['', ' ', '中文提示词', '\u0000\u0001', 'x'.repeat(100000), '../'.repeat(100), '"quoted"', 'a\nb\tc'];
  for (const pattern of patterns) {
    for (const prompt of prompts) {
      expectNoCrash(`applyNamePattern(${JSON.stringify(pattern.slice(0, 12))})`, () => host.applyNamePattern(pattern, { prompt, index: 1 }), crashes);
      expectNoCrash(`safeFileName(${JSON.stringify(pattern.slice(0, 12))})`, () => host.safeFileName(pattern), crashes);
    }
  }
  if (crashes.length > 0) throw new Error(`${crashes.length} crashes, first: ${crashes[0]}`);
});

await check('no malformed source list or field map can crash the multipart encoder', () => {
  const crashes = [];
  for (const value of [undefined, null, '', 0, false, [], {}, [null], [undefined], [0], [{}], ['', ''], 'a\n\n\nb', [['nested']], 'a;b;c;d', '\u0000']) {
    expectNoCrash(`normalizeSourcePaths(${JSON.stringify(value ?? null).slice(0, 24)})`, () => host.normalizeSourcePaths(value), crashes);
  }
  const fieldSets = [{}, { a: '' }, { a: null }, { a: undefined }, { a: 0 }, { a: false }, { a: {} }, { a: [] },
    { 'bad name': 'v' }, { 'bad\nname': 'v' }, { '': 'v' }, { a: 'x'.repeat(100000) }];
  for (const fields of fieldSets) {
    const label = JSON.stringify(Object.keys(fields)).slice(0, 30);
    expectNoCrash(`encodeMultipart(${label})`, () => host.encodeMultipart(fields, [], null), crashes);
    expectNoCrash(`encodeMultipart(${label}, source)`, () => host.encodeMultipart(fields, [{ bytes: PNG, name: 'x.png', mime: 'image/png' }], null), crashes);
  }

  for (const sources of [null, undefined, [], [null], [7], ['x'], [{}], [{ name: 'x.png' }], [{ name: 'x.png', mime: 'image/png' }]]) {
    expectNoCrash(`encodeMultipart(sources=${JSON.stringify(sources)?.slice(0, 30)})`, () => host.encodeMultipart({ a: 'b' }, sources, null), crashes);
  }
  expectNoCrash('encodeMultipart(mask=junk)', () => host.encodeMultipart({ a: 'b' }, [{ bytes: PNG, name: 'x.png', mime: 'image/png' }], { name: null }), crashes);
  if (crashes.length > 0) throw new Error(`${crashes.length} crashes, first: ${crashes[0]}`);
});

await check('no malformed call argument can crash the generate entry point', async () => {
  const crashes = [];
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: process.cwd() } } } };
  const paramSets = [
    {}, { prompt: null }, { prompt: 0 }, { prompt: 123 }, { prompt: {} }, { prompt: [] },
    { prompt: 'x', count: 0 }, { prompt: 'x', count: -1 }, { prompt: 'x', count: 999 }, { prompt: 'x', count: 1.5 },
    { prompt: 'x', count: 'two' }, { prompt: 'x', count: NaN }, { prompt: 'x', quality: 'ultra' },
    { prompt: 'x', quality: 42 }, { prompt: 'x', background: 'rainbow' }, { prompt: 'x', resolution: 'nonsense' },
    { prompt: 'x', location: '\u0000' }, { prompt: 'x', location: 123 }, { prompt: 'x', mode: 'edit' },
    { prompt: 'x', mode: 'generate', images: 'a.png' }, { prompt: 'x', images: [null, 0, {}] },
    { prompt: 'x', mask: 'nope.png' }, { prompt: 'x'.repeat(40000) },
  ];
  for (const params of paramSets) {
    try {
      await registered.execute(params, exec);
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/TypeError|ReferenceError|Cannot read|is not a function|is not iterable|Unexpected/.test(message)) {
        crashes.push(`generate(${JSON.stringify(params).slice(0, 40)}): ${message.slice(0, 90)}`);
      }
    }
  }
  if (crashes.length > 0) throw new Error(`${crashes.length} crashes, first: ${crashes[0]}`);
});

await check('the pressure run reached no network at all', () => {

  if (outbound.length === 0) throw new Error('the stub was never consulted, so this suite proves nothing');
  for (const url of outbound) {
    if (!/^https?:/.test(url)) throw new Error(`an unexpected outbound target was attempted: ${url}`);
  }
});

const failures = results.filter((line) => line.startsWith('FAIL'));
console.log(['pressure suite', ...results].join('\n'));
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
