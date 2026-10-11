import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'image-generation';

export const inject = ['tools'];
export const Config = z.object({
  apiUrl: z.string().default('https://api.openai.com/v1').volatile(),

  secret: z.string().default('').volatile(),
  model: z.string().default('gpt-image-2.5-flare').volatile(),
  count: z.number().default(1).volatile(),
  outputFormat: z.string().default('png').volatile(),
  outputCompression: z.number().default(100).volatile(),
  moderation: z.string().default('auto').volatile(),
  background: z.string().default('auto').volatile(),
  user: z.string().default('').volatile(),
  outputDir: z.string().default('').volatile(),

  fileNameFormat: z.string().default('{time}-{prompt}').volatile(),

  defaultResolution: z.string().default('auto').volatile(),
  requestTimeoutSec: z.number().default(600).volatile(),

  maxEdge: z.number().default(3840).volatile(),

  sendsModeration: z.boolean().default(true).volatile(),
  sendsOutputCompression: z.boolean().default(true).volatile(),
});

export const IMAGE_ROUTE = '/dsh-image-generation/file';
const ROUTE_SEGMENT = `${IMAGE_ROUTE}/`;
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL('./assets/', import.meta.url));

const BACKGROUNDS = ['auto', 'transparent', 'opaque'];
const MAX_PROMPT_CHARS = 32000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const MAX_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8;
const MAX_NAME_ATTEMPTS = 50;
const MAX_RETRY_WAIT_MS = 30000;
const SIZE_STEP = 16;

export const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'];

const DEFAULT_QUALITY = 'high';

const MIN_PIXELS = 655360;
const MAX_PIXELS = 8294400;

export function inspectSize(value, limits = {}) {
  const maxEdge = limits.maxEdge ?? 3840;
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(String(value ?? '').trim());
  if (!match) return { ok: false, reason: 'format' };
  const width = Number(match[1]);
  const height = Number(match[2]);
  const sized = { width, height };
  if (width % SIZE_STEP !== 0 || height % SIZE_STEP !== 0) return { ok: false, reason: 'step', ...sized };
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (long / short > 3) return { ok: false, reason: 'ratio', ...sized };
  if (long > maxEdge) return { ok: false, reason: 'cap', ...sized, maxEdge };
  const pixels = width * height;
  if (pixels < MIN_PIXELS) return { ok: false, reason: 'floor', ...sized, minPixels: MIN_PIXELS };
  if (pixels > MAX_PIXELS) return { ok: false, reason: 'ceiling', ...sized, maxPixels: MAX_PIXELS };
  return { ok: true, value: `${width}x${height}`, ...sized, pixels };
}

export function parseSize(value, limits = {}) {
  const verdict = inspectSize(value, limits);
  if (verdict.ok) return verdict.value;
  if (verdict.reason === 'format') {
    fail(`Invalid resolution "${value}". Use "auto" or WIDTHxHEIGHT such as 1536x864.`);
  }
  if (verdict.reason === 'step') {
    fail(`Resolution ${verdict.width}x${verdict.height} is not a multiple of ${SIZE_STEP}; every side must be.`);
  }
  if (verdict.reason === 'cap') {
    fail(`Resolution ${verdict.width}x${verdict.height} exceeds ${verdict.maxEdge} on its longest edge.`);
  }
  if (verdict.reason === 'ratio') {
    fail(`Resolution ${verdict.width}x${verdict.height} is wider than 3:1; the endpoint refuses it.`);
  }
  if (verdict.reason === 'floor') {
    fail(`Resolution ${verdict.width}x${verdict.height} covers ${verdict.width * verdict.height} pixels, under the ${MIN_PIXELS} the endpoint needs.`);
  }
  fail(
    `Resolution ${verdict.width}x${verdict.height} covers ${verdict.width * verdict.height} pixels, over the ${MAX_PIXELS} the endpoint accepts. A ${verdict.width} square sits above that ceiling; 2880x2880 is the largest square that fits.`,
  );
}

const PRESET_SHAPES = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
  [2, 1],
  [1, 2],
  [5, 4],
  [4, 5],
  [21, 9],
];

export function presetSizes(limits = {}) {
  const maxEdge = limits.maxEdge ?? 3840;
  const sizes = [];
  const add = (size) => {
    if (inspectSize(size, limits).ok && !sizes.includes(size)) sizes.push(size);
  };
  for (const [width, height] of PRESET_SHAPES) {
    for (const edge of [1024, 2048, maxEdge]) {
      const step = Math.max(1, Math.floor(edge / Math.max(width, height) / SIZE_STEP)) * SIZE_STEP;
      add(`${step * width}x${step * height}`);
    }
  }
  return sizes;
}

