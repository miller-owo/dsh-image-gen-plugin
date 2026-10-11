import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

const roots = [process.env.DSH_PACKAGE_ROOT].filter(Boolean);
const targets = { schemastery: 'lib/index.mjs', 'dsh-tools': 'lib/index.js' };

register(
  `data:text/javascript;base64,${Buffer.from(`
    import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const roots = ${JSON.stringify(roots)};
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

const host = await import('./index.js');

let registered;
host.apply(
  {
    effect: (fn) => fn(),
    inject: () => {},
    tools: { register: (definition) => ((registered = definition), () => {}) },
  },
  host.Config({}),
);

const width = process.stdout.columns ?? 100;
const rule = (char) => char.repeat(Math.min(width, 100));
const wrap = (text) => {
  const limit = Math.min(width, 100);
  const lines = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if ((line + word).length + 1 > limit) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
};

console.log(rule('='));
console.log('TOOL NAME');
console.log(rule('='));
console.log(registered.name);
console.log();
console.log(rule('='));
console.log('TOOL DESCRIPTION (as one paragraph, exactly what the model reads)');
console.log(rule('='));
console.log(wrap(registered.description));
console.log();
console.log(rule('='));
console.log('PARAMETERS');
console.log(rule('='));
for (const [key, field] of Object.entries(registered.parameters.properties)) {
  const required = registered.parameters.required?.includes(key) ? ' [required]' : ' [optional]';
  const kind = field.enum ? `enum(${field.enum.join('|')})` : field.type;
  console.log(`\n${key}${required}  ${kind}`);
  console.log(wrap(field.description));
}
console.log();
console.log(rule('='));
console.log('WHAT A CALL RETURNS (render projection)');
console.log(rule('='));
console.log(wrap(registered.output.render({ prompt: 'x' }, {
  images: [
    { index: 1, path: 'D:\\out\\a.png', url: '/u/a.png', bytes: 1536000, mime: 'image/png', revisedPrompt: null },
    { index: 2, path: 'D:\\out\\b.png', url: '/u/b.png', bytes: 1540000, mime: 'image/png', revisedPrompt: null },
  ],
  model: 'gpt-image-2.5-flare',
  size: '1536x864',
  quality: 'high',
  background: 'auto',
  requested: 2,
  returned: 2,
  usageTokens: 4100,
})[0].text));
