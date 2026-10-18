import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64',
);

function dshRoots() {
  const roots = [];
  const require = createRequire(import.meta.url);
  for (const specifier of ['@deepseek-ai/dsh-tools/package.json', '@deepseek-ai/schemastery/package.json']) {
    try {
      roots.push(join(require.resolve(specifier), '..', '..'));
    } catch {

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
        throw new Error('Could not resolve ' + specifier + '; set DSH_PACKAGE_ROOT to a DSH @deepseek-ai directory.');
      }
      return next(specifier, context);
    }
  `).toString('base64')}`,
);

const host = await import('../index.js');

globalThis.fetch = async (url) => {
  throw new Error(`unexpected network call to ${url}`);
};

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(`ok   ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`);
  }
};

const config = {
  apiUrl: 'https://api.openai.com/v1',
  secret: 'sk-test',
  model: 'gpt-image-2.5-flare',
  count: 1,
  outputFormat: 'png',
  outputCompression: 100,
  moderation: 'auto',
  background: 'auto',
  user: '',
  outputDir: '',
  defaultResolution: 'auto',
  requestTimeoutSec: 600,
  maxEdge: 3840,
  sendsModeration: true,
  sendsOutputCompression: true,
};

await check('the config schema resolves every documented default', () => {
  const resolved = host.Config({});
  if (resolved.model.get() !== 'gpt-image-2.5-flare') throw new Error(resolved.model.get());
  if (resolved.outputCompression.get() !== 100) throw new Error('outputCompression');
  if (resolved.count.get() !== 1) throw new Error('count');
  if (resolved.defaultResolution.get() !== 'auto') throw new Error('defaultResolution');
  if (resolved.maxEdge.get() !== 3840) throw new Error('maxEdge');
});

await check('a volatile field reaches the handler as a readable value', () => {
  const resolved = host.effectiveConfig(host.Config({ count: 3, outputDir: 'D:/shots', secret: 'k' }));
  if (resolved.count !== 3) throw new Error(String(resolved.count));
  if (resolved.outputDir !== 'D:/shots') throw new Error(resolved.outputDir);
  if (resolved.secret !== 'k') throw new Error(resolved.secret);
  if (resolved.model !== 'gpt-image-2.5-flare') throw new Error(resolved.model);
});

await check('the endpoint rules accept the sizes Dasipaint accepts', () => {
  for (const size of ['1024x1024', '1536x1024', '2048x1152', '3840x2160', '1152x2048']) {
    if (host.parseSize(size, config) !== size) throw new Error(`rejected ${size}`);
  }
});

await check('the endpoint rules refuse what Dasipaint refuses', () => {
  const reasons = {};
  for (const size of ['1024x1023', '1000x1000', '5008x1008', '64x64', '4096x4096', '2048x600', '5008x2048', '3840x2240']) {
    const verdict = host.inspectSize(size, config);
    if (verdict.ok) throw new Error(`accepted ${size}`);
    reasons[size] = verdict.reason;
  }
  if (reasons['1024x1023'] !== 'step') throw new Error(`step: ${reasons['1024x1023']}`);
  if (reasons['1000x1000'] !== 'step') throw new Error(`step: ${reasons['1000x1000']}`);
  if (reasons['2048x600'] !== 'step') throw new Error(`step: ${reasons['2048x600']}`);
  if (reasons['5008x1008'] !== 'ratio') throw new Error(`ratio: ${reasons['5008x1008']}`);
  if (reasons['5008x2048'] !== 'cap') throw new Error(`cap: ${reasons['5008x2048']}`);
  if (reasons['64x64'] !== 'floor') throw new Error(`floor: ${reasons['64x64']}`);
  if (reasons['4096x4096'] !== 'cap') throw new Error(`cap: ${reasons['4096x4096']}`);
  if (reasons['3840x2240'] !== 'ceiling') throw new Error(`ceiling: ${reasons['3840x2240']}`);
});

await check('the verdict table the client mirrors still holds here', () => {

  const table = [
    ['1536x864', null],
    ['1024x768', null],
    ['3840x2160', null],
    ['2880x2880', null],
    ['2048x2048', null],
    ['1536x865', 'step'],
    ['2048x600', 'step'],
    ['1000x1000', 'step'],
    ['5008x1008', 'ratio'],
    ['5008x2048', 'cap'],
    ['640x832', 'floor'],
    ['3840x3840', 'ceiling'],
    ['4096x4096', 'cap'],
    ['64x64', 'floor'],
    ['nonsense', 'format'],
    ['1536', 'format'],
  ];
  for (const [size, expected] of table) {
    const verdict = host.inspectSize(size, config);
    const actual = verdict.ok ? null : verdict.reason;
    if (actual !== expected) throw new Error(`${size}: host says ${actual}, table says ${expected}`);
  }
});

