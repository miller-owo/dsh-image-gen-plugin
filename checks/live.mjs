import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, register } from 'node:module';

const require = createRequire(import.meta.url);
const roots = [];
for (const specifier of ['@deepseek-ai/dsh-tools/package.json', '@deepseek-ai/schemastery/package.json']) {
  try {
    roots.push(join(require.resolve(specifier), '..', '..'));
  } catch {

  }
}
if (process.env.DSH_PACKAGE_ROOT) roots.push(process.env.DSH_PACKAGE_ROOT);
const global = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
if (existsSync(global)) roots.push(global);

const targets = { schemastery: 'lib/index.mjs', 'dsh-tools': 'lib/index.js' };

register(
  `data:text/javascript;base64,${Buffer.from(`
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const roots = ${JSON.stringify([...new Set(roots)])};
    const targets = ${JSON.stringify(targets)};
    export async function resolve(specifier, context, next) {
      const name = specifier.startsWith('@deepseek-ai/') ? specifier.slice('@deepseek-ai/'.length) : '';
      if (targets[name]) {
        for (const root of roots) {
          const candidate = join(root, name, targets[name]);
          if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
        throw new Error('Could not resolve ' + specifier + '; set DSH_PACKAGE_ROOT.');
      }
      return next(specifier, context);
    }
  `).toString('base64')}`,
);

const { apply, Config } = await import('../index.js');
const { deflateSync } = await import('node:zlib');
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = await import('node:fs/promises');

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(`ok   ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`);
  }
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function tinyPng() {
  const width = 8;
  const height = 8;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x40)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = tinyPng();
const outputDir = await mkdtemp(join(tmpdir(), 'dsh-image-gen-'));

