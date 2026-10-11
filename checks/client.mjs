import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
globalThis.document = { documentElement: { getAttribute: () => null } };

let activeLocale = 'zh-CN';
const localeListeners = new Set();

const registeredDictionaries = [];
const localeService = {
  getSnapshot: () => ({ active: activeLocale }),
  subscribe: (listener) => {
    localeListeners.add(listener);
    return () => localeListeners.delete(listener);
  },
  register: (namespace, dict) => {
    registeredDictionaries.push({ namespace, dict });
    return () => {};
  },
};
const setLocale = (next) => {
  activeLocale = next;
  for (const listener of [...localeListeners]) listener();
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (descriptor) => (captured = descriptor) } };

let hooks = [];
let cursor = 0;
let effects = [];

const renderComponent = (type, props, children) => {
  if (typeof type !== 'function') return { type, props: { ...(props ?? {}), children }, children };
  const withChildren = { ...(props ?? {}) };
  if (children !== undefined) withChildren.children = children;

  if (type.prototype && typeof type.prototype.render === 'function') {
    const instance = new type(withChildren);
    instance.props = withChildren;
    instance.state = instance.state ?? {};
    const parent = cursor;
    cursor = 0;
    try {
      const rendered = instance.render();
      cursor = parent;
      return rendered;
    } catch (error) {
      if (typeof type.getDerivedStateFromError !== 'function') {
        cursor = parent;
        throw error;
      }
      instance.state = { ...instance.state, ...type.getDerivedStateFromError(error) };
      const rendered = instance.render();
      cursor = parent;
      return rendered;
    }
  }

  const parent = cursor;
  cursor = 0;
  const rendered = type(withChildren);
  cursor = parent;
  return Array.isArray(rendered) ? { type: 'fragment', props: { children: rendered }, children: rendered } : rendered;
};

const react = {
  createElement: (type, props, ...children) =>
    renderComponent(type, props, children.length === 0 ? props?.children : children.length === 1 ? children[0] : children),
  useState: (initial) => {
    const slot = cursor++;
    if (hooks[slot] === undefined) hooks[slot] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks[slot],
      (next) => {
        hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next;
      },
    ];
  },
  useEffect: (fn) => effects.push(fn),

  useLayoutEffect: (fn) => effects.push(fn),
  useCallback: (fn) => fn,

  useRef: (initial) => ({ current: initial }),

  Component: class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
  },
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
new Function('window', source)(globalThis.window);

const results = [];
const check = async (label, fn) => {
  try {
    await fn();
    results.push(`ok   ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`);
  }
};

const plugin = captured.factory((id) => {
  if (id === 'react') return react;
  throw new Error(`unexpected require(${id})`);
});

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (!node || typeof node !== 'object') return;
  visit(node);
  const rendered = node.props?.children;
  if (Array.isArray(rendered)) rendered.forEach((child) => walk(child, visit));
  else if (rendered && typeof rendered === 'object') walk(rendered, visit);
};

const pump = () => new Promise((resolve) => setTimeout(resolve, 0));

const registrations = [];
const injections = [];
const mutations = [];
const describeValue = {
  writable: true,
  namespaces: [
    {
      ns: 'dsh-image-generation',
      revision: 7,
      value: {
        apiUrl: 'https://api.example/v1',
        // The key arrives as an ordinary field now. It used to be withheld by role('secret'),
        // which is what left the settings page unable to show or copy it.
        secret: 'sk-test',
        model: 'gpt-image-2',
        quality: 'high',
        count: 2,
        outputFormat: 'png',
        outputCompression: 90,
        background: 'opaque',
        moderation: 'auto',
        user: '',
        outputDir: 'D:\\shots',
        requestTimeoutSec: 300,
      },
    },
  ],
};

const settingsApi = {
  describe: async () => ({ ok: true, value: describeValue }),
  mutate: async (ns, ops, revision) => {
    mutations.push({ ns, ops, revision });
    return {
      ok: true,
      value: { ns, revision: revision + 1, value: describeValue.namespaces[0].value, secrets: describeValue.namespaces[0].secrets },
    };
  },
};

plugin.apply({
  locale: localeService,
  remote: { settings: settingsApi },
  effect: (fn) => fn(),
  slots: {
    inject: (name, callback) => {
      injections.push(name);
      return callback();
    },
    register: (descriptor, component) => {
      registrations.push({ descriptor, component });
      return () => {};
    },
  },
});

const section = registrations.find((row) => row.descriptor.name === 'settings.section').component;
const toolView = registrations.find((row) => row.descriptor.name === 'tool.call.toolview').component;

const toolViewRow = registrations.find((row) => row.descriptor.name === 'tool.call.toolview');
const injectDecl = toolViewRow?.descriptor?.inject;

await check('the toolview declares its injection face the way the seat expects', () => {

  if (typeof injectDecl !== 'function') {
    throw new Error(`inject must be a factory, got ${injectDecl === undefined ? 'undefined' : typeof injectDecl}`);
  }
  const face = injectDecl();
  if (!face || typeof face !== 'object' || Array.isArray(face)) throw new Error('the factory did not return a face object');
  if (typeof face.hooks?.toolCallArgumentsPartial !== 'function') throw new Error('the face lost the arguments hook');
});

const partialFactory = typeof injectDecl === 'function' ? injectDecl().hooks.toolCallArgumentsPartial : null;

await check('the injected arguments hook follows its contract', () => {
  if (typeof partialFactory !== 'function') throw new Error('the streaming-arguments hook was not injected');

  const hook = partialFactory({}, {});
  if (typeof hook !== 'function') throw new Error('the factory did not return a Hook');
  if (hook() !== '') throw new Error('a missing assistant source did not read as empty');

  const blocks = [{ kind: 'tool-call', callId: 'c1', argsRaw: '{"prompt":"live' }];
  const bound = partialFactory({}, { callId: 'c1', assistant: { subscribe: () => () => {}, getSnapshot: () => ({ blocks }) } });
  if (bound() !== '{"prompt":"live') throw new Error('the streaming prefix was not read');
  const other = partialFactory({}, { callId: 'nope', assistant: { subscribe: () => () => {}, getSnapshot: () => ({ blocks }) } });
  if (other() !== '') throw new Error("another call's arguments leaked in");
});

await check('a snapshot without blocks degrades instead of throwing', () => {

  const shapes = [
    { getSnapshot: () => ({}) },
    { getSnapshot: () => ({ blocks: null }) },
    { getSnapshot: () => ({ blocks: 'nope' }) },
    { getSnapshot: () => undefined },
    {
      getSnapshot: () => {
        throw new Error('snapshot blew up');
      },
    },
  ];
  for (const assistant of shapes) {
    const bound = partialFactory({}, { callId: 'c1', assistant: { subscribe: () => () => {}, ...assistant } });
    if (bound() !== '') throw new Error(`a bad snapshot shape did not degrade: ${JSON.stringify(assistant.getSnapshot?.() ?? null)}`);
  }
});

const mount = () => {
  hooks = [];
  cursor = 0;
  effects = [];
  const tree = section({ close: () => {} });
  const pending = effects;
  effects = [];
  pending.forEach((effect) => effect());
  return tree;
};

const rerender = () => {
  cursor = 0;
  effects = [];
  const tree = section({ close: () => {} });
  const pending = effects;
  effects = [];
  pending.forEach((effect) => effect());
  return tree;
};

let tree = mount();
const settle = async (rounds = 4) => {
  for (let round = 0; round < rounds; round += 1) {
    await pump();
    tree = rerender();
  }
  return tree;
};

const findAllByType = (type, extra = {}) => {
  const found = [];
  walk(tree, (node) => {
    if (node.type !== type) return;
    for (const [key, value] of Object.entries(extra)) if (node.props?.[key] !== value) return;
    found.push(node);
  });
  return found;
};