await check('the pixel ceiling is what rules out a 3840 square', () => {
  if (host.inspectSize('3840x3840', config).ok) throw new Error('a 14.7 megapixel square was accepted');
  if (host.inspectSize('2880x2880', config).ok !== true) throw new Error('the largest legal square was refused');
});

await check('lowering the cap narrows what is accepted', () => {
  if (host.parseSize('1024x1024', { ...config, maxEdge: 1024 }) !== '1024x1024') throw new Error('the cap itself was refused');
  if (host.inspectSize('2048x2048', { ...config, maxEdge: 1024 }).reason !== 'cap') throw new Error('the cap was ignored');
});

await check('inspectSize never throws on junk', () => {
  for (const value of ['', 'nope', '1536', '1536x', 'x864', '0x0', '-16x1024', '1536x864x2']) {
    if (host.inspectSize(value, config).ok) throw new Error(`accepted ${JSON.stringify(value)}`);
  }
});

await check('the ready-made sizes are all legal under the live rules', () => {
  const presets = host.presetSizes(config);
  if (presets.length < 8) throw new Error(`only ${presets.length} presets`);
  for (const size of presets) {
    if (!host.inspectSize(size, config).ok) throw new Error(`${size} is offered but illegal`);
  }
  if (!presets.includes('3840x2160')) throw new Error('the 4K 16:9 preset is missing');
  if (!presets.includes('2048x2048')) throw new Error('the 2K square preset is missing');
  if (presets.some((size) => size.startsWith('3840x3840'))) throw new Error('an over-ceiling square was offered');
});

await check('quality left the config and lives on the call', () => {
  const resolved = host.Config({});
  if (resolved.quality !== undefined) throw new Error('quality is still a config field');
  if (Object.keys(host.effectiveConfig(host.Config({}))).includes('quality')) throw new Error('effectiveConfig still carries quality');
});

await check('the credential field is not named after what it holds', () => {
  const keys = Object.keys(host.effectiveConfig(host.Config({})));
  for (const giveaway of ['apiKey', 'api_key', 'token', 'credential']) {
    if (keys.includes(giveaway)) throw new Error(`a self-describing credential field name is back: ${giveaway}`);
  }
  if (!keys.includes('secret')) throw new Error('the credential field is missing');
  if (host.Config({ secret: 'sk-test' }).secret.get() !== 'sk-test') throw new Error('the field does not carry the value');
});

await check('2.5 omits moderation unless a level is asked for', () => {
  if ('moderation' in host.buildBody(config, 'a corgi', '1024x1024', 1, 'auto', 'high')) throw new Error('moderation reached 2.5');
  const asked = host.buildBody({ ...config, moderation: 'low' }, 'a corgi', '1024x1024', 1, 'auto', 'high');
  if (asked.moderation !== 'low') throw new Error('an explicit level was dropped');
});

await check('quality reaches the request body verbatim', () => {
  const body = host.buildBody(config, 'x', '1024x1024', 1, 'auto', 'xhigh');
  if (body.quality !== 'xhigh') throw new Error(body.quality);
});

await check('an opted-out field never reaches the request', () => {
  const off = host.buildBody(
    { ...config, moderation: 'low', sendsModeration: false, sendsOutputCompression: false, outputFormat: 'jpeg' },
    'x',
    '1024x1024',
    1,
    'auto',
  );
  if ('moderation' in off) throw new Error('moderation was sent after opting out');
  if ('output_compression' in off) throw new Error('output_compression was sent after opting out');
  if (off.output_format !== 'jpeg') throw new Error('the opted-out field took its neighbours with it');
});

await check('output_compression rides only jpeg and webp', () => {
  if ('output_compression' in host.buildBody({ ...config, outputFormat: 'png' }, 'x', '1024x1024', 1, 'auto')) {
    throw new Error('png carried output_compression');
  }
  const jpeg = host.buildBody({ ...config, outputFormat: 'jpeg', outputCompression: 999 }, 'x', '1024x1024', 1, 'auto');
  if (jpeg.output_compression !== 100) throw new Error(String(jpeg.output_compression));
});