const isGptImage25 = (model) => String(model).startsWith('gpt-image-2.5-');

function plain(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get === 'function') return plain(value.get());
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
}

function effectiveConfig(config) {
  const raw = plain(config) ?? {};
  return {
    apiUrl: String(raw.apiUrl ?? '').trim(),
    secret: String(raw.secret ?? ''),
    model: String(raw.model ?? 'gpt-image-2.5-flare').trim(),
    count: Number(raw.count ?? 1),
    outputFormat: String(raw.outputFormat ?? 'png').trim(),
    outputCompression: Number(raw.outputCompression ?? 100),
    moderation: String(raw.moderation ?? 'auto').trim(),
    background: String(raw.background ?? 'auto').trim(),
    user: String(raw.user ?? '').trim(),
    outputDir: String(raw.outputDir ?? '').trim(),
    fileNameFormat: String(raw.fileNameFormat ?? '').trim() || DEFAULT_FILE_NAME_PATTERN,
    defaultResolution: String(raw.defaultResolution ?? 'auto').trim() || 'auto',
    requestTimeoutSec: Number(raw.requestTimeoutSec ?? 600),
    maxEdge: Number(raw.maxEdge ?? 3840),
    sendsModeration: raw.sendsModeration !== false,
    sendsOutputCompression: raw.sendsOutputCompression !== false,
  };
}

function fail(message) {
  throw new Error(message);
}

function normalizeBackground(value, config) {
  const requested = String(value ?? '').trim();
  const background = (requested || config.background || 'auto').toLowerCase();
  if (!BACKGROUNDS.includes(background)) {
    fail(`Unsupported background "${value}". Use one of: ${BACKGROUNDS.join(', ')}.`);
  }
  if (background === 'transparent' && config.outputFormat === 'jpeg') {
    fail('A transparent background needs png or webp output; change the output format in Settings, Image generation.');
  }
  return background;
}

export function outputDirOf(config) {
  return config.outputDir ? resolve(config.outputDir) : DEFAULT_OUTPUT_DIR;
}

function normalizeSourcePaths(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  const paths = [];
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    for (const piece of entry.split(/[\n;]+/)) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      if (!paths.includes(trimmed)) paths.push(trimmed);
    }
  }
  return paths;
}

function commonFields(config, prompt, size, count, background, quality) {
  const fields = {
    model: config.model,
    prompt,
    n: count,
    size,
    quality,
    output_format: config.outputFormat,
    background,
  };

  if (config.sendsModeration && config.moderation && config.moderation !== 'auto') {
    fields.moderation = config.moderation;
  }
  if (config.sendsOutputCompression && (config.outputFormat === 'jpeg' || config.outputFormat === 'webp')) {
    fields.output_compression = Math.min(100, Math.max(0, Math.round(config.outputCompression)));
  }
  if (config.user) fields.user = config.user;
  return fields;
}

function buildBody(config, prompt, size, count, background, quality) {
  return commonFields(config, prompt, size, count, background, quality);
}

function buildEditForm(config, prompt, size, count, background, quality, sources) {
  return { fields: commonFields(config, prompt, size, count, background, quality), sources };
}

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

const MAX_SOURCE_IMAGES = 16;

function safeFileName(name) {
  const base = basename(String(name ?? ''));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'image.png';
}

async function readSourceImages(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  if (paths.length > MAX_SOURCE_IMAGES) {
    fail(`An edit takes at most ${MAX_SOURCE_IMAGES} source images; ${paths.length} were given.`);
  }
  const sources = [];
  for (const entry of paths) {
    const raw = typeof entry === 'string' ? entry.trim() : '';
    if (!raw) fail('A source image path was empty.');
    const filePath = resolve(raw);

    let info;
    try {
      info = await stat(filePath);
    } catch {
      fail(`Source image not found: ${filePath}`);
    }
    if (!info.isFile()) fail(`Source image is not a file: ${filePath}`);
    if (info.size === 0) fail(`Source image is empty: ${filePath}`);
    if (info.size > MAX_SOURCE_BYTES) {
      fail(`Source image exceeds ${MAX_SOURCE_BYTES / 1024 / 1024}MB: ${filePath}`);
    }
    const bytes = await readFile(filePath);

    const sniffed = sniffImage(bytes);
    if (!sniffed) {
      fail(`Source image is not a PNG, JPEG, WebP, or GIF: ${filePath}`);
    }
    sources.push({ bytes, name: safeFileName(basename(filePath)), mime: sniffed.mime });
  }
  return sources;
}