const findByType = (type, extra = {}) => {
  let found = null;
  walk(tree, (node) => {
    if (node.type !== type) return;
    for (const [key, value] of Object.entries(extra)) if (node.props?.[key] !== value) return;
    found = node;
  });
  return found;
};

const findByText = (text) => {
  let found = null;
  walk(tree, (node) => {
    if ((node.children ?? []).includes(text)) found = node;
  });
  return found;
};

await check('the module registers itself under the package id', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (captured.id !== manifest.name) throw new Error(`${captured.id} != ${manifest.name}`);
});

await check('the plugin injects both slots', () => {
  if (injections.join(',') !== 'settings.section,tool.call.toolview') throw new Error(injections.join(','));
});

await check('the plugin declares the services it reaches for', () => {

  for (const service of ['slots', 'locale', 'remote', 'remote.settings']) {
    if (!plugin.inject.includes(service)) throw new Error(`missing inject entry: ${service}`);
  }
});

await check('the settings section takes its own id after Models', () => {
  const descriptor = registrations.find((row) => row.descriptor.name === 'settings.section').descriptor;
  if (descriptor.id !== 'image-generation') throw new Error(descriptor.id);
  if (descriptor.order !== 13) throw new Error(String(descriptor.order));
  if (descriptor.label() !== '图片生成') throw new Error(descriptor.label());
});

await check('the tool card claims the generate_image key', () => {
  if (registrations.find((row) => row.descriptor.name === 'tool.call.toolview').descriptor.key !== 'generate_image') {
    throw new Error('wrong key');
  }
});

await check('the first paint shows the loading line in the document language', () => {
  if (!JSON.stringify(tree).includes('正在读取设置')) throw new Error('missing loading line');
});

await check('the form renders the stored values once describe resolves', async () => {
  await settle();
  const text = JSON.stringify(tree);
  if (!text.includes('图片生成')) throw new Error('title missing');
  if (!text.includes('gpt-image-2')) throw new Error('model missing');
  if (!text.includes('D:\\\\shots')) throw new Error('outputDir missing');
});

await check('the stored key is shown, masked only until revealed', () => {
  const password = findByType('input', { type: 'password' });
  if (!password) throw new Error('no key field');
  // The value itself is present, so the key can be read back and copied, and it is masked
  // by the input type rather than withheld from the page.
  if (password.props.value !== 'sk-test') throw new Error(`value was "${password.props.value}"`);
  // A show control must exist, and turning it on must switch THIS field to plain text. The
  // lookup is by value, because a bare type:'text' also matches every ordinary input.
  const toggle = findByText('显示');
  if (!toggle) throw new Error('no reveal control');
  toggle.props.onClick();
  tree = rerender();
  const revealed = findAllByType('input').find((node) => node.props.value === 'sk-test' && node.props.type === 'text');
  if (!revealed) {
    const seen = findAllByType('input')
      .filter((node) => String(node.props.value ?? '').startsWith('sk-'))
      .map((node) => `${node.props.type}:${node.props.value}`);
    throw new Error(`the key could not be revealed (${seen.join(', ') || 'no sk- field at all'})`);
  }
  const hide = findByText('隐藏');
  if (!hide) throw new Error('no hide control once revealed');
  hide.props.onClick();
  tree = rerender();
});

await check('png locks the compression slider', () => {
  const slider = findByType('input', { type: 'range' });
  if (!slider) throw new Error('no slider');
  if (slider.props.disabled !== true) throw new Error('slider stayed enabled');
});

await check('saving restates every field, the key included', async () => {
  mutations.length = 0;
  const save = findByText('保存');
  if (!save) throw new Error('no save button');
  await save.props.onClick();
  if (mutations.length !== 1) throw new Error(`mutate ran ${mutations.length} times`);
  const { ns, ops, revision } = mutations[0];
  if (ns !== 'dsh-image-generation') throw new Error(ns);
  if (revision !== 7) throw new Error(`revision ${revision}`);
  const fields = ops.map((op) => op.path[0]);
  // The key is written like any other field now. It was previously withheld, which is what
  // made a saved key impossible to read back from this page.
  if (!fields.includes('secret')) throw new Error('the key was withheld from the write');
  const secret = ops.find((op) => op.path[0] === 'secret');
  if (secret.value !== 'sk-test') throw new Error(`the key was written as "${secret.value}"`);
  if (!fields.includes('apiUrl')) throw new Error('apiUrl was not saved');
  if (!fields.includes('outputFormat')) throw new Error('outputFormat was not saved');
});

await check('a newly typed key becomes one secret write', async () => {
  tree = mount();
  await settle();
  mutations.length = 0;
  const password = findByType('input', { type: 'password' });
  if (!password) throw new Error('no key field');
  password.props.onChange({ target: { value: 'sk-new' } });
  tree = rerender();
  const save = findByText('保存');
  await save.props.onClick();
  const keyOps = mutations[0].ops.filter((op) => op.path[0] === 'secret');
  if (keyOps.length !== 1) throw new Error(`secret ops ${keyOps.length} in ${JSON.stringify(mutations[0].ops.map((op) => op.path[0]))}`);
  if (keyOps[0].value !== 'sk-new') throw new Error(keyOps[0].value);
});

await check('a successful write reports the saved state', () => {
  // The harness applies state updates on the next render pass, so the message a successful
  // save set is visible only after re-rendering.
  tree = rerender();
  if (!JSON.stringify(tree).includes('已保存')) throw new Error('no saved message');
});

await check('a revision conflict is explained and the form reloads', async () => {
  const original = settingsApi.mutate;
  settingsApi.mutate = async () => {
    throw new Error('settings/conflict');
  };
  tree = mount();
  await settle();
  const save = findByText('保存');
  await save.props.onClick();
  settingsApi.mutate = original;
  tree = rerender();
  if (!JSON.stringify(tree).includes('设置已在别处改动')) throw new Error('conflict was not explained');
});

await check('a missing settings API says so instead of blanking the section', async () => {
  const localRegistrations = [];
  const localPlugin = captured.factory((id) => (id === 'react' ? react : undefined));
  localPlugin.apply({
    locale: localeService,
    remote: {},
    effect: (fn) => fn(),
    slots: {
      inject: (name, callback) => callback(),
      register: (descriptor, component) => {
        localRegistrations.push({ descriptor, component });
        return () => {};
      },
    },
  });
  const local = localRegistrations.find((row) => row.descriptor.name === 'settings.section').component;
  hooks = [];
  cursor = 0;
  effects = [];
  local({ close: () => {} });
  effects.forEach((effect) => effect());
  await pump();
  cursor = 0;
  effects = [];
  const rendered = local({ close: () => {} });
  const text = JSON.stringify(rendered);
  if (!text.includes('取不到设置 API')) throw new Error(text.slice(0, 200));
  if (!text.includes('undefined')) throw new Error('the diagnostic does not report what the probe returned');
});

await check('the filename pattern is editable and its tokens are offered', async () => {
  tree = mount();
  await settle();
  const field = findByType('input', { type: 'text', placeholder: '{time}-{prompt}' });
  if (!field) throw new Error('the filename field is missing');
  if (field.props.value !== '{time}-{prompt}') throw new Error(`value was ${field.props.value}`);
  const text = JSON.stringify(tree);
  for (const token of ['{time}', '{prompt}', '{index}', '{uniq}']) {
    if (!text.includes(token)) throw new Error(`the ${token} token is not offered`);
  }

  field.props.onChange({ target: { value: '{prompt}-{index}' } });
  tree = rerender();
  mutations.length = 0;
  const save = findByText('保存');
  await save.props.onClick();
  const op = mutations[0].ops.find((entry) => entry.path[0] === 'fileNameFormat');
  if (!op) throw new Error('the new pattern was not saved');
  if (op.value !== '{prompt}-{index}') throw new Error(`saved ${op.value}`);
});