await check('a transparent background is refused for jpeg output', () => {
  try {
    host.normalizeBackground('transparent', { ...config, outputFormat: 'jpeg' });
    throw new Error('accepted');
  } catch (error) {
    if (!error.message.includes('transparent')) throw error;
  }
  if (host.normalizeBackground('Transparent', { ...config, outputFormat: 'png' }) !== 'transparent') {
    throw new Error('case-insensitive value failed');
  }
  if (host.normalizeBackground(undefined, { ...config, background: 'opaque' }) !== 'opaque') throw new Error('default ignored');
});

await check('a filename never lands on a reserved device name', () => {

  for (const reserved of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9']) {
    const rendered = host.applyNamePattern(reserved, { prompt: 'x', index: 1 });
    if (rendered !== `${reserved}-image`) throw new Error(`${reserved} rendered as ${rendered}`);
  }

  if (host.applyNamePattern('console', { prompt: 'x', index: 1 }) !== 'console') throw new Error('a safe name was rewritten');
});

await check('a filename stays inside the path budget', () => {
  if (host.applyNamePattern('{prompt}'.repeat(60), { prompt: 'abc', index: 1 }).length > 120) {
    throw new Error('a repeated token was not capped');
  }
  if (host.applyNamePattern('{prompt}', { prompt: 'word '.repeat(200), index: 1 }).length > 120) {
    throw new Error('a long prompt was not capped');
  }
  if (host.applyNamePattern('x'.repeat(500), { prompt: 'x', index: 1 }).length > 120) {
    throw new Error('a literal pattern was not capped');
  }
});

await check('a name that renders empty is still usable', () => {
  for (const pattern of ['   ', '...', '---']) {
    const rendered = host.applyNamePattern(pattern, { prompt: '', index: 1 });
    if (!rendered) throw new Error(`${JSON.stringify(pattern)} produced an empty name`);
    if (/[\\/:*?"<>|]/.test(rendered)) throw new Error(`${rendered} carries a path separator`);
  }
});

await check('every character Windows forbids is stripped from a name', () => {
  const rendered = host.applyNamePattern('{prompt}', { prompt: 'a/b\\c:d*e?f"g<h>i|j', index: 1 });
  if (/[\\/:*?"<>|]/.test(rendered)) throw new Error(rendered);
  if (rendered !== 'a-b-c-d-e-f-g-h-i-j') throw new Error(rendered);
});

await check('a source image path list is normalised however the caller sent it', () => {
  const a = host.normalizeSourcePaths('one.png');
  if (a.join(',') !== 'one.png') throw new Error(a.join(','));
  if (host.normalizeSourcePaths(['a.png', 'b.png']).join(',') !== 'a.png,b.png') throw new Error('array form broke');

  if (host.normalizeSourcePaths('a.png\nb.png').join(',') !== 'a.png,b.png') throw new Error('newline form broke');
  if (host.normalizeSourcePaths('a.png; b.png').join(',') !== 'a.png,b.png') throw new Error('semicolon form broke');

  if (host.normalizeSourcePaths(['a.png', 'a.png']).join(',') !== 'a.png') throw new Error('duplicates survived');
  for (const empty of [undefined, null, '', [], ['  '], '  \n ']) {
    if (host.normalizeSourcePaths(empty).length !== 0) throw new Error(`empty input ${JSON.stringify(empty)} produced paths`);
  }
});

await check('the multipart body is well formed for one source image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-multipart-'));
  const sourcePath = join(dir, 'cat.png');
  await writeFile(sourcePath, PNG);
  const sources = await host.readSourceImages([sourcePath]);
  if (sources.length !== 1) throw new Error('the source was not read');
  if (sources[0].mime !== 'image/png') throw new Error(sources[0].mime);
  if (sources[0].name !== 'cat.png') throw new Error(sources[0].name);

  const { fields } = host.buildEditForm(config, 'make it ginger', '1024x1024', 1, 'auto', 'high', sources);
  const { body, contentType } = host.encodeMultipart(fields, sources, null);
  const text = body.toString('latin1');
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error(contentType);

  if (!text.startsWith(`--${boundary}\r\n`)) throw new Error('the body does not open with the boundary');
  if (!text.endsWith(`--${boundary}--\r\n`)) throw new Error('the body does not close with the delimiter');
  for (const name of ['model', 'prompt', 'n', 'size', 'quality', 'output_format', 'background']) {
    if (!text.includes(`Content-Disposition: form-data; name="${name}"\r\n`)) throw new Error(`the ${name} part is missing`);
  }
  if (!text.includes('Content-Disposition: form-data; name="image"; filename="cat.png"\r\n')) {
    throw new Error('the image part is not named');
  }
  if (!text.includes('Content-Type: image/png')) throw new Error('the image part has no content type');
  if (!text.includes('make it ginger')) throw new Error('the prompt did not travel');

  if (!/name="n"\r\n\r\n1\r\n/.test(text)) throw new Error('n did not travel as text');

  if (!body.includes(PNG)) throw new Error('the source bytes were altered');
  if (text.includes('name="mask"')) throw new Error('a mask part appeared without a mask');
  await rm(dir, { recursive: true, force: true });
});

await check('a mask rides as exactly one png part', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mask-'));
  const sourcePath = join(dir, 'cat.png');
  const maskPath = join(dir, 'mask.png');
  await writeFile(sourcePath, PNG);
  await writeFile(maskPath, PNG);
  const sources = await host.readSourceImages([sourcePath]);
  const mask = (await host.readSourceImages([maskPath]))[0];
  if (mask.mime !== 'image/png') throw new Error(mask.mime);
  const { fields } = host.buildEditForm(config, 'change the collar', '1024x1024', 1, 'auto', 'high', sources);
  const { body } = host.encodeMultipart(fields, sources, mask);
  const text = body.toString('latin1');
  if (!text.includes('name="mask"; filename="mask.png"')) throw new Error('the mask part is missing');
  const maskParts = text.match(/name="mask"/g) ?? [];
  if (maskParts.length !== 1) throw new Error(`${maskParts.length} mask parts were written`);
  await rm(dir, { recursive: true, force: true });
});