const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url, init });
  if (init?.headers?.authorization !== 'Bearer sk-test') {
    return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  }
  return new Response(
    JSON.stringify({ data: [{ b64_json: png.toString('base64') }, { b64_json: png.toString('base64') }], usage: { total_tokens: 42 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

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

const applyPlugin = (config, context = fakeCtx) => {
  const result = apply(context, config);
  registeredRoute = routeFor('prefix', '/dsh-image-generation/file');
  if (!registeredRoute) {
    throw new Error(`no image route among ${registeredRoutes.map((entry) => `${entry.kind} ${entry.path}`).join(', ')}`);
  }
  return result;
};

applyPlugin(Config({ secret: 'sk-test', outputDir, count: 2 }));

registeredRoute = routeFor('prefix', '/dsh-image-generation/file');
if (!registeredRoute) throw new Error(`no image route among ${registeredRoutes.map((entry) => entry.path).join(', ')}`);
const recordsRoute = routeFor('exact', '/dsh-image-generation/records');
if (!recordsRoute) throw new Error('the records route is not registered');

let firstFileName;

const execution = (workspace, signal = new AbortController().signal) => ({
  signal,
  agent: workspace ? { session: { header: { cwd: workspace } } } : undefined,
});

let captured;
const capture = async (params, exec) => {
  const before = requests.length;
  const value = await registered.execute(params, exec);
  captured = requests[before];
  return value;
};

await check('a call writes every returned image to the configured directory', async () => {
  const value = await capture(
    { prompt: 'a corgi in a hat', resolution: '1536x1024', background: 'transparent' },
    execution(),
  );
  if (value.returned !== 2) throw new Error(`returned ${value.returned}`);
  if (value.usageTokens !== 42) throw new Error(`usage ${value.usageTokens}`);
  if (value.savedTo !== outputDir) throw new Error(`savedTo was ${value.savedTo}`);
  for (const image of value.images) {
    const info = await stat(image.path);
    if (info.size !== png.byteLength) throw new Error(`${image.path} holds ${info.size} bytes`);
    if (!image.url.startsWith('/dsh-image-generation/file/')) throw new Error(image.url);
    if (image.mime !== 'image/png') throw new Error(image.mime);
  }
  firstFileName = value.images[0].path.split(/[\\/]/).pop();
});

await check('location points a call at its own directory, and the frame is still servable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-image-gen-ws-'));
  const value = await registered.execute(
    { prompt: 'a product shot', location: 'assets/covers' },
    execution(workspace),
  );
  const expected = join(workspace, 'assets', 'covers');
  if (value.savedTo !== expected) throw new Error(`savedTo was ${value.savedTo}`);
  for (const image of value.images) {
    if (!image.path.startsWith(expected)) throw new Error(`${image.path} is not under ${expected}`);
    const info = await stat(image.path);
    if (info.size !== png.byteLength) throw new Error(`${image.path} holds ${info.size} bytes`);
  }

  const name = value.images[0].path.split(/[\\/]/).pop();
  let status;
  let payload;
  const res = {
    writeHead(code) {
      status = code;
      return this;
    },
    end(body) {
      payload = body;
      return this;
    },
  };
  await registeredRoute.handler({ url: `/dsh-image-generation/file/${encodeURIComponent(name)}` }, res);
  if (status !== 200) throw new Error(`status ${status} for a file written outside the configured roots`);
  if (payload.byteLength !== png.byteLength) throw new Error(`served ${payload.byteLength} bytes`);

  await rm(workspace, { recursive: true, force: true });
});

await check('an absolute location is taken as given', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-image-gen-ws-'));
  const target = await mkdtemp(join(tmpdir(), 'dsh-image-gen-abs-'));
  const value = await registered.execute({ prompt: 'x', location: target }, execution(workspace));
  if (value.savedTo !== target) throw new Error(`savedTo was ${value.savedTo}`);
  if (!value.images[0].path.startsWith(target)) throw new Error(`landed at ${value.images[0].path}`);
  await rm(workspace, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

await check('base64 decodes into the image the bytes actually are', async () => {
  const { decodeImage } = await import('../index.js');
  const payload = decodeImage(png.toString('base64'), 'Image 1');
  if (payload.bytes.byteLength !== png.byteLength) throw new Error(`decoded ${payload.bytes.byteLength} bytes`);
  if (payload.format !== 'png') throw new Error(payload.format);
  if (payload.mime !== 'image/png') throw new Error(payload.mime);
  if (!payload.bytes.equals(png)) throw new Error('the decoded bytes differ from the source');
});

await check('the decoder tolerates whitespace and padding but refuses anything else', async () => {
  const { decodeImage } = await import('../index.js');
  const wrapped = png.toString('base64').replace(/(.{40})/g, '$1\n');
  if (decodeImage(wrapped, 'Image 1').bytes.byteLength !== png.byteLength) {
    throw new Error('a wrapped base64 payload was refused');
  }
  const cases = [
    ['', 'without base64 data'],
    ['not base64 at all!!', 'not valid base64'],
    [Buffer.from('hello there').toString('base64'), 'did not decode to a PNG'],
  ];
  for (const [input, fragment] of cases) {
    try {
      decodeImage(input, 'Image 2');
      throw new Error(`accepted ${JSON.stringify(input)}`);
    } catch (error) {
      if (!error.message.includes(fragment)) throw error;
      if (!error.message.includes('Image 2')) throw new Error(`the label is missing from "${error.message}"`);
    }
  }
});

await check('a payload whose format disagrees with the request is filed as what it is', async () => {

  const { decodeImage } = await import('../index.js');
  const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x20)]);
  const payload = decodeImage(jpegBytes.toString('base64'), 'Image 1');
  if (payload.format !== 'jpeg') throw new Error(payload.format);
  if (payload.mime !== 'image/jpeg') throw new Error(payload.mime);
});

await check('a gateway that omits revised_prompt still produces a valid tool result', async () => {

  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
  const original = globalThis.fetch;

  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
  const value = await registered.execute({ prompt: 'a cat' }, execution());

  const violations = validateJsonSchemaValue(registered.output.schema, value, 'value');
  if (violations.length > 0) throw new Error(`the result fails its own declared schema: ${violations.join('; ')}`);
  if ('revisedPrompt' in value.images[0]) throw new Error('a missing revised_prompt left a key behind');
  if (value.images[0].bytes !== png.byteLength) throw new Error('the image did not survive');

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'a cat, restated' }] }), {
      status: 200,
    });
  const withField = await registered.execute({ prompt: 'a cat' }, execution());
  const withViolations = validateJsonSchemaValue(registered.output.schema, withField, 'value');
  if (withViolations.length > 0) throw new Error(withViolations.join('; '));
  if (withField.images[0].revisedPrompt !== 'a cat, restated') throw new Error('the revised prompt was lost');

  globalThis.fetch = original;
});