function encodeMultipart(fields, sources, mask) {
  const boundary = `----dsh-image-generation-${randomUUID()}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields ?? {})) {

    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) fail(`Refusing to encode a field name that could forge a header: ${JSON.stringify(name)}`);

    const text = typeof value === 'string' ? value : String(value);
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`, 'utf8'));
  }
  for (const source of sources ?? []) {

    const { name, mime, bytes } = source ?? {};
    if (typeof name !== 'string' || !name || typeof mime !== 'string' || !mime || !Buffer.isBuffer(bytes)) {
      fail(
        `A source image part needs a file name, a content type, and byte content; got ${JSON.stringify({
          name: typeof name === 'string' ? name : null,
          mime: typeof mime === 'string' ? mime : null,
          bytes: Buffer.isBuffer(bytes) ? 'bytes' : null,
        })}.`,
      );
    }
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`, 'utf8'),
      bytes,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  if (mask) {

    const { name, mime, bytes } = mask;
    if (typeof name !== 'string' || !name || typeof mime !== 'string' || !mime || !Buffer.isBuffer(bytes)) {
      fail(
        `A mask part needs a file name, a content type, and byte content; got ${JSON.stringify({
          name: typeof name === 'string' ? name : null,
          mime: typeof mime === 'string' ? mime : null,
          bytes: Buffer.isBuffer(bytes) ? 'bytes' : null,
        })}.`,
      );
    }
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mask"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`, 'utf8'),
      bytes,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function apiError(body, status) {
  const error = body?.error;
  if (typeof error === 'string' && error) return `Image API answered HTTP ${status}: ${error}`;
  const message = error?.message ?? body?.message;
  if (typeof message === 'string' && message) {
    const code = error?.code;
    const detail = typeof code === 'string' && code ? `${message} (${code})` : message;
    return `Image API answered HTTP ${status}: ${detail}`;
  }
  return `Image API answered HTTP ${status}`;
}

function printableHead(text, max) {
  return [...String(text).slice(0, max)].map((char) => (/[\t\n\r\x20-\x7e]/.test(char) ? char : '·')).join('');
}