await check('a source image that cannot be used is refused by name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-src-'));
  const cases = [
    [join(dir, 'missing.png'), 'not found'],
    [dir, 'not a file'],
    [join(dir, 'empty.png'), 'empty'],
  ];
  await writeFile(join(dir, 'empty.png'), Buffer.alloc(0));
  for (const [path, fragment] of cases) {
    try {
      await host.readSourceImages([path]);
      throw new Error(`accepted ${path}`);
    } catch (error) {
      if (!error.message.toLowerCase().includes(fragment)) throw error;
    }
  }

  try {
    await host.readSourceImages(Array.from({ length: 17 }, (_, index) => join(dir, `${index}.png`)));
    throw new Error('17 sources were accepted');
  } catch (error) {
    if (!error.message.includes('16')) throw error;
  }
  await rm(dir, { recursive: true, force: true });
});

await check('a profile that is not an image still travels typed, not as a mystery blob', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mime-'));
  const path = join(dir, 'photo.jpeg');

  await writeFile(path, PNG);
  const [source] = await host.readSourceImages([path]);
  if (source.mime !== 'image/png') throw new Error(`sniffed ${source.mime}`);
  if (source.name !== 'photo.jpeg') throw new Error(`renamed to ${source.name}`);
  await rm(dir, { recursive: true, force: true });
});