await check('the filename pattern is configurable and every token resolves', async () => {
  const { applyNamePattern } = await import('../index.js');
  const rendered = applyNamePattern('{time}-{prompt}-{index}-{uniq}', { prompt: 'A Cat In A Hat!', index: 2 });

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-a-cat-in-a-hat-2-[0-9a-f]{8}$/.test(rendered)) {
    throw new Error(`unexpected rendering: ${rendered}`);
  }
  if (applyNamePattern('{prompt}', { prompt: 'Knowledge Map, Vol 2', index: 1 }) !== 'knowledge-map-vol-2') {
    throw new Error('the prompt token did not slugify');
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(applyNamePattern('{time}', { prompt: 'anything', index: 3 }))) {
    throw new Error('the time token did not render');
  }
  if (!applyNamePattern('   ', { prompt: '', index: 1 })) throw new Error('an empty pattern produced an empty name');
});

await check('the chosen pattern reaches the file on disk', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-image-gen-name-'));
  applyPlugin(Config({ secret: 'sk-test', outputDir: workspace, fileNameFormat: '{prompt}-{index}' }));
  const value = await registered.execute({ prompt: 'A Cat In A Hat!', count: 2 }, execution());
  const names = value.images.map((image) => image.path.split(/[\\/]/).pop());
  if (names[0] !== 'a-cat-in-a-hat-1.png') throw new Error(names[0]);
  if (names[1] !== 'a-cat-in-a-hat-2.png') throw new Error(names[1]);
  for (const image of value.images) {
    const info = await stat(image.path);
    if (info.size !== png.byteLength) throw new Error(`${image.path} holds ${info.size} bytes`);
  }
  await rm(workspace, { recursive: true, force: true });
});

await check('a pattern without an identity token collides safely instead of overwriting', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-image-gen-collide-'));
  applyPlugin(Config({ secret: 'sk-test', outputDir: workspace, fileNameFormat: '{prompt}' }));
  const first = await registered.execute({ prompt: 'same name' }, execution());
  const second = await registered.execute({ prompt: 'same name' }, execution());
  if (first.images[0].path === second.images[0].path) throw new Error('the second call overwrote the first');

  const firstInfo = await stat(first.images[0].path);
  const secondInfo = await stat(second.images[0].path);
  if (firstInfo.size !== png.byteLength || secondInfo.size !== png.byteLength) throw new Error('a file was damaged');
  if (!/^same-name(?:-\d+)?\.png$/.test(first.images[0].path.split(/[\\/]/).pop())) {
    throw new Error(first.images[0].path);
  }
  if (!/^same-name-\d+\.png$/.test(second.images[0].path.split(/[\\/]/).pop())) {
    throw new Error(second.images[0].path);
  }
  await rm(workspace, { recursive: true, force: true });
});

await check('the request body is exactly what the endpoint expects', () => {
  if (!captured) throw new Error('no request was captured');
  const { url, init } = captured;
  if (url !== 'https://api.openai.com/v1/images/generations') throw new Error(url);
  if (init.method !== 'POST') throw new Error(init.method);
  const body = JSON.parse(init.body);
  if (body.model !== 'gpt-image-2.5-flare') throw new Error(body.model);
  if (body.n !== 2) throw new Error(`n ${body.n}`);
  if (body.size !== '1536x1024') throw new Error(body.size);
  if (body.background !== 'transparent') throw new Error(body.background);
  if (body.quality !== 'high') throw new Error(`quality was ${body.quality}`);
  if (body.output_format !== 'png') throw new Error(body.output_format);
  if ('moderation' in body) throw new Error('moderation reached 2.5');
  if ('stream' in body) throw new Error('stream was sent');
});

await check('the image route serves the written file with a sane content type', async () => {
  let status;
  let headers;
  let payload;
  const res = {
    writeHead(code, head) {
      status = code;
      headers = head;
      return this;
    },
    end(body) {
      payload = body;
      return this;
    },
  };
  await registeredRoute.handler({ url: `/dsh-image-generation/file/${encodeURIComponent(firstFileName)}` }, res);
  if (status !== 200) throw new Error(`status ${status}`);
  if (headers['content-type'] !== 'image/png') throw new Error(headers['content-type']);
  if (payload.byteLength !== png.byteLength) throw new Error(`served ${payload.byteLength} bytes`);
});