const IMAGE_SIGNATURES = [
  { format: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'webp', mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], alsoAt: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { format: 'gif', mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

const EXTENSION_BY_FORMAT = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };

function sniffImage(bytes) {
  for (const signature of IMAGE_SIGNATURES) {
    const { bytes: head, alsoAt } = signature;
    if (head.some((byte, index) => bytes[index] !== byte)) continue;
    if (alsoAt && alsoAt.bytes.some((byte, index) => bytes[alsoAt.offset + index] !== byte)) continue;
    return { format: signature.format, mime: signature.mime };
  }
  return null;
}

export function decodeImage(base64, label) {
  const text = String(base64 ?? '').replace(/\s+/g, '');
  if (!text) fail(`${label} arrived without base64 data. Try again, or switch the gateway model.`);

  if (text.length > MAX_BASE64_CHARS) {
    fail(`${label} is ${text.length} base64 characters, far past the ${MAX_IMAGE_BYTES / 1024 / 1024}MB this plugin will write.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail(`${label} is not valid base64; the gateway answered in an unexpected encoding.`);
  const bytes = Buffer.from(text, 'base64');
  if (bytes.byteLength === 0) fail(`${label} decoded to zero bytes.`);
  if (bytes.byteLength > MAX_IMAGE_BYTES) fail(`${label} exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`);
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    fail(`${label} did not decode to a PNG, JPEG, WebP, or GIF; the first bytes were ${printableHead(bytes.subarray(0, 16).toString('latin1'), 16)}.`);
  }
  return { bytes, ...sniffed };
}

function slug(text, limit) {
  const cleaned = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, limit) || 'image';
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);
const MAX_ATTEMPTS = 3;

function parseRetryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_WAIT_MS) : null;
}

async function postGeneration(url, apiKey, payload, signal) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': payload.contentType },
      body: payload.body,
      signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {

    }
    return { ok: response.ok, status: response.status, body: parsed, text, retryAfter: parseRetryAfter(response.headers) };
  } catch (error) {

    return { ok: false, status: 0, body: null, text: String(error?.message ?? error), transport: true };
  }
}

async function callImageApi(config, payload, signal) {
  if (!config.apiUrl) fail('No API URL is configured. Set it in Settings, Image generation.');
  if (!config.secret) fail('No API key is configured. Set it in Settings, Image generation.');

  if (signal?.aborted) {
    fail('This call was cancelled before the request was sent, so no generation was started.');
  }

  const base = config.apiUrl.replace(/\/+$/, '');
  const url = `${base}${payload.endpoint}`;
  const timeoutMs = Math.max(30, config.requestTimeoutSec || 600) * 1000;
  const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {

    if (attempt > 1 && signal?.aborted) break;
    const result = await postGeneration(url, config.secret, payload, attemptSignal);
    last = result;

    if (result.ok) {

      if (result.body?.error) fail(apiError(result.body, result.status));
      if (result.body === null) {
        fail(`Image API answered HTTP ${result.status} with a non-JSON body: ${printableHead(result.text, 300)}`);
      }
      if (!Array.isArray(result.body.data)) {
        fail(`Image API returned no data array. Response head: ${printableHead(result.text, 300)}`);
      }
      return { data: result.body.data, usage: result.body.usage ?? null };
    }

    const retryable = result.transport || RETRYABLE_STATUS.has(result.status);
    if (!retryable || attempt === MAX_ATTEMPTS) break;
    if (signal?.aborted) break;

    const wait = result.retryAfter ?? 400 * 3 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  if (signal?.aborted) {
    fail('Image generation was cancelled before the endpoint answered.');
  }
  if (last.transport) fail(`Could not reach the image endpoint at ${url}: ${last.text}`);
  fail(apiError(last.body ?? last.text, last.status));
}

const servedFiles = new Map();
const SERVED_FILE_LIMIT = 500;

let servedIndexOrder = [];

export function resolveOutputDir(config, location, workspace) {
  const requested = String(location ?? '').trim();
  if (!requested) {
    return workspace && !config.outputDir ? resolve(workspace) : outputDirOf(config);
  }
  return isAbsolute(requested)
    ? normalize(requested)
    : resolve(workspace ?? outputDirOf(config), requested);
}

export const FILE_NAME_TOKENS = ['{time}', '{prompt}', '{index}', '{uniq}'];
const DEFAULT_FILE_NAME_PATTERN = '{time}-{prompt}';

const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

const MAX_STEM_CHARS = 120;

export function applyNamePattern(pattern, { prompt, index }) {
  const source = String(pattern ?? '').trim() || DEFAULT_FILE_NAME_PATTERN;
  const slugged = slug(prompt, 60);
  const rendered = source
    .replaceAll('{time}', stamp())
    .replaceAll('{prompt}', slugged)
    .replaceAll('{index}', String(index))
    .replaceAll('{uniq}', randomUUID().slice(0, 8))
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '');

  const base = (rendered || slugged || 'image').slice(0, MAX_STEM_CHARS).replace(/[-.\s]+$/g, '');
  const safe = base || 'image';
  return RESERVED_DEVICE_NAME.test(safe) ? `${safe}-image` : safe;
}

const NAME_COLLISION = new Set(['EEXIST', 'EACCES']);

async function writeExclusive(dir, stem, extension, bytes) {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? stem : `${stem}-${attempt}`;
    const filePath = join(dir, `${name}.${extension}`);
    try {
      await writeFile(filePath, bytes, { flag: 'wx' });
      return filePath;
    } catch (error) {
      if (!NAME_COLLISION.has(error?.code)) throw error;
    }
  }
  return fail(`Could not find a free file name for "${stem}" after ${MAX_NAME_ATTEMPTS} attempts in ${dir}.`);
}

async function persistImages(config, data, prompt, outputDir) {
  await mkdir(outputDir, { recursive: true });

  const images = [];
  for (const [index, item] of data.entries()) {
    const label = `Image ${index + 1}`;
    const { bytes, format, mime } = decodeImage(item?.b64_json ?? item?.b64Json, label);

    const extension = EXTENSION_BY_FORMAT[format] ?? EXTENSION_BY_FORMAT[config.outputFormat] ?? 'png';

    const stem = applyNamePattern(config.fileNameFormat, { prompt, index: index + 1 });
    const filePath = await writeExclusive(outputDir, stem, extension, bytes);

    rememberFile(filePath);
    const revised = typeof item?.revised_prompt === 'string' && item.revised_prompt ? item.revised_prompt : undefined;

    images.push({
      index: index + 1,
      path: filePath,
      url: `${IMAGE_ROUTE}/${encodeURIComponent(basename(filePath))}`,
      bytes: bytes.byteLength,
      mime,
      ...(revised === undefined ? {} : { revisedPrompt: revised }),
    });
  }
  return images;
}

async function generate(params, config, exec) {
  const prompt = String(params.prompt ?? '').trim();
  if (!prompt) throw new Error('A prompt is required.');
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`The prompt must stay under ${MAX_PROMPT_CHARS} characters.`);

  const count = Number(params.count ?? config.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error('count must be an integer between 1 and 10.');
  }

  const requested = String(params.resolution ?? '').trim();
  const configuredDefault = config.defaultResolution === 'auto' ? 'auto' : parseSize(config.defaultResolution, config);
  const size = !requested || requested === 'auto' ? configuredDefault : parseSize(requested, config);

  const askedQuality = String(params.quality ?? '').trim().toLowerCase();
  if (askedQuality && !QUALITIES.includes(askedQuality)) {
    throw new Error(`"${params.quality}" is not an available quality. Use one of: ${QUALITIES.join(', ')}.`);
  }
  const quality = askedQuality || DEFAULT_QUALITY;

  const background = normalizeBackground(params.background, config);
  const workspace = exec?.agent?.session?.header?.cwd;

  rememberWorkspace(workspace);
  const outputDir = resolveOutputDir(config, params.location, workspace);

  const sourcePaths = normalizeSourcePaths(params.images ?? params.image);

  const sources = await readSourceImages(sourcePaths);
  const mask = params.mask ? (await readSourceImages([params.mask]))[0] : null;
  if (mask && sources.length !== 1) {
    fail(`A mask applies to exactly one source image; ${sources.length} were given.`);
  }

  const payload = sources.length
    ? (() => {
        const { fields } = buildEditForm(config, prompt, size, count, background, quality, sources);
        const encoded = encodeMultipart(fields, sources, mask);
        return { endpoint: '/images/edits', ...encoded };
      })()
    : (() => {
        const body = JSON.stringify(buildBody(config, prompt, size, count, background, quality));
        return { endpoint: '/images/generations', body, contentType: 'application/json' };
      })();

  const { data, usage } = await callImageApi(config, payload, exec.signal);
  const images = await persistImages(config, data, prompt, outputDir);

  return {
    images,
    savedTo: outputDir,
    model: config.model,
    size,
    quality,
    background,
    requested: count,
    returned: images.length,

    ...(Number.isFinite(usage?.total_tokens) ? { usageTokens: usage.total_tokens } : {}),
  };
}

export function toolText(value) {
  const paths = value.images.map((image) => `${image.index}. ${image.path}`);
  return [
    `Generated ${value.returned} image${value.returned === 1 ? '' : 's'} with ${value.model} (${value.size}, quality ${value.quality}, background ${value.background}), written to ${value.savedTo}.`,
    ...paths,
  ].join('\n');
}

const decodeMeta = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const contentType = (fileName) =>
  fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')
    ? 'image/jpeg'
    : fileName.endsWith('.webp')
      ? 'image/webp'
      : 'image/png';

const SERVED_INDEX_LIMIT = 2000;

function servedIndexPath() {
  return join(DEFAULT_OUTPUT_DIR, 'served-index.json');
}

function readServedIndex() {
  try {
    const raw = readFileSync(servedIndexPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.entries(parsed)
      .filter(([name, target]) => typeof name === 'string' && typeof target === 'string')
      .slice(-SERVED_INDEX_LIMIT);
  } catch {

    return [];
  }
}

function writeServedIndex(entries) {
  try {
    mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });
    const record = {};
    for (const [name, target] of entries.slice(-SERVED_INDEX_LIMIT)) record[name] = target;
    writeFileSync(servedIndexPath(), `${JSON.stringify(record, null, 0)}\n`, 'utf8');
  } catch {

  }
}

const BACKFILL_MAX_DEPTH = 3;
const BACKFILL_MAX_FILES = 500;

async function backfillIndexFrom(root) {
  if (!root || typeof root !== 'string') return 0;
  const found = new Map();
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && found.size < BACKFILL_MAX_FILES) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.size >= BACKFILL_MAX_FILES) break;
      const target = join(dir, entry.name);
      if (entry.isDirectory()) {

        if (depth >= BACKFILL_MAX_DEPTH) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        queue.push({ dir: target, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-.+\.(png|jpg|webp|gif)$/i.test(entry.name)) continue;
      found.set(entry.name, target);
    }
  }
  if (found.size === 0) return 0;
  const known = new Map(readServedIndex());
  let added = 0;
  for (const [name, target] of found) {
    if (known.has(name)) continue;
    known.set(name, target);
    added += 1;
  }
  if (added > 0) writeServedIndex([...known.entries()]);
  return added;
}

function rememberFile(filePath) {
  const name = basename(filePath);
  const paths = servedFiles.get(name) ?? [];
  const withoutDuplicate = paths.filter((candidate) => candidate !== filePath);
  withoutDuplicate.push(filePath);
  servedFiles.set(name, withoutDuplicate);
  servedIndexOrder = servedIndexOrder.filter((candidate) => candidate !== filePath);
  servedIndexOrder.push(filePath);
  while (servedFiles.size > SERVED_FILE_LIMIT) {
    servedFiles.delete(servedFiles.keys().next().value);
  }
  if (servedIndexOrder.length > SERVED_INDEX_LIMIT) servedIndexOrder = servedIndexOrder.slice(-SERVED_INDEX_LIMIT);
  writeServedIndex(servedIndexOrder.map((entry) => [basename(entry), entry]));
}

function rememberedPaths(fileName) {
  const live = [...(servedFiles.get(fileName) ?? [])].reverse();
  const persisted = readServedIndex()
    .filter(([name]) => name === fileName)
    .map(([, target]) => target)
    .reverse();
  return [...new Set([...live, ...persisted])];
}

export function indexPathForTests() {
  return servedIndexPath();
}

export function rememberWorkspaceForTests(cwd) {
  rememberWorkspace(cwd);
}

export function serveImageForTests(req, res, config) {
  return serveImage(req, res, config);
}

export function clearServedIndex() {
  const before = readServedIndex().length + servedFiles.size;
  servedFiles.clear();
  servedIndexOrder = [];
  let removed = false;
  try {
    rmSync(servedIndexPath(), { force: true });
    removed = true;
  } catch {
    removed = false;
  }
  return { cleared: before, indexRemoved: removed };
}

export const RECORDS_ROUTE = '/dsh-image-generation/records';
const RECORDS_HEADER = 'x-dsh-image-generation-action';

async function handleRecords(req, res) {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' }).end('{"error":"method not allowed"}');
    return;
  }
  if (req.headers?.[RECORDS_HEADER] !== 'clear-records') {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }).end('{"error":"missing action header"}');
    return;
  }
  try {
    const result = clearServedIndex();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
  } catch (error) {

    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({ error: String(error?.message ?? error) }),
    );
  }
}

export function forgetInMemoryFilesForTests() {
  servedFiles.clear();
  servedIndexOrder = [];
}

export function rememberFileForTests(filePath) {
  rememberFile(filePath);
}

const recentWorkspaces = new Set();
const MAX_RECENT_WORKSPACES = 20;

function rememberWorkspace(cwd) {
  if (typeof cwd !== 'string' || !cwd) return;
  recentWorkspaces.delete(cwd);
  recentWorkspaces.add(cwd);
  while (recentWorkspaces.size > MAX_RECENT_WORKSPACES) {
    recentWorkspaces.delete(recentWorkspaces.values().next().value);
  }
}

const WORKSPACE_SCAN_DEPTH = 2;
const WORKSPACE_SCAN_LIMIT = 4000;

const WORKSPACE_SCAN_BUDGET_MS = 60;
const PLUGIN_FRAME_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-.+\.(png|jpg|webp|gif)$/i;

const OUTPUT_HINT = /^(out|output|outputs|images?|frames?|shots?|assets|generated|exports?|png|webp)$/i;

async function findByBasename(root, fileName) {
  const deadline = Date.now() + WORKSPACE_SCAN_BUDGET_MS;
  let level = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (level.length > 0 && seen < WORKSPACE_SCAN_LIMIT && Date.now() < deadline) {
    const next = [];
    for (const { dir, depth } of level) {
      if (Date.now() >= deadline) break;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        seen += 1;
        if (seen > WORKSPACE_SCAN_LIMIT) break;
        if (entry.isFile()) {
          if (entry.name === fileName) return join(dir, entry.name);
          continue;
        }
        if (entry.isDirectory() && depth < WORKSPACE_SCAN_DEPTH && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          next.push({ dir: join(dir, entry.name), depth: depth + 1, hinted: OUTPUT_HINT.test(entry.name) ? 0 : 1 });
        }
      }
    }

    next.sort((a, b) => a.hinted - b.hinted);
    level = next;
  }
  return null;
}

async function serveImage(req, res, config) {

  let fileName;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    fileName = basename(decodeURIComponent(url.pathname.slice(ROUTE_SEGMENT.length)));
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (!fileName || fileName.includes('..')) {
    res.writeHead(400).end('bad request');
    return;
  }

  const workspaces = [...recentWorkspaces].reverse();
  const roots = [...new Set([resolve(DEFAULT_OUTPUT_DIR), outputDirOf(config)])];

  const remembered = rememberedPaths(fileName);

  const scanBases = [...new Set([...roots, ...workspaces])];

  const scanned = PLUGIN_FRAME_NAME.test(fileName) ? scanBases.map((dir) => resolve(dir, fileName)) : [];
  for (const candidate of [...remembered, ...scanned]) {
    if (!candidate) continue;
    try {
      const bytes = await readFile(candidate);

      if (!remembered.includes(candidate)) rememberFile(candidate);
      res.writeHead(200, {
        'content-type': contentType(fileName),
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, max-age=31536000, immutable',
      });
      res.end(bytes);
      return;
    } catch {
      continue;
    }
  }

  if (PLUGIN_FRAME_NAME.test(fileName)) {
    for (const workspace of workspaces) {
      const found = await findByBasename(workspace, fileName);
      if (!found) continue;
      try {
        const bytes = await readFile(found);

        rememberFile(found);
        res.writeHead(200, {
          'content-type': contentType(fileName),
          'content-length': String(bytes.byteLength),
          'cache-control': 'private, max-age=31536000, immutable',
        });
        res.end(bytes);
        return;
      } catch {
        continue;
      }
    }
  }
  res.writeHead(404, { 'cache-control': 'no-store' }).end('not found');
}

export function apply(ctx, config) {
  const readConfig = () => effectiveConfig(config);

  ctx.effect(() => ctx.inject(['webServer'], (scope) => scope.webServer.register({
    kind: 'prefix',
    path: IMAGE_ROUTE,
    handler: (req, res) => serveImage(req, res, readConfig()),
  })));

  ctx.effect(() => ctx.inject(['webServer'], (scope) => scope.webServer.register({
    kind: 'exact',
    path: RECORDS_ROUTE,
    handler: (req, res) => handleRecords(req, res),
  })));

  ctx.effect(() => {
    const presets = presetSizes(readConfig());

    const workspace = process.env.DSH_WORKSPACE || process.cwd();
    backfillIndexFrom(workspace).catch(() => {});
    return ctx.tools.register(defineTool({
      name: 'generate_image',
      description: [
        'Generate one or more images from a prompt, save them to disk, and return their absolute paths. Show them with present, or read one back with read_image.',
        'Write the prompt as ordinary language that says what the picture is for and what it must contain. Do not use weight syntax, quality tags, or parameter flags, and do not pad it with style adjectives: this model reads intent well and has its own taste.',
        'What it is good at: posters, knowledge cards, knowledge maps, infographics, charts, slides, UI mockups, and multi-panel sheets with correct text and real layout; photorealistic people, places, products, food, interiors, and everyday scenes; illustrations and plain scenes; and game or image assets such as sprites, sprite sheets, tilesets, icons, item and character art, textures, and UI elements, on a transparent background when the asset needs one.',
        'Use one call with count for variations of one image. Use separate calls when the frames or the content differ.',
        'A custom frame must satisfy the endpoint exactly: every side a multiple of 16, the longest edge within the cap, 655,360 to 8,294,400 pixels total, and a ratio no wider than 3:1.',
        'Files land in the session workspace unless location points somewhere else. Settings, Image generation owns the endpoint, credentials, model, and output format. Resolution, quality, count, background, location, and the source images are per-call arguments.',
        'Passing images turns this from a generation into an edit: the source pictures are sent to the endpoint as the basis of the result, and the prompt describes the change rather than the whole scene.',
      ].join(' '),
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description:
            "What to make, in ordinary language. Everything the caller specified must survive into this prompt verbatim: the exact text that must appear, names, numbers, and any style they named. Everything else is yours to decide: composition, palette, and finish. Quote every string that must be readable in the image, and say where it sits and how it is set; this model renders the characters it is given. For a poster, card, infographic, or knowledge map, lead with the format and the count of sections, panels, or rows, then say what each one holds. When several images must share a look or a subject, say so in each prompt and name what stays fixed.",
        },
        resolution: {
          type: 'string',
          description: `Output frame, written as WIDTHxHEIGHT, or "auto" to let the model choose a fitting ratio. Omit the parameter to inherit the configured default. The endpoint accepts a custom size when every side is a multiple of 16, the longest edge is at most ${readConfig().maxEdge}, the total is between 655,360 and 8,294,400 pixels, and the ratio is no wider than 3:1. Ready-made sizes that pass: ${presets.join(', ')}.`,
        },
        quality: {
          type: 'string',
          enum: QUALITIES,
          description: `Render quality, lowest effort first: ${QUALITIES.join(', ')}. Omit to use ${DEFAULT_QUALITY}.`,
        },
        count: {
          type: 'integer',
          description:
            'How many images to generate in this call, 1 to 10. Use it for variations of one prompt. Omit to use the configured default.',
        },
        background: {
          type: 'string',
          enum: BACKGROUNDS,
          description:
            'auto keeps the model default, transparent leaves no background and needs png or webp output (use it for an asset meant to be dropped onto another surface), opaque fills it.',
        },
        location: {
          type: 'string',
          description:
            'Where to write the files. Omit it to use the session workspace; a relative path resolves against the workspace, and an absolute path is taken as given. The directory is created when it does not exist. Point this at the project folder the images belong to rather than leaving loose files in the workspace root when a call belongs to one.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Source images to edit, as file paths. Giving one or more switches the call to the edit endpoint, where these pictures are the basis of the result and the prompt describes the change: "replace the background with a plain studio wall", "make the fur ginger", "add a red scarf". A path may be absolute or relative to the session workspace. At most 16 images, 50MB each. Omit this entirely and the call is a generation from the prompt alone, which is the right tool when there is nothing to edit.',
        },
        mask: {
          type: 'string',
          description:
            'Optional PNG that marks the region to change, used with exactly one source image in images. Transparent pixels are the area the model is free to repaint and opaque pixels are kept, so it must be the same size as the source and have an alpha channel. Omit it to let the model decide what to change across the whole image.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            images: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'integer', required: true },
                  path: { type: 'string', required: true },
                  url: { type: 'string', required: true },
                  bytes: { type: 'integer', required: true },
                  mime: { type: 'string', required: true },
                  revisedPrompt: { type: 'string' },
                },
              },
            },
            model: { type: 'string', required: true },
            savedTo: { type: 'string', required: true },
            size: { type: 'string', required: true },
            quality: { type: 'string', required: true },
            background: { type: 'string', required: true },
            requested: { type: 'integer', required: true },
            returned: { type: 'integer', required: true },
            usageTokens: { type: 'integer' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: toolText(value) }],
        presentationMeta: (_args, value) => ({
          title: `Generated ${value.returned} image${value.returned === 1 ? '' : 's'}`,
          summary: `${value.model} · ${value.size} · quality ${value.quality} · ${value.background}`,
          savedTo: value.savedTo,
          images: value.images.map((image) => ({
            url: image.url,
            path: image.path,
            bytes: image.bytes,
          })),
        }),
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Generate image: ${String(args.prompt ?? '').slice(0, 80)}`,
        kind: 'other',
      }),
      presentResult: (_args, result) => {
        if (result.isError) return undefined;
        const meta = decodeMeta(result.meta);
        if (!meta || !Array.isArray(meta.images)) return undefined;
        const lines = meta.images.map((image) => `${image.path} (${Math.round(image.bytes / 1024)} KB)`);
        const heading = meta.savedTo ? `${meta.summary} · written to ${meta.savedTo}` : meta.summary;
        return {
          card: 'generic',
          title: meta.title,
          content: [{ type: 'text', text: [heading, ...lines].join('\n') }],
        };
      },
      execute: (args, exec) => generate(args, readConfig(), exec),
    }));
  });
}

export { BACKGROUNDS, backfillIndexFrom, buildBody, buildEditForm, effectiveConfig, encodeMultipart, normalizeBackground, normalizeSourcePaths, readSourceImages, safeFileName };