await check('the locale service drives the whole section', async () => {
  setLocale('en-US');
  tree = mount();
  await settle(1);
  const text = JSON.stringify(tree);
  if (text.includes('图片生成')) throw new Error('still Chinese after the locale service changed');
  if (!text.includes('Image generation')) throw new Error('missing English title');
  setLocale('zh-CN');
  tree = mount();
  await settle(1);
  if (!JSON.stringify(tree).includes('图片生成')) throw new Error('did not return to Chinese');
});

await check('the label follows the locale service too', () => {
  setLocale('zh-CN');
  if (registrations[0].descriptor.label() !== '图片生成') throw new Error('label is not Chinese');
  setLocale('en-US');
  if (registrations[0].descriptor.label() !== 'Image generation') throw new Error('label is not English');
  setLocale('zh-CN');
});

await check('the sidebar entry and the settings nav read the same label', () => {

  const section = registrations.find((row) => row.descriptor.name === 'settings.section');
  if (typeof section.descriptor.label !== 'function') {
    throw new Error('the label is a frozen string, so it can never follow the locale');
  }
  setLocale('zh-CN');
  const chinese = section.descriptor.label();
  setLocale('en-US');
  const english = section.descriptor.label();
  if (chinese === english) throw new Error('the thunk answers the same text for both locales');
  setLocale('zh-CN');
  if (section.descriptor.label() !== chinese) throw new Error('the thunk does not come back to Chinese');
});

await check('no code path reads the document for the language any more', async () => {

  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  for (const sniff of ['documentElement', 'navigator.language', "getAttribute('lang')"]) {
    if (source.includes(sniff)) throw new Error(`the plugin reads the document for the locale again: ${sniff}`);
  }
});

const renderToolCard = (props) => react.createElement(toolView, props);

const renderCard = (props) => {
  hooks = [];
  cursor = 0;
  effects = [];
  lastCardProps = props;

  tree = renderToolCard(props);
  return tree;
};

const withDisclosure = (initiallyOpen = false) => {
  let open = initiallyOpen;
  return () => ({
    expanded: open,
    setExpanded(value) {
      open = value;
    },
    toggle() {
      open = !open;
    },
  });
};

let lastCardProps = null;
const rerenderCard = () => {
  cursor = 0;
  effects = [];
  tree = renderToolCard(lastCardProps ?? {});
  const pending = effects;
  effects = [];
  for (const effect of pending) effect();
  return tree;
};

const disclosureButton = (node, label) => {
  let found = null;
  walk(node, (entry) => {
    if (entry.type !== 'button') return;
    if (typeof entry.props?.['aria-expanded'] !== 'string') return;
    const children = Array.isArray(entry.props.children) ? entry.props.children : [entry.props.children];
    const text = children.filter((child) => typeof child === 'string').join('');
    if (text.includes(label)) found = entry;
  });
  return found;
};

const openDisclosure = (node, label) => {
  const button = disclosureButton(node, label);
  if (!button) throw new Error(`no disclosure button labelled ${label}`);
  button.props.onClick();
  return rerenderCard();
};

const promptTextOf = (node) => {
  let text = '';
  walk(node, (entry) => {
    if (entry.type !== 'div') return;
    if (entry.props?.style?.whiteSpace !== 'pre-wrap') return;
    const children = entry.props.children;

    text = typeof children === 'string' ? children : (Array.isArray(children) ? children : []).filter((child) => typeof child === 'string').join('');
  });
  return text;
};

const settledCard = (argsRaw, extra = {}) => ({
  phase: 'result',
  block: {
    call: argsRaw === undefined ? null : { name: 'generate_image', argsRaw },
    argsRaw,
    meta: { images: [], ...extra },
  },
});

await check('a settled call reveals the complete prompt, not a segment', () => {

  const long = `${'段落 '.repeat(300)}END-OF-PROMPT`;
  const settled = renderCard({
    ...settledCard(JSON.stringify({ prompt: long })),
    useDisclosure: withDisclosure(true),
  });
  const shown = promptTextOf(settled);
  if (shown !== long) throw new Error(`the settled pane holds ${shown.length} of ${long.length} characters`);
  if (shown.endsWith('…')) throw new Error('the settled pane was trimmed');
  if (!shown.includes('END-OF-PROMPT')) throw new Error('the tail of the prompt is missing');

  let pane = null;
  walk(settled, (node) => {
    if (node.type === 'div' && node.props?.style?.whiteSpace === 'pre-wrap') pane = node;
  });
  if (!pane) throw new Error('the prompt pane did not render');
  if (pane.props.style.maxHeight !== 260) throw new Error('the settled pane lost its height bound');
  if (pane.props.style.overflowY !== 'auto') throw new Error('the settled pane cannot scroll to the rest');
});

await check('the same prompt is live while running and complete when settled', () => {
  const prompt = 'x'.repeat(500);
  const running = renderCard({
    phase: 'preparing',
    block: {},
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => JSON.stringify({ prompt }),
  });

  if (promptTextOf(running) !== prompt) throw new Error('the live pane did not carry the prompt');

  const settled = renderCard({
    ...settledCard(JSON.stringify({ prompt })),
    useDisclosure: withDisclosure(true),
  });
  if (promptTextOf(settled) !== prompt) throw new Error('the settled pane did not show the full prompt');
});

const fakeLayout = (lineOf, text) => {
  let index = 0;
  const textNode = { nodeValue: text };
  const element = {
    firstChild: textNode,
    textContent: text,
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
  };
  element.ownerDocument = {
    createTreeWalker: () => {
      let handed = false;
      return {
        nextNode: () => {
          if (handed) return null;
          handed = true;
          return textNode;
        },
      };
    },
    createRange: () => ({
      setStart() {},
      setEnd() {},
      getBoundingClientRect: () => {

        const line = lineOf(index);
        index += 1;
        return { top: (line - 1) * 20 + 2, bottom: line * 20 - 2, left: 0, right: 10, width: 10, height: 16 };
      },
    }),
  };
  return element;
};

const wrapEvery = (perLine) => (index) => Math.floor(index / perLine) + 1;

const measureLineCutForTests = (() => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function measureLineCut(');
  if (start < 0) throw new Error('measureLineCut is gone from client.js');
  let depth = 0;
  let index = source.indexOf('{', start);
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return new Function(`${source.slice(start, index + 1)}; return measureLineCut;`)();
})();

const cutOf = (length, perLine = 20) => {
  const text = 'a'.repeat(length);
  return measureLineCutForTests(fakeLayout(wrapEvery(perLine), text), 5 * 20);
};

await check('a character whose box reaches the cap is the one the ellipsis replaces', () => {

  const boundary = cutOf(100);
  if (boundary.text.length !== 100) throw new Error(`cut at ${boundary.text.length}, expected 100`);
  if (boundary.truncated) throw new Error('text ending inside the pane was reported as truncated');

  const past = cutOf(101);
  if (past.text.length !== 100) throw new Error(`cut at ${past.text.length}, expected 100`);
  if (!past.truncated) throw new Error('the first character past the cap was not replaced');

  for (const length of [120, 163, 500]) {
    const cut = cutOf(length);
    if (cut.text.length !== 100) throw new Error(`length ${length} cut at ${cut.text.length}`);
    if (!cut.truncated) throw new Error(`length ${length} was not truncated`);
  }

  const narrow = cutOf(100, 10);
  if (narrow.text.length !== 50) throw new Error(`a 10-per-line pane cut at ${narrow.text.length}`);
  if (!narrow.truncated) throw new Error('a narrower pane did not truncate');

  for (const length of [0, 1, 20, 63]) {
    const cut = cutOf(length);
    if (cut.text.length !== length) throw new Error(`length ${length} was cut to ${cut.text.length}`);
    if (cut.truncated) throw new Error(`length ${length} was reported as truncated`);
  }
});