await check('the route refuses to walk out of the output directory', async () => {
  let status = 0;
  const res = {
    writeHead(code) {
      status = code;
      return this;
    },
    end() {
      return this;
    },
  };
  await registeredRoute.handler({ url: '/dsh-image-generation/file/..%2F..%2Findex.js' }, res);
  if (status === 200) throw new Error('the traversal was served');
});

await check('the route answers a malformed escape instead of throwing', async () => {

  for (const url of ['/dsh-image-generation/file/%E0%A4%A', '/dsh-image-generation/file/%']) {
    let status = 0;
    const res = {
      writeHead(code) {
        status = code;
        return this;
      },
      end() {
        return this;
      },
    };
    await registeredRoute.handler({ url }, res);
    if (status !== 400) throw new Error(`${url} answered ${status}`);
  }
});

await check('a shared basename resolves to the frame the card just produced', async () => {

  const dirA = await mkdtemp(join(tmpdir(), 'dsh-route-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'dsh-route-b-'));
  const payload = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
  const original = globalThis.fetch;

  globalThis.fetch = payload;
  applyPlugin(Config({ secret: 'sk-test', outputDir: dirA, fileNameFormat: 'same' }));
  await registered.execute({ prompt: 'x' }, execution(dirA));
  const second = await registered.execute({ prompt: 'x' }, execution(dirB));
  globalThis.fetch = original;

  const name = second.images[0].path.split(/[\\/]/).pop();
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
  await registeredRoute.handler({ url: `/dsh-image-generation/file/${encodeURIComponent(name)}` }, res);
  if (status !== 200) throw new Error(`the newest file answered ${status}`);
  if (served !== png.byteLength) throw new Error(`served ${served} bytes`);

  let firstStatus = 0;
  const firstRes = {
    writeHead(code) {
      firstStatus = code;
      return this;
    },
    end() {
      return this;
    },
  };
  await registeredRoute.handler({ url: '/dsh-image-generation/file/same.png' }, firstRes);
  if (firstStatus !== 200) throw new Error(`the first file answered ${firstStatus}`);

  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

await check('passing a source image switches the call to the edit endpoint', async () => {

  const dir = await mkdtemp(join(tmpdir(), 'dsh-edit-'));
  const sourcePath = join(dir, 'cat.png');
  await writeFile(sourcePath, png);
  const original = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
  };
  applyPlugin(Config({ secret: 'sk-test', outputDir: dir }));
  const value = await registered.execute({ prompt: 'make it ginger', images: [sourcePath] }, execution());
  globalThis.fetch = original;

  if (!seen) throw new Error('no request left the plugin');
  if (!seen.url.endsWith('/images/edits')) throw new Error(seen.url);
  if (!String(seen.init.headers['content-type']).startsWith('multipart/form-data; boundary=')) {
    throw new Error(String(seen.init.headers['content-type']));
  }
  if (Buffer.isBuffer(seen.init.body) === false && !(seen.init.body instanceof Uint8Array)) {
    throw new Error('the edit body is not bytes');
  }
  const body = Buffer.from(seen.init.body);
  if (!body.includes(png)) throw new Error('the source bytes did not travel');
  if (!body.toString('latin1').includes('make it ginger')) throw new Error('the prompt did not travel');

  if (value.returned !== 1) throw new Error(`returned ${value.returned}`);
  const info = await stat(value.images[0].path);
  if (info.size !== png.byteLength) throw new Error('the edited frame was not written');
  await rm(dir, { recursive: true, force: true });
});

await check('a text-only call still reaches the generation endpoint as JSON', async () => {

  const original = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
  };
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  await registered.execute({ prompt: 'a corgi' }, execution());
  globalThis.fetch = original;
  if (!seen.url.endsWith('/images/generations')) throw new Error(seen.url);
  if (seen.init.headers['content-type'] !== 'application/json') throw new Error(seen.init.headers['content-type']);
  const body = JSON.parse(seen.init.body);
  if (body.prompt !== 'a corgi') throw new Error(body.prompt);
});

await check('a missing source image fails before any request leaves', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  const message = await registered
    .execute({ prompt: 'x', images: [join(tmpdir(), 'definitely-not-here.png')] }, execution())
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  globalThis.fetch = original;
  if (called) throw new Error('a request was sent for a missing source image');
  if (!/not found/i.test(message)) throw new Error(message);
});

await check('a mask without exactly one source image is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-maskguard-'));
  const maskPath = join(dir, 'mask.png');
  await writeFile(maskPath, png);
  applyPlugin(Config({ secret: 'sk-test', outputDir: dir }));
  const message = await registered
    .execute({ prompt: 'x', mask: maskPath }, execution())
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  if (!/exactly one source image/i.test(message)) throw new Error(message);
  await rm(dir, { recursive: true, force: true });
});