await check('a filename cannot forge a multipart header', async () => {

  const cases = [
    ['plain.png', 'plain.png'],
    ['a"b.png', 'a_b.png'],
    ['a\r\nb.png', 'a__b.png'],
    ['a\nb.png', 'a_b.png'],
    ['../evil.png', 'evil.png'],
    ['..\\..\\evil.png', 'evil.png'],
    ['\u0000null.png', '_null.png'],
    ['  spaced.png  ', 'spaced.png'],
    ['', 'image.png'],
  ];
  for (const [input, expected] of cases) {
    const sanitized = host.safeFileName(input);
    if (sanitized !== expected) throw new Error(`${JSON.stringify(input)} -> ${JSON.stringify(sanitized)}`);

    if (/[\r\n"\\]/.test(sanitized)) throw new Error(`${JSON.stringify(sanitized)} still carries a header-breaking byte`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'dsh-inject-'));
  const sourcePath = join(dir, 'innocent.png');
  await writeFile(sourcePath, PNG);
  const [source] = await host.readSourceImages([sourcePath]);
  source.name = host.safeFileName('evil"\r\nContent-Disposition: form-data; name="forged"\r\n\r\nx.png');
  const { body, contentType } = host.encodeMultipart({ prompt: 'x' }, [source], null);
  const text = body.toString('latin1');
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const headers = (text.match(/\r\nContent-Disposition:/g) ?? []).length;
  if (headers !== 2) throw new Error(`${headers} parts were framed, expected 2`);
  if (text.includes('name="forged"')) throw new Error('a part was injected through the filename');
  if (/[\r\n"\\]/.test(source.name)) throw new Error('the sanitized name still carries a header byte');
  if (!text.endsWith(`--${boundary}--\r\n`)) throw new Error('the closing delimiter was displaced');

  const delimiters = (text.match(new RegExp(`--${boundary}`, 'g')) ?? []).length;
  if (delimiters !== 3) throw new Error(`${delimiters} boundary lines, expected 3`);
  await rm(dir, { recursive: true, force: true });
});

await check('a field name that could forge a header is refused', async () => {

  let message = '';
  try {
    host.encodeMultipart({ 'evil"\r\nContent-Disposition: form-data; name="x"': 'v' }, [], null);
  } catch (error) {
    message = error.message;
  }
  if (!/forge a header/i.test(message)) throw new Error(`a hostile field name was encoded: ${message}`);

  const { body } = host.encodeMultipart({ model: 'm', prompt: 'p', output_format: 'png' }, [], null);
  if (!body.toString('latin1').includes('name="output_format"')) throw new Error('a valid field name was refused');
});

await check('source bytes that are not an image are refused, not typed by extension', async () => {

  const dir = await mkdtemp(join(tmpdir(), 'dsh-bytes-'));
  const path = join(dir, 'fake.png');
  await writeFile(path, Buffer.from('this is plain text, definitely not a png'));
  let message = '';
  try {
    await host.readSourceImages([path]);
  } catch (error) {
    message = error.message;
  }
  if (!/not a PNG, JPEG, WebP, or GIF/.test(message)) throw new Error(message);
  if (!message.includes('fake.png')) throw new Error('the refusing message does not name the file');
  await rm(dir, { recursive: true, force: true });
});

await check('a source image reached through a symlink is followed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-link-'));
  await writeFile(join(dir, 'real.png'), PNG);
  const link = join(dir, 'link.png');
  let created = false;
  try {
    await symlink(join(dir, 'real.png'), link);
    created = true;
  } catch {

  }
  if (created) {
    const [source] = await host.readSourceImages([link]);
    if (source.bytes.byteLength !== PNG.byteLength) throw new Error('the symlinked image was not read');

    if (source.name !== 'link.png') throw new Error(source.name);

    let refused = '';
    try {
      await host.readSourceImages([join(dir, 'dirlink')]);
    } catch (error) {
      refused = error.message;
    }
    if (!refused) throw new Error('a directory was accepted');
  }
  await rm(dir, { recursive: true, force: true });
});

await check('a frame written before the index existed is recovered, and nothing else is', async () => {

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-backfill-'));
  const nested = join(workspace, 'shots', 'deep');
  await mkdir(nested, { recursive: true });
  const recovered = join(nested, '2026-10-07T14-35-58-692-a-dog.png');
  await writeFile(recovered, PNG);

  await writeFile(join(workspace, 'cat.png'), PNG);
  await writeFile(join(workspace, '2026-10-07T14-35-58-692-notes.txt'), 'not an image');
  await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(workspace, 'node_modules', 'pkg', '2026-10-07T14-35-58-692-hidden.png'), PNG);

  const indexPath = host.indexPathForTests();
  const before = await readFile(indexPath, 'utf8').catch(() => null);
  try {
    await rm(indexPath, { force: true });
    const added = await host.backfillIndexFrom(workspace);
    if (added !== 1) throw new Error(`the backfill added ${added} entries, expected 1`);
    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    const names = Object.keys(index);
    if (names.length !== 1) throw new Error(`the index holds ${names.length} entries: ${names.join(', ')}`);
    if (names[0] !== '2026-10-07T14-35-58-692-a-dog.png') throw new Error(names[0]);
    if (index[names[0]] !== recovered) throw new Error(index[names[0]]);

    if ((await host.backfillIndexFrom(workspace)) !== 0) throw new Error('a second backfill was not idempotent');
  } finally {
    if (before === null) await rm(indexPath, { force: true });
    else await writeFile(indexPath, before);
    await rm(workspace, { recursive: true, force: true });
  }
});

await check('the workspace scan reaches a frame in a large tree, within a bounded time', async () => {

  const root = await mkdtemp(join(tmpdir(), 'dsh-bigtree-'));
  for (let d = 0; d < 30; d += 1) {
    const dir = join(root, `pkg-${String(d).padStart(2, '0')}`, 'src');
    await mkdir(dir, { recursive: true });
    for (let f = 0; f < 100; f += 1) await writeFile(join(dir, `file-${f}.png`), 'x');
  }

  const name = '2026-10-07T14-35-58-692-buried.png';
  await mkdir(join(root, 'zz-frames'), { recursive: true });
  await writeFile(join(root, 'zz-frames', name), PNG);

  const config = host.effectiveConfig(host.Config({ secret: 'sk', outputDir: root }));
  const indexPath = host.indexPathForTests();
  const before = await readFile(indexPath, 'utf8').catch(() => null);
  try {
    await rm(indexPath, { force: true });
    host.forgetInMemoryFilesForTests();
    host.rememberWorkspaceForTests(root);

    let status = 0;
    let served = 0;
    const res = {
      writeHead(code) {
        status = code;
        return this;
      },
      end(chunk) {
        if (Buffer.isBuffer(chunk)) served = chunk.length;
        return this;
      },
    };
    const started = Date.now();
    await host.serveImageForTests({ url: `/dsh-image-generation/file/${encodeURIComponent(name)}` }, res, config);
    const elapsed = Date.now() - started;
    if (status !== 200) throw new Error(`the buried frame answered ${status} after ${elapsed}ms`);
    if (served !== PNG.byteLength) throw new Error(`served ${served} bytes`);

    if (elapsed > 2000) throw new Error(`the scan took ${elapsed}ms`);
  } finally {
    if (before === null) await rm(indexPath, { force: true });
    else await writeFile(indexPath, before);
    await rm(root, { recursive: true, force: true });
  }
});

let registered;
const registeredRoutes = [];
const routeFor = (kind, path) => registeredRoutes.find((entry) => entry.kind === kind && entry.path === path);
let registeredRoute;
const fakeCtx = {
  effect: (fn) => fn(),
  inject: (names, fn) => {
    if (names.includes('webServer')) fn({ webServer: { register: (route) => { registeredRoutes.push(route); registeredRoute = route; return () => {}; } } });
  },
  tools: { register: (definition) => ((registered = definition), () => {}) },
};
await check('the records route clears the index, and only for a real confirmation', async () => {

  host.apply(fakeCtx, host.Config({ secret: 'sk-test' }));
  const records = routeFor('exact', '/dsh-image-generation/records');
  if (!records) throw new Error('the records route is not registered');

  const call = async (method, headers) => {
    let status = 0;
    let body = '';
    const res = {
      writeHead(code) {
        status = code;
        return this;
      },
      end(chunk) {
        body = String(chunk ?? '');
        return this;
      },
    };
    await records.handler({ method, headers }, res);
    return { status, body };
  };

  const wrongMethod = await call('GET', { 'x-dsh-image-generation-action': 'clear-records' });
  if (wrongMethod.status !== 405) throw new Error(`GET answered ${wrongMethod.status}`);
  const noHeader = await call('POST', {});
  if (noHeader.status !== 400) throw new Error(`a POST without the header answered ${noHeader.status}`);
  const wrongHeader = await call('POST', { 'x-dsh-image-generation-action': 'nope' });
  if (wrongHeader.status !== 400) throw new Error(`a wrong action header answered ${wrongHeader.status}`);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-records-'));
  const written = join(dir, '2026-10-07T14-35-58-692-kept.png');
  await writeFile(written, PNG);
  host.rememberFileForTests(written);
  if (!existsSync(host.indexPathForTests())) throw new Error('the seeded record was not persisted');

  const cleared = await call('POST', { 'x-dsh-image-generation-action': 'clear-records' });
  if (cleared.status !== 200) throw new Error(`the clear answered ${cleared.status}`);
  const payload = JSON.parse(cleared.body);
  if (!(payload.cleared >= 1)) throw new Error(`cleared ${payload.cleared} records`);
  if (existsSync(host.indexPathForTests())) throw new Error('the index file survived the clear');

  if (!existsSync(written)) throw new Error('the image file was deleted');
  await rm(dir, { recursive: true, force: true });
});

await check('generate_image registers the eight requested parameters', () => {
  host.apply(fakeCtx, host.Config({ secret: 'sk-test' }));
  if (registered.name !== 'generate_image') throw new Error(registered.name);
  const keys = Object.keys(registered.parameters.properties);
  if (keys.join(',') !== 'prompt,resolution,quality,count,background,location,images,mask') throw new Error(keys.join(','));
  if (!registered.parameters.required.includes('prompt')) throw new Error('prompt is optional');

  if (keys.includes('mode')) throw new Error('a mode parameter came back');
  if (registered.parameters.properties.count.type !== 'integer') throw new Error('count type');
  if (!registered.parameters.properties.background.enum.includes('transparent')) throw new Error('background enum');
  if (registered.parameters.properties.images.type !== 'array') throw new Error('images is not an array');
  if (registered.parameters.properties.images.items?.type !== 'string') throw new Error('images items are not strings');
  if (registered.parameters.properties.mask.type !== 'string') throw new Error('mask is not a string');
  if (!registered.description.includes('Settings, Image generation')) throw new Error('description does not name the settings page');
  if (!registered.description.includes('session workspace')) throw new Error('the description does not state where files land');
  if (!registered.description.includes('edit')) throw new Error('the description does not explain the edit behaviour');

  if (/cannot edit/i.test(registered.description)) throw new Error('the description still denies editing');
  if (registered.output.schema.properties.mode) throw new Error('the output still reports a mode');
});

await check('location defaults to the workspace and resolves relative paths against it', () => {
  const workspace = join(tmpdir(), 'dsh-ws');
  if (host.resolveOutputDir(config, undefined, workspace) !== workspace) {
    throw new Error('no location did not fall back to the workspace');
  }
  if (host.resolveOutputDir(config, 'shots', workspace) !== join(workspace, 'shots')) {
    throw new Error('a relative location did not resolve against the workspace');
  }
  if (host.resolveOutputDir(config, 'a/b', workspace) !== join(workspace, 'a', 'b')) {
    throw new Error('a nested relative location did not resolve');
  }
  const absolute = join(tmpdir(), 'elsewhere');
  if (host.resolveOutputDir(config, absolute, workspace) !== absolute) {
    throw new Error('an absolute location was rewritten');
  }
});

await check('an explicitly configured directory survives, and a missing workspace has a fallback', () => {
  const configured = { ...config, outputDir: join(tmpdir(), 'configured') };
  if (host.resolveOutputDir(configured, undefined, undefined) !== configured.outputDir) {
    throw new Error('the configured directory was ignored without a workspace');
  }
  if (host.resolveOutputDir(configured, undefined, join(tmpdir(), 'dsh-ws')) !== configured.outputDir) {
    throw new Error('an explicit configuration was overridden by the workspace default');
  }
  if (host.resolveOutputDir(config, undefined, undefined) !== host.outputDirOf(config)) {
    throw new Error('with neither, the packaged directory is the fallback');
  }
  if (host.resolveOutputDir(config, 'shots', undefined) !== join(host.outputDirOf(config), 'shots')) {
    throw new Error('a relative location without a workspace did not fall back to the configured root');
  }
});

await check('resolution keeps the frame rules on the parameter', () => {
  const field = registered.parameters.properties.resolution;
  if (field.enum) throw new Error('a free-form size was locked to an enum');
  if (field.type !== 'string') throw new Error(field.type);
  if (!field.description.includes('auto')) throw new Error('the description does not offer auto');
  if (!field.description.includes('multiple of 16')) throw new Error('the description does not state the step rule');
  if (!field.description.includes('8,294,400')) throw new Error('the description does not state the pixel ceiling');
  if (!field.description.includes('3:1')) throw new Error('the description does not state the ratio limit');
  if (!field.description.includes('3840x2160')) throw new Error('the ready-made sizes are missing');
});

await check('the description answers how to use the tool, not just what it is', () => {
  const text = registered.description;
  if (!text.includes('present')) throw new Error('it does not say how to surface the result');
  if (!text.includes('ordinary language')) throw new Error('it does not say how to write the prompt');
  if (!text.includes('Settings, Image generation')) throw new Error('it does not name the settings page');
  if (!text.includes('separate calls')) throw new Error('it does not say when to split into calls');
  if (/ranked|number one|#1|best image model/i.test(text)) throw new Error('an unverifiable ranking leaked into the description');
});

await check('the prompt parameter resolves the keep-versus-fill conflict', () => {
  const field = registered.parameters.properties.prompt;
  if (!field.description.includes('must survive')) throw new Error('it does not protect what the caller specified');
  if (!field.description.includes('yours to decide')) throw new Error('it does not say what the caller may decide');
  if (!field.description.includes('share a look')) throw new Error('it does not cover consistency across a batch');
});

await check('quality is a five-step enum with no auto rung', () => {
  const values = registered.parameters.properties.quality.enum;
  if (values.join(',') !== 'low,medium,high,xhigh,max') throw new Error(values.join(','));
});

await check('both routes are registered, and the image one is a prefix GET', () => {

  registeredRoute = routeFor('prefix', '/dsh-image-generation/file');
  if (!registeredRoute) {
    throw new Error(`no image route among ${registeredRoutes.map((entry) => `${entry.kind} ${entry.path}`).join(', ')}`);
  }
  if (registeredRoute.kind !== 'prefix') throw new Error(registeredRoute.kind);
  const records = routeFor('exact', '/dsh-image-generation/records');
  if (!records) throw new Error('the records route is not registered');
  if (typeof records.handler !== 'function') throw new Error('the records route has no handler');
});

await check('a missing API key fails before any request leaves', async () => {
  host.apply(fakeCtx, host.Config({ secret: '' }));
  const message = await registered.execute({ prompt: 'a corgi' }, { signal: new AbortController().signal }).then(
    () => 'resolved',
    (error) => error.message,
  );
  if (!message.includes('No API key')) throw new Error(message);
});

await check('an empty prompt is refused', async () => {
  host.apply(fakeCtx, host.Config({ secret: 'sk-test' }));
  const message = await registered.execute({ prompt: '  ' }, { signal: new AbortController().signal }).then(
    () => 'resolved',
    (error) => error.message,
  );
  if (!message.includes('prompt is required')) throw new Error(message);
});

await check('an out-of-range count is refused', async () => {
  const message = await registered.execute({ prompt: 'x', count: 11 }, { signal: new AbortController().signal }).then(
    () => 'resolved',
    (error) => error.message,
  );
  if (!message.includes('between 1 and 10')) throw new Error(message);
});

await check('a hand-written custom size is refused with the rules named', async () => {
  const message = await registered
    .execute({ prompt: 'x', resolution: '1536x865' }, { signal: new AbortController().signal })
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  if (!message.includes('multiple of 16')) throw new Error(message);
});

await check('an illegal default size fails the call with the reason, not silently', async () => {
  host.apply(fakeCtx, host.Config({ secret: 'sk-test', defaultResolution: '3840x3840' }));
  const message = await registered.execute({ prompt: 'x' }, { signal: new AbortController().signal }).then(
    () => 'resolved',
    (error) => error.message,
  );
  if (!message.includes('8294400')) throw new Error(`the ceiling reason is missing: ${message}`);
  if (!message.includes('2880x2880')) throw new Error('the message does not name the largest workable square');
});

await check('the manifest only names packages this DSH release actually ships', async () => {
  // Measured defect this covers: 0.2.1-rc.2 dropped @deepseek-ai/dsh-client-ui-slots, and the
  // manifest still injected it, so the Client half could not load. A peer pin also froze the
  // plugin out of the release that moved those packages.
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const installed = (name) => {
    for (const root of packageRoots) {
      const candidate = join(root, name.split('/').pop(), 'package.json');
      if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
    }
    return null;
  };
  const require = createRequire(import.meta.url);
  const semver = (() => {
    for (const root of packageRoots) {
      try {
        return createRequire(join(root, 'noop.js'))('semver');
      } catch {
        continue;
      }
    }
    return null;
  })();
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const found = installed(name);
    if (!found) throw new Error(`${name} is a peer but is not installed`);
    if (!semver) continue;
    if (!semver.satisfies(found.version, range, { includePrerelease: true })) {
      throw new Error(`${name} is installed at ${found.version}, which does not satisfy ${range}`);
    }
  }

  // Every name here is loaded before this plugin's Client half, so a missing one is the same
  // failure as a wrong module id: the card never gets a renderer.
  for (const name of manifest.dsh?.client?.inject ?? []) {
    if (!installed(name)) throw new Error(`dsh.client.inject names ${name}, which this DSH does not ship`);
  }
});

const failures = results.filter((line) => line.startsWith('FAIL'));
console.log(['host contract', ...results].join('\n'));
if (packageRoots.length === 0) console.log('\nnote: no DSH installation was found; set DSH_PACKAGE_ROOT to its @deepseek-ai directory.');
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