await check('with nothing to measure, the pane falls back to a bounded five-line box', () => {

  const long = 'word '.repeat(200);
  const card = renderCard({
    phase: 'preparing',
    block: {},
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => JSON.stringify({ prompt: long }),
  });

  if (!JSON.stringify(card).includes(`已收 ${long.length} 字`)) throw new Error('the full length is not reported');
  let pane = null;
  walk(card, (node) => {
    if (node.type === 'div' && node.props?.style?.maxHeight === '116px') pane = node;
  });
  if (!pane) throw new Error('the live pane is not bounded');
  if (pane.props.style.overflow !== 'hidden') throw new Error('the live pane does not clip');
  if (pane.props.style.whiteSpace !== 'pre-wrap') throw new Error('the author line breaks were dropped');

  if (pane.props.style.maxHeight !== String(5 * 20 + 16) + 'px') throw new Error(pane.props.style.maxHeight);

  if (JSON.stringify(card).includes('data-live-prompt-cut')) throw new Error('an unmeasured pane claimed a cut');
});

await check('a short prompt is shown whole and without an ellipsis', () => {
  const card = renderCard({
    phase: 'preparing',
    block: {},
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => JSON.stringify({ prompt: 'a corgi in a hat' }),
  });
  if (promptTextOf(card) !== 'a corgi in a hat') throw new Error(promptTextOf(card));
});

await check('no render helper takes a label where it means the translator', () => {

  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const helpers = ['renderLivePrompt', 'renderParamsDisclosure', 'renderPromptDisclosure', 'renderDisclosure'];
  for (const name of helpers) {
    const declaration = new RegExp(`function ${name}\\(([^)]*)\\)`).exec(source);
    if (!declaration) throw new Error(`${name} is not declared`);
    const params = declaration[1].split(',').map((part) => part.trim());

    if (params.includes('t') || params.includes('label')) continue;
    throw new Error(`${name}(${declaration[1]}) takes neither t nor label`);
  }

  const misdirected = [...source.matchAll(/render(LivePrompt|ParamsDisclosure)\(([^)]*)\)/g)].filter((match) =>
    /\bt\(['"]/.test(match[2]),
  );
  if (misdirected.length > 0) {
    throw new Error(`a translated string was passed where the translator belongs: ${misdirected.map((m) => m[0]).join(', ')}`);
  }
});

await check('both dictionaries carry the same keys, with no blank values', () => {

  if (registeredDictionaries.length === 0) throw new Error('no dictionary was registered');
  for (const { dict } of registeredDictionaries) {
    const { zh, en } = dict;
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    const onlyEn = enKeys.filter((key) => !(key in zh));
    const onlyZh = zhKeys.filter((key) => !(key in en));
    if (onlyEn.length || onlyZh.length) {
      throw new Error(`only en: [${onlyEn.join(', ')}]; only zh: [${onlyZh.join(', ')}]`);
    }
    const blank = enKeys.filter((key) => !String(en[key]).trim() || !String(zh[key]).trim());
    if (blank.length) throw new Error(`blank values: ${blank.join(', ')}`);

    for (const gone of ['labelQualityNote', 'qualityNote']) {
      if (gone in en || gone in zh) throw new Error(`${gone} is back in the dictionary`);
    }
  }
});

await check('the settings page is defaults plus connection, with no call-parameter explainer', async () => {

  tree = mount();
  await settle();
  const text = JSON.stringify(tree);

  if (!text.includes('连接')) throw new Error('the connection heading is missing');
  if (!text.includes('默认参数')) throw new Error('the defaults heading is missing');

  for (const gone of ['画质已经是调用参数', '省略时按 high 出图']) {
    if (text.includes(gone)) throw new Error(`the call-parameter notice is back: ${gone}`);
  }

  for (const label of ['数量', '输出格式', '背景', '内容审查', '用户标识', '输出目录', '文件名', '默认尺寸', '最长边上限', '超时']) {
    if (!text.includes(label)) throw new Error(`the "${label}" row disappeared from the settings page`);
  }
});

await check('clearing records takes a confirmation, and posts to the host route', async () => {

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ cleared: 7, indexRemoved: true }) };
  };
  const findButton = (label) => {
    let found = null;
    walk(tree, (node) => {
      if (node.type !== 'button') return;
      const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
      if (children.filter((child) => typeof child === 'string').join('').includes(label)) found = node;
    });
    return found;
  };
  try {
    tree = mount();
    await settle();

    const trigger = findButton('清除图片记录');
    if (!trigger) throw new Error('the clear button is missing');
    trigger.props.onClick();
    tree = rerender();
    await settle();

    const afterFirstClick = JSON.stringify(tree);
    if (calls.length !== 0) throw new Error('the first click already sent the request');
    if (!afterFirstClick.includes('确定清除图片记录？')) throw new Error('no confirmation was shown');

    if (!afterFirstClick.includes('图片文件本身不会被删除')) throw new Error('the warning does not say the files are kept');
    if (!afterFirstClick.includes('无法撤销')) throw new Error('the warning does not say it is irreversible');

    findButton('取消').props.onClick();
    tree = rerender();
    await settle();
    if (calls.length !== 0) throw new Error('cancelling still sent the request');
    if (JSON.stringify(tree).includes('确定清除图片记录？')) throw new Error('the confirmation survived cancel');

    findButton('清除图片记录').props.onClick();
    tree = rerender();
    await settle();
    findButton('确定清除').props.onClick();
    await settle();
    if (calls.length !== 1) throw new Error(`${calls.length} requests were sent, expected 1`);
    if (calls[0].init.method !== 'POST') throw new Error(calls[0].init.method);
    if (calls[0].init.headers['x-dsh-image-generation-action'] !== 'clear-records') {
      throw new Error(JSON.stringify(calls[0].init.headers));
    }
    if (!JSON.stringify(tree).includes('已清除 7 条记录')) throw new Error('the result count was not reported');
  } finally {
    globalThis.fetch = originalFetch;
    tree = mount();
    await settle();
  }
});

await check('the client and the host agree on the records route', () => {

  const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const hostSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const fromClient = /const RECORDS_ROUTE = '([^']+)'/.exec(clientSource)?.[1];
  const fromHost = /export const RECORDS_ROUTE = '([^']+)'/.exec(hostSource)?.[1];
  if (!fromClient) throw new Error('the client does not declare the records route');
  if (!fromHost) throw new Error('the host does not export the records route');
  if (fromClient !== fromHost) throw new Error(`client ${fromClient} vs host ${fromHost}`);
});

await check('no component can skip a hook on some renders', () => {
  // React #310 (rendered fewer hooks than expected) comes from a hook called inside a branch.
  // A component that mounts and unmounts is fine, since it owns its own hook scope, so what
  // matters is only that no hook call sits under a condition INSIDE one component. That is a
  // property of the source, so it is read there rather than inferred from a render.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const lines = source.split('\n');
  const HOOK = /\b(useState|useEffect|useLayoutEffect|useCallback|useRef|useLanguage)\s*\(/;
  const offenders = [];
  let depth = 0;
  let conditional = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // Track whether the current nesting is under a branch or a short circuit. `&&` and `?`
    // are counted as openers until the statement ends.
    if (/^\s*(if|else|\} else)\b/.test(line)) conditional += 1;
    if (HOOK.test(line) && conditional > 0) offenders.push(`${index + 1}: ${line.trim()}`);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    // A branch closes when its block does.
    if (conditional > 0 && depth <= 0) conditional = 0;
    if (/;\s*$/.test(line) && !/\{\s*$/.test(line)) conditional = 0;
  }
  if (offenders.length > 0) throw new Error(`hooks under a condition: ${offenders.join(' | ')}`);
});