await check('the presence of source images is the switch, and nothing else is', async () => {

  const dir = await mkdtemp(join(tmpdir(), 'dsh-switch-'));
  const sourcePath = join(dir, 'cat.png');
  await writeFile(sourcePath, png);
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
  };
  applyPlugin(Config({ secret: 'sk-test', outputDir: dir }));

  const edited = await registered.execute({ prompt: 'x', images: [sourcePath] }, execution());
  if (!calls.at(-1).endsWith('/images/edits')) throw new Error(calls.at(-1));
  if ('mode' in edited) throw new Error('the result still reports a mode');

  const generated = await registered.execute({ prompt: 'x' }, execution());
  if (!calls.at(-1).endsWith('/images/generations')) throw new Error(calls.at(-1));

  const stray = await registered
    .execute({ prompt: 'x', mode: 'edit' }, execution())
    .then(() => 'resolved', (error) => error.message);
  if (stray !== 'resolved' && !/unknown|unexpected|invalid/i.test(stray)) {
    throw new Error(`a stray mode argument produced: ${stray}`);
  }
  if (!calls.at(-1).endsWith('/images/generations') && stray === 'resolved') {
    throw new Error('a stray mode argument rerouted the call');
  }

  globalThis.fetch = original;
  await rm(dir, { recursive: true, force: true });
});

await check('a frame outside the configured roots stays servable after a restart', async () => {

  const dir = await mkdtemp(join(tmpdir(), 'dsh-index-'));
  const { indexPathForTests, forgetInMemoryFilesForTests } = await import('../index.js');

  const indexBefore = await readFile(indexPathForTests(), 'utf8').catch(() => null);
  try {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
    applyPlugin(Config({ secret: 'sk-test', outputDir: dir }));
    const value = await registered.execute({ prompt: 'restart me', location: dir }, execution(dir));
    globalThis.fetch = original;

    const name = value.images[0].path.split(/[\\/]/).pop();

    const index = JSON.parse(await readFile(indexPathForTests(), 'utf8'));
    if (index[name] !== value.images[0].path) {
      throw new Error(`the persisted index does not name ${name}: ${JSON.stringify(index[name] ?? null)}`);
    }

    forgetInMemoryFilesForTests();

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
    await registeredRoute.handler({ url: `/dsh-image-generation/file/${encodeURIComponent(name)}` }, res);
    if (status !== 200) throw new Error(`the route answered ${status} from the persisted index`);
    if (served !== png.byteLength) throw new Error(`served ${served} bytes, expected ${png.byteLength}`);

    await rm(value.images[0].path, { force: true });
    let goneStatus = 0;
    const goneRes = {
      writeHead(code) {
        goneStatus = code;
        return this;
      },
      end() {
        return this;
      },
    };
    await registeredRoute.handler({ url: `/dsh-image-generation/file/${encodeURIComponent(name)}` }, goneRes);
    if (goneStatus === 200) throw new Error('a deleted frame was still served');
  } finally {
    if (indexBefore === null) await rm(indexPathForTests(), { force: true });
    else await writeFile(indexPathForTests(), indexBefore);
    await rm(dir, { recursive: true, force: true });
  }
});