await check('no render path falls back to the error card for ordinary input', () => {
  // The fallback is a last resort. Seeing it for a normal call is the "obviously broken"
  // outcome: the user gets a card that says it failed instead of their picture.
  const ordinary = [
    ['preparing', { phase: 'preparing', block: {}, useDisclosure: withDisclosure(false), useToolCallArgumentsPartial: () => '{"prompt":"hi"' }],
    ['started', { phase: 'start', block: { argsRaw: '{"prompt":"hi"}' }, useDisclosure: withDisclosure(false) }],
    ['settled', { phase: 'result', block: { call: { argsRaw: '{"prompt":"hi"}' }, meta: { images: [{ url: '/f/a.png', path: 'a.png' }] } }, useDisclosure: withDisclosure(false) }],
    ['settled empty', { phase: 'result', block: { call: { argsRaw: '{"prompt":"hi"}' }, meta: {} }, useDisclosure: withDisclosure(false) }],
  ];
  for (const [label, props] of ordinary) {
    const text = JSON.stringify(renderCard(props));
    if (text.includes('这张卡片渲染失败') || text.includes('could not be drawn')) {
      throw new Error(`${label} fell back to the error card`);
    }
    if (!text.includes('图片生成')) throw new Error(`${label} lost the card title`);
  }
});

await check('every label the card can show resolves to real text', async () => {
  // A raw key or an empty string reaches the screen as visible nonsense. Both languages are
  // rendered so a key present in only one table is caught here as well as by the dictionary
  // comparison.
  for (const locale of ['zh-CN', 'en-US']) {
    setLocale(locale);
    const paths = [
      { phase: 'preparing', block: {}, useDisclosure: withDisclosure(false), useToolCallArgumentsPartial: () => '{"prompt":"hi","quality":"max","count":2,"background":"opaque","images":["a.png"]}' },
      { phase: 'result', block: { call: { argsRaw: '{"prompt":"hi","quality":"max","count":2,"background":"opaque","location":"/tmp"}' }, meta: { images: [{ url: '/f/a.png', path: 'a.png' }] } }, useDisclosure: withDisclosure(true) },
    ];
    for (const path of paths) {
      tree = renderCard(path);
      // Only VISIBLE text is checked. Matching the serialized tree would also match the
      // `key` props the card sets, which is a false positive: a key is not rendered.
      const shown = [];
      walk(tree, (node) => {
        const children = node.props?.children;
        if (typeof children === 'string') shown.push(children);
        else if (Array.isArray(children)) children.filter((child) => typeof child === 'string').forEach((child) => shown.push(child));
      });
      const visible = shown.join('\n');
      // A label that never translated appears as its own key, which is always camelCase.
      for (const key of ['livePrompt', 'receivedChars', 'expandPrompt', 'expandParams', 'paramQuality', 'paramCount', 'paramBackground', 'paramLocation', 'paramImages', 'paramMask', 'paramFiles', 'cardTitle', 'running', 'imageAlt']) {
        if (visible.includes(key)) throw new Error(`${locale}: the key ${key} reached the card as visible text`);
      }
      // And no value may render as the string "undefined" or "NaN".
      if (/\bundefined\b|\bNaN\b/.test(visible)) throw new Error(`${locale}: a value rendered as undefined or NaN`);
    }
  }
  setLocale('zh-CN');
  tree = mount();
  await settle();
});

await check('the live pane never clips without saying so', () => {
  // The inverse of the clamp: a pane that hides text must announce it with the ellipsis, and
  // a pane that shows everything must not. Both directions are checked because an ellipsis
  // on complete text is just as wrong as a silent cut.
  const short = renderCard({ phase: 'preparing', block: {}, useDisclosure: withDisclosure(false), useToolCallArgumentsPartial: () => '{"prompt":"short"}' });
  if (JSON.stringify(short).includes('data-live-prompt-cut')) {
    throw new Error('an ellipsis was drawn on text that fits');
  }
  // With no layout engine the cut cannot run, so the pane must still be bounded and clipped
  // by its style rather than relying on the measurement.
  let pane = null;
  walk(short, (node) => {
    if (node.type === 'div' && typeof node.props?.style?.maxHeight === 'string' && node.props.style.maxHeight.endsWith('px')) pane = node;
  });
  if (!pane) throw new Error('the live pane has no height bound at all');
  if (pane.props.style.overflow !== 'hidden') throw new Error('the live pane does not clip');
});

await check('the card keeps its own layout when the prompt is enormous', () => {
  // A 32000-character prompt is legal. It must not push the frames off screen or blow up the
  // tree: the live pane is a single node carrying the text, not one node per character.
  const huge = 'x'.repeat(32000);
  const card = renderCard({ phase: 'preparing', block: {}, useDisclosure: withDisclosure(false), useToolCallArgumentsPartial: () => JSON.stringify({ prompt: huge }) });
  let nodes = 0;
  walk(card, () => {
    nodes += 1;
  });
  if (nodes > 60) throw new Error(`the card rendered ${nodes} nodes for one prompt`);
  // The frame box is a fixed square, so it cannot be pushed around by the pane above it.
  const settled = renderCard({ phase: 'result', block: { call: { argsRaw: JSON.stringify({ prompt: huge }) }, meta: { images: [{ url: '/f/a.png', path: 'a.png' }] } }, useDisclosure: withDisclosure(false) });
  let link = null;
  walk(settled, (node) => {
    if (node.type === 'a') link = node;
  });
  if (!link) throw new Error('the frame disappeared when the prompt was long');
  if (link.props.style.width !== 260 || link.props.style.height !== 260) throw new Error('the frame box is not fixed');
});

await check('the card gets its translator from the language hook, not from the module scope', () => {
  const card = renderCard({
    phase: 'preparing',
    block: { argsRaw: JSON.stringify({ prompt: 'hello', mode: 'edit' }) },
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => '{"prompt":"hello"',
  });
  const text = JSON.stringify(card);
  if (text.includes('This card could not be drawn')) {
    throw new Error('the card fell into its own error boundary instead of rendering');
  }

  if (!text.includes('提示词')) throw new Error('the live label did not translate');
  if (!text.includes('已收 5 字')) throw new Error('the received-count label did not translate');
  if (/undefined|NaN/.test(text)) throw new Error('a broken translator leaked into the card');
});

await check('every locale renders the card without falling into the boundary', () => {

  for (const locale of ['zh-CN', 'en-US']) {
    setLocale(locale);
    const card = renderCard({
      phase: 'preparing',
      block: { argsRaw: JSON.stringify({ prompt: 'hello', mode: 'edit' }) },
      useDisclosure: withDisclosure(false),
      useToolCallArgumentsPartial: () => '{"prompt":"hello"',
    });
    const text = JSON.stringify(card);
    if (text.includes('could not be drawn') || text.includes('渲染失败')) {
      throw new Error(`${locale}: the card fell into its error boundary`);
    }
    const label = locale === 'zh-CN' ? '提示词' : 'Prompt';
    if (!text.includes(label)) throw new Error(`${locale}: the live label is missing`);
  }
  setLocale('zh-CN');
  tree = mount();
});

await check('the prompt stays readable across the whole call, phase by phase', () => {

  const full = JSON.stringify({ prompt: '把喵改造成汪', mode: 'edit' });
  const steps = [
    { phase: 'preparing', block: {}, partial: '{"prompt":"把喵改造成汪"' },

    { phase: 'start', block: { argsRaw: full }, partial: '' },
    { phase: 'start', block: { argsRaw: full } },
    { phase: 'result', block: { call: { argsRaw: full }, meta: { images: [] } } },
  ];
  for (const step of steps) {
    const card = renderCard({
      phase: step.phase,
      block: step.block,
      useDisclosure: withDisclosure(false),
      useToolCallArgumentsPartial: () => step.partial,
    });
    const shown = promptTextOf(card);
    const hasDisclosure = Boolean(disclosureButton(card, '展开提示词'));
    if (!shown && !hasDisclosure) {
      throw new Error(
        `phase ${step.phase} (partial ${JSON.stringify(step.partial ?? null)}) showed neither the prompt nor a disclosure`,
      );
    }
  }

  const middle = renderCard({
    phase: 'start',
    block: { argsRaw: full },
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => '',
  });
  if (promptTextOf(middle) !== '把喵改造成汪') throw new Error(`mid-call showed "${promptTextOf(middle)}"`);
});

await check('the live prompt appears in the preparing phase, which is the one that carries it', () => {

  const phases = ['preparing', 'start', 'result'];
  const seen = {};
  for (const phase of phases) {
    const card = renderCard({
      phase,
      block: {},
      useDisclosure: withDisclosure(false),
      useToolCallArgumentsPartial: () => '{"prompt":"a corgi',
    });
    seen[phase] = promptTextOf(card);
  }
  if (seen.preparing !== 'a corgi') throw new Error(`preparing showed "${seen.preparing}"`);
  if (seen.start !== 'a corgi') throw new Error(`start showed "${seen.start}"`);

  if (seen.result !== '') throw new Error(`result showed "${seen.result}"`);

  for (const phase of phases) {
    const card = renderCard({
      phase,
      block: { call: { argsRaw: '{"prompt":"settled text"}' }, argsRaw: '{"prompt":"settled text"}' },
      useDisclosure: withDisclosure(false),
      useToolCallArgumentsPartial: () => '{"prompt":"live text"}',
    });
    if (!JSON.stringify(card).includes('展开提示词') && !promptTextOf(card)) {
      throw new Error(`phase ${phase} rendered neither a live prompt nor a disclosure`);
    }
  }
});

await check('the streaming prompt is shown outright, not hidden behind a toggle', () => {

  const running = renderCard({
    phase: 'preparing',
    block: {},
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => '{"prompt":"a corgi in a',
  });
  if (promptTextOf(running) !== 'a corgi in a') throw new Error(`the live prompt is not visible: "${promptTextOf(running)}"`);
  const text = JSON.stringify(running);
  if (!text.includes('生成中')) throw new Error('the live label is missing');
  if (disclosureButton(running, '展开提示词')) throw new Error('the live prompt was put behind a toggle');
});

await check('the live prompt and its count grow as the arguments stream', () => {
  const partials = ['{"prompt":"a', '{"prompt":"a corgi', '{"prompt":"a corgi in a hat"}'];
  const seen = [];
  for (const partial of partials) {
    const card = renderCard({
      phase: 'preparing',
      block: {},
      useDisclosure: withDisclosure(false),
      useToolCallArgumentsPartial: () => partial,
    });
    seen.push(promptTextOf(card));
  }
  if (seen.join('|') !== 'a|a corgi|a corgi in a hat') throw new Error(seen.join('|'));
});

await check('the prompt collapses into a toggle once the call settles', () => {
  const running = renderCard({
    phase: 'preparing',
    block: {},
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => '{"prompt":"a corgi in a hat"}',
  });
  if (promptTextOf(running) !== 'a corgi in a hat') throw new Error('the live prompt was not shown');

  const settled = renderCard({
    ...settledCard(JSON.stringify({ prompt: 'a corgi in a hat' })),
    useDisclosure: withDisclosure(false),
  });
  if (disclosureButton(settled, '展开提示词')) {

  } else {
    throw new Error('the settled prompt did not collapse');
  }
  if (promptTextOf(settled) !== '') throw new Error('the settled prompt stayed visible');
});

await check('the running card shows the prompt from the streamed arguments', () => {

  const running = renderCard({
    phase: 'preparing',
    block: {},
    useDisclosure: withDisclosure(true),
    useToolCallArgumentsPartial: () => '{"prompt":"a corgi in a',
  });
  if (!JSON.stringify(running).includes('生成中')) throw new Error('the running state is missing');
  const listed = JSON.stringify(running);

  if (!/提示词/.test(listed)) throw new Error('the prompt block is missing while running');

  if (!/已收 12 字/.test(listed)) throw new Error(`the received count is missing: ${listed.slice(0, 200)}`);
  if (promptTextOf(running) !== 'a corgi in a') throw new Error(`the partial prompt read "${promptTextOf(running)}"`);
});

await check('a half-written argument document is salvaged without inventing fields', () => {
  const running = renderCard({
    phase: 'preparing',
    block: {},
    useDisclosure: withDisclosure(true),

    useToolCallArgumentsPartial: () => '{"prompt":"a cat","resolution":"1536x86',
  });
  if (promptTextOf(running) !== 'a cat') throw new Error(promptTextOf(running));
  const listed = JSON.stringify(running);
  if (!listed.includes('尺寸: 1536x86')) throw new Error('the streamed size prefix is missing');
  if (listed.includes('张数:')) throw new Error('a count nobody wrote was invented');
  if (listed.includes('背景:')) throw new Error('a background nobody wrote was invented');
});

await check('the running card falls back to argsRaw without the arguments hook', () => {
  const running = renderCard({
    phase: 'preparing',
    block: { argsRaw: JSON.stringify({ prompt: 'from the block' }) },
    useDisclosure: withDisclosure(true),
  });
  if (promptTextOf(running) !== 'from the block') throw new Error('the block argsRaw fallback did not render');
});

await check('a throwing arguments hook does not blank the running card', () => {
  const running = renderCard({
    phase: 'preparing',
    block: { argsRaw: JSON.stringify({ prompt: 'still here' }) },
    useDisclosure: withDisclosure(false),
    useToolCallArgumentsPartial: () => {
      throw new Error('slot dispatch went wrong');
    },
  });
  if (!JSON.stringify(running).includes('生成中')) throw new Error('a throwing hook blanked the card');

  if (promptTextOf(running) !== 'still here') throw new Error(`showed "${promptTextOf(running)}"`);
});

await check('the parameters disclosure lists only the arguments that were passed', () => {
  const card = renderCard({
    phase: 'result',
    block: {
      call: {
        name: 'generate_image',
        argsRaw: JSON.stringify({ prompt: 'a cat', resolution: '1536x1024', quality: 'max', count: 2 }),
      },
      meta: { images: [{ url: '/f/a.png', path: 'a.png', bytes: 10 }] },
    },
    useDisclosure: withDisclosure(true),
  });
  const text = JSON.stringify(card);
  if (!/参数/.test(text)) throw new Error('the parameters disclosure is missing');
  if (!text.includes('尺寸: 1536x1024')) throw new Error('the size is missing');
  if (!text.includes('画质: max')) throw new Error('the quality is missing');
  if (!text.includes('张数: 2')) throw new Error('the count is missing');

  if (text.includes('背景:')) throw new Error('an unpassed background was invented');
  if (text.includes('位置:')) throw new Error('an unpassed location was invented');
});

await check('an omitted size reads as auto rather than as nothing', () => {
  const card = renderCard({
    phase: 'result',
    block: {
      call: { name: 'generate_image', argsRaw: JSON.stringify({ prompt: 'a cat' }) },
      meta: { images: [] },
    },
    useDisclosure: withDisclosure(true),
  });
  const text = JSON.stringify(card);
  if (!text.includes('尺寸: auto')) throw new Error('the default size is not shown');

  if (text.includes('写盘文件')) throw new Error('a file count was listed for an empty result');
});

await check('a settled card with nothing to list shows no parameters button', () => {
  const card = renderCard({
    phase: 'result',
    block: { call: null, meta: { images: [] } },
    useDisclosure: withDisclosure(false),
  });
  if (JSON.stringify(card).includes('参数')) throw new Error('an empty card offered a parameters panel');
});

await check('the settled card carries the prompt behind a collapsed disclosure', () => {
  const settled = renderCard({
    ...settledCard(JSON.stringify({ prompt: 'a corgi in a hat' })),
    useDisclosure: withDisclosure(false),
  });
  const text = JSON.stringify(settled);
  if (!text.includes('展开提示词')) throw new Error('the disclosure is missing from the settled card');
  if (!text.includes('(16)')) throw new Error('the prompt length is not shown');
  if (text.includes('a corgi in a hat')) throw new Error('the prompt was shown while collapsed');
});