await check('a frame this process never wrote is found in the workspace', async () => {

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-other-'));
  const nested = join(workspace, 'out', 'frames');
  await mkdir(nested, { recursive: true });
  const name = '2026-10-07T14-35-58-692-other.png';
  await writeFile(join(nested, name), png);

  applyPlugin(Config({ secret: 'sk-test', outputDir: join(workspace, 'unused') }));
  const { rememberWorkspaceForTests, forgetInMemoryFilesForTests } = await import('../index.js');
  rememberWorkspaceForTests(workspace);
  forgetInMemoryFilesForTests();

  const call = async (requestName) => {
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
    await registeredRoute.handler({ url: `/dsh-image-generation/file/${encodeURIComponent(requestName)}` }, res);
    return { status, served };
  };

  const hit = await call(name);
  if (hit.status !== 200) throw new Error(`the workspace fallback answered ${hit.status}`);
  if (hit.served !== png.byteLength) throw new Error(`served ${hit.served} bytes, expected ${png.byteLength}`);

  const strayName = 'not-ours.png';
  await writeFile(join(workspace, strayName), png);
  forgetInMemoryFilesForTests();
  const stray = await call(strayName);
  if (stray.status === 200) throw new Error('a name this plugin never writes was served from the workspace');
  await rm(workspace, { recursive: true, force: true });
});

await check('a scan alone finds the frame, with no record anywhere', async () => {

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-scanonly-'));
  const name = '2026-10-07T14-35-58-692-by-scan.png';
  await writeFile(join(workspace, name), png);

  applyPlugin(Config({ secret: 'sk-test', outputDir: join(workspace, 'unused') }));
  const { rememberWorkspaceForTests, forgetInMemoryFilesForTests, indexPathForTests } = await import('../index.js');
  rememberWorkspaceForTests(workspace);
  forgetInMemoryFilesForTests();

  await rm(indexPathForTests(), { force: true });

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
  await registeredRoute.handler({ url: `/dsh-image-generation/file/${encodeURIComponent(name)}` }, res);
  if (status !== 200) throw new Error(`a scan alone answered ${status}`);
  if (served !== png.byteLength) throw new Error(`served ${served} bytes, expected ${png.byteLength}`);

  if (!existsSync(indexPathForTests())) throw new Error('the scan hit was not recorded for next time');
  await rm(workspace, { recursive: true, force: true });
  await rm(indexPathForTests(), { force: true });
});

await check('an error keeps the provider message', async () => {
  applyPlugin(Config({ secret: 'wrong', outputDir }));
  const message = await registered
    .execute({ prompt: 'x' }, { signal: new AbortController().signal })
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  if (!message.includes('HTTP 401')) throw new Error(message);
  if (!message.includes('bad key')) throw new Error(message);
});

await check('a non-JSON body is reported instead of swallowed', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>gateway</html>', { status: 200 });
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  const message = await registered
    .execute({ prompt: 'x' }, { signal: new AbortController().signal })
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  globalThis.fetch = original;
  if (!message.includes('non-JSON')) throw new Error(message);
  if (!message.includes('<html>gateway</html>')) throw new Error(`the body preview is missing: ${message}`);
});

await check('the binary bytes of an unparseable body never reach the message', async () => {
  const original = globalThis.fetch;
  const binary = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x01, 0x02, 0x03]);
  globalThis.fetch = async () => new Response(binary, { status: 200 });
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  const message = await registered
    .execute({ prompt: 'x' }, { signal: new AbortController().signal })
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  globalThis.fetch = original;
  if (!message.includes('·')) throw new Error(`non-printable bytes were not masked: ${message}`);
});

await check('every error envelope shape the gateways use is read', async () => {
  const original = globalThis.fetch;
  const cases = [
    ['{"error":"a bare string"}', 'a bare string'],
    ['{"error":{"message":"upstream timeout","code":"timeout"}}', 'upstream timeout (timeout)'],
    ['{"error":{"message":"just a message"}}', 'just a message'],
    ['{"message":"hoisted to the top"}', 'hoisted to the top'],
    ['{}', 'HTTP 400'],
  ];
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  for (const [payload, expected] of cases) {
    globalThis.fetch = async () => new Response(payload, { status: 400 });
    const message = await registered
      .execute({ prompt: 'x' }, { signal: new AbortController().signal })
      .then(
        () => 'resolved',
        (error) => error.message,
      );
    if (!message.includes(expected)) throw new Error(`${payload} produced "${message}"`);
    if (!message.includes('HTTP 400')) throw new Error(`the status was dropped from "${message}"`);
  }
  globalThis.fetch = original;
});