await check('opening the disclosure reveals the prompt the call actually used', () => {
  const opened = renderCard({
    ...settledCard(JSON.stringify({ prompt: 'a corgi in a hat' })),
    useDisclosure: withDisclosure(true),
  });
  if (promptTextOf(opened) !== 'a corgi in a hat') throw new Error(`rendered "${promptTextOf(opened)}"`);
  let toggle = null;
  walk(opened, (node) => {
    if (node.type === 'button' && node.props?.['aria-expanded'] === 'true') toggle = node;
  });
  if (!toggle) throw new Error('the toggle does not report its expanded state');
  if (typeof toggle.props.onClick !== 'function') throw new Error('the toggle has no handler');
});

await check('a truncated call head still leaves argsRaw usable', () => {

  const truncated = renderCard({
    phase: 'result',
    block: { call: null, argsRaw: JSON.stringify({ prompt: 'from the block' }), meta: { images: [] } },
    useDisclosure: withDisclosure(true),
  });
  if (promptTextOf(truncated) !== 'from the block') throw new Error(promptTextOf(truncated));
});

await check('the toggle reaches the harness hook when one is provided', () => {
  let toggled = 0;
  renderCard({
    ...settledCard(JSON.stringify({ prompt: 'x' })),
    useDisclosure: () => ({
      expanded: false,
      setExpanded() {},
      toggle: () => {
        toggled += 1;
      },
    }),
  });
  let button = null;
  walk(tree, (node) => {
    if (node.type === 'button' && node.props?.['aria-expanded'] === 'false') button = node;
  });
  if (!button) throw new Error('no toggle was rendered');
  button.props.onClick();
  if (toggled !== 1) throw new Error(`the harness hook was called ${toggled} times`);
});

await check('a card without the harness hook still opens on its own', () => {

  const bare = renderCard(settledCard(JSON.stringify({ prompt: 'a corgi in a hat' })));
  const button = disclosureButton(bare, '展开提示词');
  if (!button) throw new Error('no prompt toggle without the hook');
  if (button.props['aria-expanded'] !== 'false') throw new Error('the fallback started expanded');
  button.props.onClick();
  if (promptTextOf(rerenderCard()) !== 'a corgi in a hat') throw new Error('the fallback expansion did not take effect');
});

await check('a throwing or malformed disclosure hook does not blank the card', () => {
  const throwing = renderCard({
    ...settledCard(JSON.stringify({ prompt: 'still here' })),
    useDisclosure: () => {
      throw new Error('slot dispatch went wrong');
    },
  });
  if (!JSON.stringify(throwing).includes('展开提示词')) throw new Error('a throwing hook blanked the card');

  const recovered = disclosureButton(throwing, '展开提示词');
  if (!recovered) throw new Error('a throwing hook removed the toggle');
  recovered.props.onClick();
  if (promptTextOf(rerenderCard()) !== 'still here') throw new Error('a throwing hook broke the fallback');

  renderCard({
    ...settledCard(JSON.stringify({ prompt: 'still here' })),
    useDisclosure: () => ({ expanded: 'yes', toggle: 'not a function' }),
  });
  const button = disclosureButton(tree, '展开提示词');
  if (!button) throw new Error('a malformed hook removed the toggle');
  if (button.props['aria-expanded'] !== 'false') throw new Error('a malformed hook was trusted as expanded');
  button.props.onClick();
  if (promptTextOf(rerenderCard()) !== 'still here') throw new Error('a malformed hook broke the fallback');
});

await check('an empty, missing, or unparseable prompt hides the disclosure', () => {
  const raws = [JSON.stringify({ prompt: '' }), JSON.stringify({}), 'not json at all', undefined, null];
  for (const argsRaw of raws) {
    const card = renderCard({ ...settledCard(argsRaw), useDisclosure: withDisclosure(false) });
    if (JSON.stringify(card).includes('展开提示词')) {
      throw new Error(`an empty prompt still rendered a disclosure for ${String(argsRaw)}`);
    }
  }
});

await check('a very long prompt is bounded rather than stretching the card', () => {
  const long = 'x'.repeat(20000);
  const card = renderCard({
    ...settledCard(JSON.stringify({ prompt: long })),
    useDisclosure: withDisclosure(true),
  });
  let pane = null;
  walk(card, (node) => {
    if (node.type === 'div' && node.props?.style?.whiteSpace === 'pre-wrap') pane = node;
  });
  if (!pane) throw new Error('the long prompt did not render');
  if (pane.props.style.maxHeight !== 260) throw new Error('the long prompt is unbounded');
  if (pane.props.style.overflowY !== 'auto') throw new Error('the long prompt cannot scroll');
  if (promptTextOf(card) !== long) throw new Error('the long prompt was truncated');
});

await check('the disclosure sits below the frames it produced', () => {

  const card = renderCard({
    phase: 'result',
    block: {
      call: { argsRaw: JSON.stringify({ prompt: 'a corgi in a hat' }) },
      meta: { images: [{ url: '/f/a.png', path: 'a.png', bytes: 10 }] },
    },
    useDisclosure: withDisclosure(false),
  });
  let seen = 0;
  let imageAt = -1;
  let disclosureAt = -1;

  const ownText = (node) =>
    (Array.isArray(node.props?.children) ? node.props.children : [node.props?.children])
      .filter((child) => typeof child === 'string')
      .join('');
  walk(card, (node) => {
    seen += 1;
    if (node.type === 'img' && imageAt < 0) imageAt = seen;
    if (disclosureAt < 0 && ownText(node).includes('展开提示词')) disclosureAt = seen;
  });
  if (imageAt < 0) throw new Error('no image was rendered');
  if (disclosureAt < 0) throw new Error('no disclosure was rendered');
  if (disclosureAt < imageAt) throw new Error(`the disclosure precedes the image (${disclosureAt} < ${imageAt})`);
});

await check('a frame that fails to load cannot stretch the card', () => {

  const card = renderCard({
    phase: 'result',
    block: {
      call: { argsRaw: JSON.stringify({ prompt: 'x' }) },
      meta: { images: [{ url: '/dsh-image-generation/file/missing.png', path: 'D:\\a very long directory\\missing.png' }] },
    },
    useDisclosure: withDisclosure(false),
  });
  let link = null;
  let img = null;
  walk(card, (node) => {
    if (node.type === 'a') link = node;
    if (node.type === 'img') img = node;
  });
  if (!link || !img) throw new Error('the frame did not render');
  if (link.props.style.width !== 260 || link.props.style.height !== 260) throw new Error('the frame box is not fixed');
  if (link.props.style.overflow !== 'hidden') throw new Error('the frame box does not clip');
  if (img.props.alt !== '生成的图片') throw new Error(`the alt is "${img.props.alt}"`);
  if (img.props.src !== '/dsh-image-generation/file/missing.png') throw new Error('the source was changed');
});

await check('the settled card still renders every image and the count', () => {
  const settled = renderCard({
    phase: 'result',
    block: {
      meta: {
        title: 'Generated 2 images',
        images: [
          { url: '/dsh-image-generation/file/a.png', path: 'D:\\out\\a.png', bytes: 10 },
          { url: '/dsh-image-generation/file/b.png', path: 'D:\\out\\b.png', bytes: 20 },
        ],
      },
    },
    useDisclosure: withDisclosure(false),
  });
  const urls = [];
  walk(settled, (node) => {
    if (node.type === 'img') urls.push(node.props.src);
  });
  if (urls.join(',') !== '/dsh-image-generation/file/a.png,/dsh-image-generation/file/b.png') throw new Error(urls.join(','));
  if (!JSON.stringify(settled).includes('2 张图片')) throw new Error('settled count missing');
});

await check('no hostile input shape can throw out of the card', () => {

  const cases = [
    ['no props at all', undefined],
    ['null props', null],
    ['props is a string', 'nope'],
    ['props is a number', 42],
    ['null block', { phase: 'result', block: null }],
    ['block is a string', { phase: 'result', block: 'nope' }],
    ['block is a number', { phase: 'result', block: 42 }],
    ['phase is a number', { phase: 7, block: {} }],
    ['phase is null', { phase: null, block: {} }],
    ['phase missing', { block: {} }],
    ['meta is an array', { phase: 'result', block: { meta: [] } }],
    ['meta images is a string', { phase: 'result', block: { meta: { images: 'nope' } } }],
    ['meta images holds junk', { phase: 'result', block: { meta: { images: [null, 7, 'x', {}, { url: 5 }] } } }],
    ['argsRaw is an object', { phase: 'preparing', block: { argsRaw: { prompt: 'x' } } }],
    ['argsRaw is a number', { phase: 'preparing', block: { argsRaw: 5 } }],
    ['argsRaw is a huge non-JSON string', { phase: 'preparing', block: { argsRaw: 'x'.repeat(50000) } }],
    ['call is a string', { phase: 'result', block: { call: 'nope', meta: {} } }],
    ['call.argsRaw is null', { phase: 'result', block: { call: { argsRaw: null }, meta: {} } }],
    ['prompt is a number', { phase: 'result', block: { call: { argsRaw: JSON.stringify({ prompt: 123 }) }, meta: {} } }],
    ['prompt is an object', { phase: 'result', block: { call: { argsRaw: JSON.stringify({ prompt: { a: 1 } }) }, meta: {} } }],
    ['useDisclosure is not a function', { phase: 'result', block: { call: { argsRaw: '{"prompt":"x"}' }, meta: {} }, useDisclosure: 5 }],
    ['arguments hook returns a number', { phase: 'preparing', block: {}, useToolCallArgumentsPartial: () => 5 }],
    ['arguments hook returns null', { phase: 'preparing', block: {}, useToolCallArgumentsPartial: () => null }],
    ['arguments hook throws', { phase: 'preparing', block: {}, useToolCallArgumentsPartial: () => { throw new Error('boom'); } }],
    ['disclosure hook throws', { phase: 'result', block: { call: { argsRaw: '{"prompt":"x"}' }, meta: {} }, useDisclosure: () => { throw new Error('boom'); } }],
    ['disclosure hook is a Proxy that throws', { phase: 'result', block: {}, useDisclosure: () => new Proxy({}, { get() { throw new Error('boom'); } }) }],
    ['arguments hook is a Proxy that throws', { phase: 'preparing', block: {}, useToolCallArgumentsPartial: () => new Proxy({}, { get() { throw new Error('boom'); } }) }],
  ];
  const failures = [];
  for (const [label, props] of cases) {
    try {
      const node = props === undefined ? react.createElement(toolView) : react.createElement(toolView, props);
      if (!node) failures.push(`${label} -> rendered nothing`);
    } catch (error) {
      failures.push(`${label} -> THREW ${String(error.message).slice(0, 60)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join(' | '));
});

await check('a malformed result meta renders nothing instead of throwing', () => {
  const broken = renderCard({ phase: 'result', block: { meta: 'not-an-object' } });
  const empty = renderCard({ phase: 'result', block: {} });
  if (JSON.stringify(broken).includes('"img"')) throw new Error('rendered images from junk');
  if (!JSON.stringify(empty).includes('0 张图片')) throw new Error(JSON.stringify(empty).slice(0, 200));
});

await check('a hostile meta is filtered, not escalated to the boundary', () => {

  const hostile = {
    phase: 'result',
    block: {
      call: { argsRaw: JSON.stringify({ prompt: 'x' }) },
      meta: {
        images: [
          null,
          7,
          'nope',
          {},
          { url: 5 },
          { url: '' },
          { get url() { throw new Error('image url blew up'); } },
          { url: '/ok.png', path: 'ok.png' },
        ],
      },
    },
  };
  const node = renderCard(hostile);
  const text = JSON.stringify(node);
  if (text.includes('这张卡片渲染失败')) throw new Error('a filterable shape reached the boundary');
  const urls = [];
  walk(node, (entry) => {
    if (entry.type === 'img') urls.push(entry.props.src);
  });
  if (urls.join(',') !== '/ok.png') throw new Error(`rendered ${urls.join(',') || 'nothing'}`);
});

await check('the boundary still renders a card when the view itself fails', () => {

  const boundary = new toolView({ phase: 'result', block: {} });
  boundary.props = { phase: 'result', block: {} };
  boundary.state = { failure: new Error('render went wrong') };
  const fallback = boundary.render();
  const text = JSON.stringify(fallback);
  if (!text.includes('图片生成')) throw new Error('the fallback has no title');
  if (!text.includes('这张卡片渲染失败')) throw new Error('the fallback did not name the failure');
  if (!text.includes('render went wrong')) throw new Error('the fallback hid the reason');
  if (text.includes('展开提示词')) throw new Error('the fallback tried to render the full card');
});

await check('the boundary passes a healthy card straight through', () => {
  const boundary = new toolView({ phase: 'result', block: { call: { argsRaw: '{"prompt":"hi"}' }, meta: {} } });
  boundary.props = { phase: 'result', block: { call: { argsRaw: '{"prompt":"hi"}' }, meta: {} } };
  const rendered = boundary.render();
  if (!JSON.stringify(rendered).includes('展开提示词')) throw new Error('a healthy card was replaced by the fallback');
});

const sizeErrorOf = (node) => {
  let reason = null;
  walk(node, (entry) => {
    const value = entry.props?.['data-size-error'];
    if (typeof value === 'string') reason = value;
  });
  return reason;
};

const typeIntoResolution = async (value) => {
  tree = mount();
  await settle();
  const field = findByType('input', { type: 'text', placeholder: '宽x高，如 1536x864' });
  if (!field) throw new Error('the resolution input is missing');
  field.props.onChange({ target: { value } });
  tree = rerender();
  const input = findByType('input', { type: 'text', placeholder: '宽x高，如 1536x864' });
  const noticed = sizeErrorOf(tree);
  return { reason: noticed, seen: input?.props?.value };
};

await check('the form accepts a legal custom size without complaint', async () => {
  for (const size of ['1536x864', '3840x2160', '2880x2880', '1024x768']) {
    const { reason } = await typeIntoResolution(size);
    if (reason !== null) throw new Error(`${size} was flagged as ${reason}`);
  }
});

await check('the form refuses an empty box as auto rather than an error', async () => {
  const { reason } = await typeIntoResolution('');
  if (reason !== null) throw new Error(`an empty box was flagged as ${reason}`);
});

await check('the form reports the same rule the host would', async () => {
  const cases = [
    ['1536x865', 'step'],

    ['2048x600', 'step'],

    ['5008x1008', 'ratio'],

    ['5008x2048', 'cap'],
    ['640x832', 'floor'],
    ['3840x3840', 'ceiling'],
  ];
  for (const [size, rule] of cases) {
    const { reason, seen } = await typeIntoResolution(size);
    if (reason !== rule) throw new Error(`${size} reported ${reason}, expected ${rule} (the box held ${JSON.stringify(seen)})`);
  }
});

await check('the form agrees with the host verdict table', async () => {

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
    const { reason } = await typeIntoResolution(size);
    if (reason !== expected) throw new Error(`${size}: form says ${reason}, table says ${expected}`);
  }
});

await check('the form never calls an illegal size legal', async () => {
  for (const size of ['3840x3840', '1536x865', '5008x1008', '3856x1024', '640x832', 'nonsense']) {
    tree = mount();
    await settle();
    const field = findByType('input', { type: 'text', placeholder: '宽x高，如 1536x864' });
    field.props.onChange({ target: { value: size } });
    tree = rerender();
    if (sizeErrorOf(tree) === null) throw new Error(`${size} passed the form check`);
  }
});

const failures = results.filter((line) => line.startsWith('FAIL'));
console.log(['client contract', ...results].join('\n'));
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
process.exitCode = failures.length === 0 ? 0 : 1;