await check('an HTTP 200 carrying an error envelope is still a failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'content policy violation', code: 'moderation' } }), { status: 200 });
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  const message = await registered
    .execute({ prompt: 'x' }, { signal: new AbortController().signal })
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  globalThis.fetch = original;
  if (!message.includes('content policy violation')) throw new Error(message);
  if (message.includes('no data array')) throw new Error(`the envelope was mistaken for a missing data array: ${message}`);
});

await check('a data array entry without base64 is named rather than silently dropped', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }, { revised_prompt: 'no bytes here' }] }), {
      status: 200,
    });
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  const message = await registered
    .execute({ prompt: 'x' }, { signal: new AbortController().signal })
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  globalThis.fetch = original;
  if (!message.includes('Image 2')) throw new Error(`the failing entry was not identified: ${message}`);
});

await check('a signal already aborted before the request is not reported as a cancelled generation', async () => {

  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });
  };
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  const controller = new AbortController();
  controller.abort();
  const message = await registered
    .execute({ prompt: 'x' }, { signal: controller.signal, agent: { session: { header: { cwd: process.cwd() } } } })
    .then(
      () => 'resolved',
      (error) => error.message,
    );
  globalThis.fetch = original;
  if (!/before the request was sent/i.test(message)) throw new Error(`an already-aborted call reported: ${message}`);

  if (requests !== 0) throw new Error(`${requests} requests were sent for an already-cancelled call`);
});

await check('the caller signal cancels a request in flight', async () => {

  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      attempts += 1;
      if (init.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  applyPlugin(Config({ secret: 'sk-test', outputDir }));
  const controller = new AbortController();
  const pending = registered.execute({ prompt: 'x' }, { signal: controller.signal }).then(
    () => 'resolved',
    (error) => error.message,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const message = await pending;
  globalThis.fetch = original;
  if (!/cancel/i.test(message)) throw new Error(`the cancellation is not named: ${message}`);
  if (attempts !== 1) throw new Error(`a cancelled request was retried ${attempts} times`);
});

await check('a transient failure is retried, and a permanent one is not', async () => {
  const original = globalThis.fetch;
  applyPlugin(Config({ secret: 'sk-test', outputDir }));

  let attempts = 0;
  const succeed = () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 });

  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
    return succeed();
  };
  const rescued = await registered.execute({ prompt: 'x' }, execution());
  if (attempts !== 2) throw new Error(`expected one retry, saw ${attempts} attempts (returned ${rescued.returned})`);
  if (rescued.returned !== 1) throw new Error('the retry did not produce an image');

  attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 });
  };
  const refused = await registered.execute({ prompt: 'x' }, execution()).then(
    () => 'resolved',
    (error) => error.message,
  );
  if (attempts !== 1) throw new Error(`a permanent failure was retried ${attempts} times`);
  if (!refused.includes('bad request')) throw new Error(refused);

  globalThis.fetch = original;
});

await check('the output declaration keeps text and metadata in step', async () => {
  const value = {
    images: [{ index: 1, path: 'p.png', url: '/u', bytes: 10, mime: 'image/png', revisedPrompt: null }],
    model: 'gpt-image-2.5-flare',
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    requested: 1,
    returned: 1,
    usageTokens: null,
  };
  const blocks = registered.output.render({ prompt: 'x' }, value);
  if (!blocks[0].text.includes('p.png')) throw new Error(blocks[0].text);
  const meta = registered.output.presentationMeta({ prompt: 'x' }, value);
  if (meta.images[0].path !== 'p.png') throw new Error(JSON.stringify(meta));
  const presented = registered.presentResult({ prompt: 'x' }, { content: blocks, isError: false, meta });
  if (!presented.content[0].text.includes('p.png')) throw new Error(JSON.stringify(presented));
});

await check('a failed call is left to the error card', () => {
  if (registered.presentResult({ prompt: 'x' }, { content: [], isError: true, meta: { images: [] } }) !== undefined) {
    throw new Error('a failure produced a success card');
  }
});

const written = await readFile(join(outputDir, firstFileName));
if (written.byteLength !== png.byteLength) throw new Error('the written file changed on read');

const failures = results.filter((line) => line.startsWith('FAIL'));
console.log(['live contract', ...results].join('\n'));
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
await rm(outputDir, { recursive: true, force: true });
process.exitCode = failures.length === 0 ? 0 : 1;
