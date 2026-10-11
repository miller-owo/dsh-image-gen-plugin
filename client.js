window.__ModuleLoader__.load({
  // Must equal package.json's name; a mismatch is refused and the card has no renderer.
  id: 'dsh-image-gen-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useLayoutEffect, useCallback } = React;

    const useSyncExternalStore =
      typeof React.useSyncExternalStore === 'function'
        ? React.useSyncExternalStore
        : (_subscribe, getSnapshot) => getSnapshot();

    const NS = 'dsh-image-generation';
    const SECTION_ID = 'image-generation';

    const RECORDS_ROUTE = '/dsh-image-generation/records';
    const LOCALE_NS = 'dsh-image-generation';

    const BUILTIN_MODELS = [
      'gpt-image-2.5-flare',
      'gpt-image-2.5-flare-2026-09-08',
      'gpt-image-2.5-sunburst',
      'gpt-image-2',
      'gpt-image-2-2026-04-21',
    ];
    const FORMATS = ['png', 'jpeg', 'webp'];
    const MODERATIONS = ['auto', 'low'];
    const BACKGROUNDS = ['auto', 'transparent', 'opaque'];
    const COUNTS = [1, 2, 3, 4];

    const NAME_TOKENS = ['{time}', '{prompt}', '{index}', '{uniq}'];
    const NAME_PRESETS = ['{time}-{prompt}', '{prompt}-{time}', '{time}', '{prompt}'];
    const RESOLUTION_PRESETS = [
      'auto',
      '1024x1024',
      '1536x1024',
      '1024x1536',
      '2048x2048',
      '2560x1440',
      '1440x2560',
      '3840x2160',
      '2160x3840',
    ];
    const FIELDS = [
      'apiUrl',
      'model',
      'count',
      'outputFormat',
      'outputCompression',
      'background',
      'moderation',
      'user',
      'defaultResolution',
      'maxEdge',
      'outputDir',
      'fileNameFormat',
      'requestTimeoutSec',
      'sendsModeration',
      'sendsOutputCompression',
    ];

    const EN = {
      section: 'Image generation',
      title: 'Image generation',
      subtitle:
        'Where calls are sent, and what they fall back to. The model and endpoint decide whether a call can work at all; every default below only applies when a call leaves that argument out.',
      labelModel: 'Model',
      hintModel: 'The model id exactly as this endpoint names it. The quick picks cover the GPT Image 2.5 and 2 families; type in anything else your gateway offers.',
      labelApiUrl: 'API URL',
      hintApiUrl: 'Base URL of an OpenAI-compatible API. /images/generations is appended to it.',
      labelApiKey: 'API key',
      hintApiKeySet: 'A key is stored under a neutral field name in the profile config, and the settings API never sends it back. Leave this empty to keep it; type a new one to replace it.',
      hintApiKeyEmpty: 'Sent as the Bearer token. It is stored in the profile configuration under a neutral field name and never leaves this machine.',
      sectionConnection: 'Connection',
      sectionMaintenance: 'Records',
      clearButton: 'Clear image records',
      clearHint: 'Which files the plugin wrote, so their cards can find them again.',
      clearWarnTitle: 'Clear the image records?',
      clearWarnBody:
        'This empties the record of which files were written. Every card already in the conversation will lose its image, because the plugin will no longer know where those files are. The image files themselves are NOT deleted, and new generations record themselves again. This cannot be undone.',
      clearConfirm: 'Yes, clear the records',
      clearCancel: 'Cancel',
      clearDone: 'Cleared {n} records. New generations will record themselves again.',
      clearFailed: 'Could not clear the records',
      sectionDefaults: 'Default parameters',
      hintDefaults: 'Used when a call leaves the matching argument out. A call that passes the argument wins, so nothing here has to be changed to make one call differ.',
      labelCount: 'Count',
      hintCount: 'Used when a call does not pass its own count. The API accepts 1 to 10.',
      labelFormat: 'Output format',
      hintFormat: 'Transparent backgrounds need png or webp; compression applies to jpeg and webp.',
      labelCompression: 'Compression',
      labelBackground: 'Background',
      hintBackground: 'The default a call inherits when it names no background.',
      labelModeration: 'Moderation',
      hintModeration: 'Ignored by the 2.5 family, which rejects the parameter.',
      labelUser: 'User',
      hintUser: 'Optional end-user identifier the provider receives with each request.',
      labelOutputDir: 'Output directory',
      hintOutputDir: 'Where images are written when location is not passed. Empty uses the session workspace, then the plugin folder as a last resort.',
      outputDirPlaceholder: 'leave empty for the session workspace',
      labelFileName: 'File name',
      hintFileName: 'The pattern every file is named with. {time} sorts, {prompt} is readable, {index} separates a batch, {uniq} guarantees a fresh name. A name that already exists gets a numeric suffix, so nothing is overwritten.',
      fileNamePlaceholder: '{time}-{prompt}',
      labelTimeout: 'Timeout',
      hintTimeout: 'Seconds to wait for one generation before giving up.',
      labelResolution: 'Default size',      hintResolution: 'Used when a call names no size. The endpoint wants each side to be a multiple of 16, the longest edge under the cap, 655,360 to 8,294,400 pixels in total, and a ratio no wider than 3:1.',
      labelMaxEdge: 'Size cap per side',
      hintMaxEdge: 'The model accepts a frame up to this value on its longest edge. 3840 matches the model default.',
      resolutionPlaceholder: 'WxH, e.g. 1536x864',
      resolutionAuto: 'auto',
      sizeFormatError: 'Write the size as WIDTHxHEIGHT, for example 1536x864, or leave it empty for auto.',
      sizeStepError: 'Each side must be a multiple of 16.',
      sizeCapError: 'The longest edge must stay at or below {cap}.',
      sizeRatioError: 'The endpoint refuses a ratio wider than 3:1.',
      sizeFloorError: 'The endpoint needs at least {min} pixels.',
      sizeCeilingError: 'The endpoint accepts at most {max} pixels; a 3840 square is over that, 2880x2880 is the largest square.',
      labelCompatibility: 'Request fields',
      toggleModeration: 'Send moderation',
      toggleCompression: 'Send output_compression',
      hintCompatibility: 'Turn a field off when the model behind this endpoint rejects it. The 2.5 family always drops moderation.',
      save: 'Save',
      saving: 'Saving...',
      reload: 'Reload',
      saved: 'Saved',
      conflict: 'Settings changed elsewhere; the form was refreshed, apply again.',
      loading: 'Loading settings...',
      unavailable: 'The settings API is not reachable from this page, so the plugin config in cordis.patch.yml stays in charge.',
      noSettingsApi: 'This page cannot reach the settings API, so the form cannot load.',
      missing: 'This plugin has no configuration entry in the active profile.',
      readOnly: 'This profile is read-only, so the form cannot be saved.',
      cardTitle: 'Image generation',
      running: 'generating...',
      images: 'image(s)',
      expandPrompt: 'Show prompt',
      livePrompt: 'Prompt',
      receivedChars: '{n} characters received',
      expandParams: 'Parameters',
      paramResolution: 'Size',
      paramQuality: 'Quality',
      paramCount: 'Count',
      paramBackground: 'Background',
      paramLocation: 'Location',
      paramFiles: 'Files written',
      paramImages: 'Source images',
      paramMask: 'Mask',
      imageAlt: 'generated image',
      cardFailed: 'This card could not be drawn',
    };

    const ZH = {
      section: '图片生成',
      title: '图片生成',
      subtitle: '调用发往哪里，以及没有自带参数时用什么。模型和端点决定调用能不能成功；下面的每一项默认值，只在调用省略了对应参数时生效。',
      labelModel: '模型',
      hintModel: '按这个端点自己的叫法填模型 id。快捷选项覆盖 GPT Image 2.5 和 2 两个系列；网关还有别的模型，直接输入即可。',
      labelApiUrl: 'API 地址',
      hintApiUrl: '兼容 OpenAI 的接口基地址，会在后面拼接 /images/generations。',
      labelApiKey: 'API 密钥',
      hintApiKeySet: '密钥已保存，配置里用的是中性字段名，设置接口不会把它回传。留空表示不改动；输入新值即可替换。',
      hintApiKeyEmpty: '作为 Bearer 令牌发送。保存在本机配置里，字段名是中性的，不会外传。',
      sectionConnection: '连接',
      sectionMaintenance: '记录',
      clearButton: '清除图片记录',
      clearHint: '插件写过哪些文件，卡片靠它找回图片。',
      clearWarnTitle: '确定清除图片记录？',
      clearWarnBody:
        '这会清空「写过哪些文件」的记录。对话里已有的卡片将不再显示图片，因为插件不再知道那些文件在哪。图片文件本身不会被删除，之后新生成的图会重新记录。此操作无法撤销。',
      clearConfirm: '确定清除',
      clearCancel: '取消',
      clearDone: '已清除 {n} 条记录。之后新生成的图会重新记录。',
      clearFailed: '清除失败',
      sectionDefaults: '默认参数',
      hintDefaults: '调用没有传对应参数时使用。调用传了就以调用为准，所以想让某一次不一样，不需要改这里的任何东西。',
      labelCount: '数量',
      hintCount: '调用未提供数量时使用。接口允许 1 到 10。',
      labelFormat: '输出格式',
      hintFormat: '透明背景需要 png 或 webp；压缩率对 jpeg 和 webp 生效。',
      labelCompression: '压缩率',
      labelBackground: '背景',
      hintBackground: '调用未指定背景时继承的默认值。',
      labelModeration: '内容审查',
      hintModeration: '2.5 系列会忽略并拒绝该参数。',
      labelUser: '用户标识',
      hintUser: '可选的终端用户标识，随每次请求发给服务端。',
      labelOutputDir: '输出目录',
      hintOutputDir: '调用没传 location 时，图片写到这里。留空则优先会话工作区，最后才用插件包内目录。',
      outputDirPlaceholder: '留空使用会话工作区',
      labelFileName: '文件名',
      hintFileName: '每个文件的命名模板。{time} 便于排序，{prompt} 便于辨认，{index} 区分数张，{uniq} 保证不重名。同名文件会自动加数字后缀，不会被覆盖。',
      fileNamePlaceholder: '{time}-{prompt}',
      labelTimeout: '超时',
      hintTimeout: '单次生成最多等待的秒数。',
      labelResolution: '默认尺寸',
      hintResolution: '调用没指定尺寸时使用。接口要求：每条边是 16 的倍数、最长边不超过下面的上限、总像素在 655,360 到 8,294,400 之间、比例不超过 3:1。',
      labelMaxEdge: '最长边上限',
      hintMaxEdge: '模型允许最长边最大到这个值。3840 是模型默认。',
      resolutionPlaceholder: '宽x高，如 1536x864',
      resolutionAuto: '智能比例',
      sizeFormatError: '尺寸写成 宽x高，例如 1536x864；留空表示 auto。',
      sizeStepError: '每条边都必须是 16 的倍数。',
      sizeCapError: '最长边不能超过 {cap}。',
      sizeRatioError: '接口不接受超过 3:1 的比例。',
      sizeFloorError: '接口要求至少 {min} 像素。',
      sizeCeilingError: '接口最多接受 {max} 像素；3840 的正方形超了，最大的正方形是 2880x2880。',
      labelCompatibility: '请求字段',
      toggleModeration: '发送 moderation',
      toggleCompression: '发送 output_compression',
      hintCompatibility: '如果这个端点背后的模型不接受某个字段，就在这里关掉。2.5 系列始终不发 moderation。',
      save: '保存',
      saving: '保存中...',
      reload: '重新读取',
      saved: '已保存',
      conflict: '设置已在别处改动，已刷新表单，请再点一次保存。',
      loading: '正在读取设置...',
      unavailable: '当前页面访问不到设置 API，请直接改 cordis.patch.yml 里的插件配置。',
      noSettingsApi: '这个页面取不到设置 API，表单无法加载。',
      missing: '当前配置里没有这个插件的配置项。',
      readOnly: '当前配置为只读，表单无法保存。',
      cardTitle: '图片生成',
      running: '生成中...',
      images: '张图片',
      expandPrompt: '展开提示词',
      livePrompt: '提示词',
      receivedChars: '已收 {n} 字',
      expandParams: '参数',
      paramResolution: '尺寸',
      paramQuality: '画质',
      paramCount: '张数',
      paramBackground: '背景',
      paramLocation: '位置',
      paramFiles: '写盘文件',
      paramImages: '源图',
      paramMask: '蒙版',
      imageAlt: '生成的图片',
      cardFailed: '这张卡片渲染失败',
    };

    function useLanguage() {
      const [, bump] = useState(0);
      useEffect(() => {
        if (!localeStore.source) return undefined;
        return localeStore.subscribe(() => bump((value) => value + 1));
      }, []);

      return t;
    }

    const localeStore = {
      source: null,
      listeners: new Set(),
      subscribe(listener) {
        localeStore.listeners.add(listener);
        return () => localeStore.listeners.delete(listener);
      },
    };

    let localeReader = () => '';

    const activeLocale = (localeService) => {
      try {
        const snapshot = localeService?.getSnapshot?.();
        return snapshot?.active ?? snapshot?.locale ?? '';
      } catch {
        return '';
      }
    };

    const t = (key) => {
      const active = String(localeReader() ?? '');
      const table = active.toLowerCase().startsWith('zh') ? ZH : EN;
      return table[key] ?? EN[key] ?? key;
    };

    const TOKENS = {
      text: 'var(--dsw-alias-text-primary, currentColor)',
      muted: 'var(--dsw-alias-text-secondary, color-mix(in srgb, currentColor 62%, transparent))',
      border: 'var(--dsw-alias-border-secondary, color-mix(in srgb, currentColor 18%, transparent))',
      surface: 'var(--dsw-alias-bg-elevated, color-mix(in srgb, currentColor 5%, transparent))',
      input: 'var(--dsw-alias-bg-base, transparent)',
      accent: 'var(--dsw-alias-brand-primary, #4f7cff)',
      danger: 'var(--dsw-alias-text-danger, #d9534f)',
    };

    const controlStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 6,
      border: `1px solid ${TOKENS.border}`,
      background: TOKENS.input,
      color: TOKENS.text,
      font: 'inherit',
      fontSize: 13,
    };
    const labelStyle = { width: 128, flex: '0 0 auto', paddingTop: 6, fontSize: 13, color: TOKENS.muted };
    const rowStyle = { display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 };
    const hintStyle = { fontSize: 12, color: TOKENS.muted, marginTop: 4, lineHeight: 1.5 };

    function Row(props) {
      return h(
        'div',
        { style: rowStyle },
        h('div', { style: labelStyle }, props.label),
        h(
          'div',
          { style: { flex: 1, minWidth: 0 } },
          props.children,
          props.hint ? h('div', { style: hintStyle }, props.hint) : null,
        ),
      );
    }

    function TextField(props) {
      return h('input', {
        type: props.type ?? 'text',
        value: props.value ?? '',
        placeholder: props.placeholder,
        spellCheck: false,
        autoComplete: 'off',
        style: controlStyle,
        onChange: (event) => props.onChange(event.target.value),
      });
    }

    function SelectField(props) {
      return h(
        'select',
        { value: props.value, style: controlStyle, onChange: (event) => props.onChange(event.target.value) },
        props.options.map((option) =>
          h('option', { key: String(option), value: String(option) }, props.format ? props.format(option) : String(option)),
        ),
      );
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          disabled: props.disabled,
          onClick: props.onClick,
          style: {
            padding: '6px 14px',
            borderRadius: 6,
            border: props.primary ? '1px solid transparent' : `1px solid ${props.danger ? TOKENS.danger : TOKENS.border}`,
            background: props.primary ? TOKENS.accent : 'transparent',
            color: props.primary ? '#fff' : props.danger ? TOKENS.danger : TOKENS.text,
            cursor: props.disabled ? 'default' : 'pointer',
            opacity: props.disabled ? 0.55 : 1,
            font: 'inherit',
            fontSize: 13,
          },
        },
        props.children,
      );
    }

    function Chip(props) {
      return h(
        'button',
        {
          type: 'button',
          onClick: props.onClick,
          style: {
            padding: '3px 9px',
            borderRadius: 999,
            border: `1px solid ${props.active ? TOKENS.accent : TOKENS.border}`,
            background: 'transparent',
            color: props.active ? TOKENS.accent : TOKENS.muted,
            cursor: 'pointer',
            fontSize: 12,
            font: 'inherit',
          },
        },
        props.children,
      );
    }

    function CheckField(props) {
      return h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: TOKENS.text, marginBottom: 6 } },
        h('input', {
          type: 'checkbox',
          checked: props.value,
          style: { margin: 0 },
          onChange: (event) => props.onChange(event.target.checked),
        }),
        props.label,
      );
    }

    const asNumber = (value, fallback) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const SIZE_STEP = 16;
    const MIN_PIXELS = 655360;
    const MAX_PIXELS = 8294400;

    function checkSize(value, maxEdge) {
      if (!value || value === 'auto') return { ok: true, auto: true };
      const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
      if (!match) return { ok: false, reason: 'format' };
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width % SIZE_STEP !== 0 || height % SIZE_STEP !== 0) return { ok: false, reason: 'step' };
      if (Math.max(width, height) / Math.min(width, height) > 3) return { ok: false, reason: 'ratio' };
      if (Math.max(width, height) > maxEdge) return { ok: false, reason: 'cap', maxEdge };
      const pixels = width * height;
      if (pixels < MIN_PIXELS) return { ok: false, reason: 'floor', minPixels: MIN_PIXELS };
      if (pixels > MAX_PIXELS) return { ok: false, reason: 'ceiling', maxPixels: MAX_PIXELS };
      return { ok: true, value: `${width}x${height}` };
    }

    function resolutionNotice(value, maxEdge, t) {
      const verdict = checkSize(value, maxEdge);
      if (verdict.ok) return null;
      const text =
        verdict.reason === 'step'
          ? t('sizeStepError')
          : verdict.reason === 'cap'
            ? t('sizeCapError').replace('{cap}', String(verdict.maxEdge))
            : verdict.reason === 'ratio'
              ? t('sizeRatioError')
              : verdict.reason === 'floor'
                ? t('sizeFloorError').replace('{min}', String(verdict.minPixels))
                : verdict.reason === 'ceiling'
                  ? t('sizeCeilingError').replace('{max}', String(verdict.maxPixels))
                  : t('sizeFormatError');
      return h('div', { 'data-size-error': verdict.reason, style: { fontSize: 12, color: TOKENS.danger, marginTop: 6 } }, text);
    }

    function normalize(raw) {
      return {
        apiUrl: typeof raw?.apiUrl === 'string' ? raw.apiUrl : '',
        model: typeof raw?.model === 'string' ? raw.model : '',
        count: asNumber(raw?.count, 1),
        outputFormat: typeof raw?.outputFormat === 'string' ? raw.outputFormat : 'png',
        outputCompression: asNumber(raw?.outputCompression, 100),
        background: typeof raw?.background === 'string' ? raw.background : 'auto',
        moderation: typeof raw?.moderation === 'string' ? raw.moderation : 'auto',
        user: typeof raw?.user === 'string' ? raw.user : '',
        outputDir: typeof raw?.outputDir === 'string' ? raw.outputDir : '',
        fileNameFormat: typeof raw?.fileNameFormat === 'string' ? raw.fileNameFormat : '{time}-{prompt}',
        defaultResolution: typeof raw?.defaultResolution === 'string' ? raw.defaultResolution : 'auto',
        requestTimeoutSec: asNumber(raw?.requestTimeoutSec, 600),
        maxEdge: asNumber(raw?.maxEdge, 3840),
        sendsModeration: raw?.sendsModeration !== false,
        sendsOutputCompression: raw?.sendsOutputCompression !== false,
      };
    }

    const unwrap = (response) => {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok) return { ok: true, value: response.value };
        const message = response.error?.message ?? response.error?.code ?? 'the settings call was refused';
        return { ok: false, message: String(message) };
      }
      return { ok: true, value: response };
    };

    function makeSettingsSection(resolveApi) {
      return function SettingsSection() {
        const t = useLanguage();
        const [state, setState] = useState({ status: 'loading' });
        const [form, setForm] = useState(null);
        const [keyDraft, setKeyDraft] = useState(null);
        const [busy, setBusy] = useState(false);
        const [message, setMessage] = useState(null);

        const [recordsConfirm, setRecordsConfirm] = useState(false);
        const [recordsMessage, setRecordsMessage] = useState(null);

        const load = useCallback(async () => {
          const api = resolveApi();
          if (!api || typeof api.describe !== 'function') {
            setState({
              status: 'error',
              message: `${t('noSettingsApi')} (resolveApi returned ${api === undefined ? 'undefined' : typeof api})`,
            });
            return;
          }
          try {
            const described = unwrap(await api.describe());
            if (!described.ok) {
              setState({ status: 'error', message: described.message });
              return;
            }
            const payload = described.value;
            const views = Array.isArray(payload?.namespaces) ? payload.namespaces : [];
            const view =
              views.find((row) => row.ns === NS) ??
              views.find((row) => row.value && typeof row.value === 'object' && 'apiUrl' in row.value && 'outputFormat' in row.value);
            if (!view) {
              setState({ status: 'missing' });
              return;
            }
            setForm(normalize(view.value));
            setState({
              status: 'ready',
              ns: view.ns,
              revision: view.revision,
              writable: payload?.writable !== false,
              secrets: Array.isArray(view.secrets) ? view.secrets : [],
            });
          } catch (error) {
            setState({ status: 'error', message: String(error?.message ?? error) });
          }
        }, []);

        useEffect(() => {
          load();
        }, [load]);

        const patch = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

        const save = async () => {
          const api = resolveApi();
          if (!api || state.status !== 'ready') return;
          setBusy(true);
          setMessage(null);
          try {
            const ops = FIELDS.filter((field) => field !== 'secret').map((field) => ({
              op: 'set',
              path: [field],
              value: form[field],
            }));
            if (keyDraft) ops.push({ op: 'set', path: ['secret'], value: keyDraft });
            const written = unwrap(await api.mutate(state.ns, ops, state.revision));
            if (!written.ok) {
              setMessage({ kind: 'error', text: written.message.includes('conflict') ? t('conflict') : written.message });
              if (written.message.includes('conflict')) load();
              return;
            }
            const view = written.value;
            setForm(normalize(view?.value ?? form));
            setState((current) => ({
              ...current,
              revision: view?.revision ?? current.revision,
              secrets: Array.isArray(view?.secrets) ? view.secrets : current.secrets,
            }));
            setKeyDraft(null);
            setMessage({ kind: 'ok', text: t('saved') });
          } catch (error) {
            const text = String(error?.message ?? error);
            setMessage({ kind: 'error', text: text.includes('conflict') ? t('conflict') : text });
            if (text.includes('conflict')) load();
          } finally {
            setBusy(false);
          }
        };

        const clearRecords = async () => {
          setBusy(true);
          setRecordsMessage(null);
          try {
            const response = await fetch(RECORDS_ROUTE, {
              method: 'POST',
              headers: { 'x-dsh-image-generation-action': 'clear-records' },
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              setRecordsMessage(`${t('clearFailed')}: ${payload?.error ?? response.status}`);
              setRecordsConfirm(false);
              return;
            }
            const cleared = Number(payload?.cleared ?? 0);
            setRecordsMessage(t('clearDone').replace('{n}', String(Number.isFinite(cleared) ? cleared : 0)));
            setRecordsConfirm(false);
          } catch (error) {
            setRecordsMessage(`${t('clearFailed')}: ${String(error?.message ?? error)}`);
            setRecordsConfirm(false);
          } finally {
            setBusy(false);
          }
        };

        if (state.status === 'loading') {
          return h('div', { style: { fontSize: 13, color: TOKENS.muted } }, t('loading'));
        }
        if (state.status === 'missing') {
          return h('div', { style: { fontSize: 13, color: TOKENS.muted } }, t('missing'));
        }
        if (state.status === 'error') {
          return h('div', { style: { fontSize: 13, color: TOKENS.danger } }, state.message);
        }

        const keyIsSet = state.secrets.some(
          (secret) => Array.isArray(secret.path) && secret.path[0] === 'secret' && secret.set,
        );
        const compressionLocked = form.outputFormat === 'png';

        return h(
          'div',
          { style: { maxWidth: 640, padding: '4px 2px 24px' } },
          h(
            'div',
            { style: { marginBottom: 16 } },
            h('div', { style: { fontSize: 15, fontWeight: 600, color: TOKENS.text } }, t('title')),
            h('div', { style: hintStyle }, t('subtitle')),
          ),

          h('div', { style: { fontSize: 13, fontWeight: 600, color: TOKENS.text, margin: '0 0 10px' } }, t('sectionConnection')),

          h(
            Row,
            { label: t('labelModel'), hint: t('hintModel') },
            h(TextField, { value: form.model, placeholder: 'gpt-image-2.5-flare', onChange: patch('model') }),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
              BUILTIN_MODELS.map((model) =>
                h(Chip, { key: model, active: form.model === model, onClick: () => patch('model')(model) }, model),
              ),
            ),
          ),

          h(
            Row,
            { label: t('labelApiUrl'), hint: t('hintApiUrl') },
            h(TextField, { value: form.apiUrl, placeholder: 'https://api.openai.com/v1', onChange: patch('apiUrl') }),
          ),
          h(
            Row,
            { label: t('labelApiKey'), hint: keyIsSet ? t('hintApiKeySet') : t('hintApiKeyEmpty') },
            h(TextField, {
              type: 'password',
              value: keyDraft ?? '',
              placeholder: keyIsSet ? '••••••••' : 'sk-...',
              onChange: setKeyDraft,
            }),
          ),

          h('div', { style: { fontSize: 13, fontWeight: 600, color: TOKENS.text, margin: '20px 0 10px' } }, t('sectionDefaults')),
          h('div', { style: { ...hintStyle, marginTop: -6, marginBottom: 10 } }, t('hintDefaults')),

          h(
            Row,
            { label: t('labelCount'), hint: t('hintCount') },
            h(SelectField, {
              value: form.count,
              options: COUNTS,
              onChange: (value) => patch('count')(asNumber(value, 1)),
            }),
          ),

          h(
            Row,
            { label: t('labelFormat'), hint: t('hintFormat') },
            h(SelectField, { value: form.outputFormat, options: FORMATS, onChange: patch('outputFormat') }),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 } },
              h('span', { style: { fontSize: 12, color: TOKENS.muted, width: 92 } }, t('labelCompression')),
              h('input', {
                type: 'range',
                min: 0,
                max: 100,
                value: form.outputCompression,
                disabled: compressionLocked,
                style: { flex: 1, opacity: compressionLocked ? 0.45 : 1 },
                onChange: (event) => patch('outputCompression')(asNumber(event.target.value, 100)),
              }),
              h('span', { style: { fontSize: 12, color: TOKENS.muted, width: 30 } }, String(form.outputCompression)),
            ),
          ),

          h(
            Row,
            { label: t('labelBackground'), hint: t('hintBackground') },
            h(SelectField, { value: form.background, options: BACKGROUNDS, onChange: patch('background') }),
          ),

          h(
            Row,
            { label: t('labelModeration'), hint: t('hintModeration') },
            h(SelectField, { value: form.moderation, options: MODERATIONS, onChange: patch('moderation') }),
          ),

          h(
            Row,
            { label: t('labelUser'), hint: t('hintUser') },
            h(TextField, { value: form.user, onChange: patch('user') }),
          ),

          h(
            Row,
            { label: t('labelOutputDir'), hint: t('hintOutputDir') },
            h(TextField, { value: form.outputDir, placeholder: t('outputDirPlaceholder'), onChange: patch('outputDir') }),
          ),

          h(
            Row,
            { label: t('labelFileName'), hint: t('hintFileName') },
            h(TextField, {
              value: form.fileNameFormat,
              placeholder: t('fileNamePlaceholder'),
              onChange: patch('fileNameFormat'),
            }),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
              NAME_PRESETS.map((preset) =>
                h(
                  Chip,
                  { key: preset, active: form.fileNameFormat === preset, onClick: () => patch('fileNameFormat')(preset) },
                  preset,
                ),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
              NAME_TOKENS.map((token) =>
                h(
                  'button',
                  {
                    key: token,
                    type: 'button',
                    onClick: () => patch('fileNameFormat')(`${form.fileNameFormat ?? ''}${token}`),
                    style: {
                      padding: '2px 8px',
                      borderRadius: 6,
                      border: `1px dashed ${TOKENS.border}`,
                      background: 'transparent',
                      color: TOKENS.muted,
                      cursor: 'pointer',
                      fontSize: 12,
                      font: 'inherit',
                    },
                  },
                  token,
                ),
              ),
            ),
          ),

          h(
            Row,
            { label: t('labelResolution'), hint: t('hintResolution') },
            h(TextField, {
              value: form.defaultResolution === 'auto' ? '' : form.defaultResolution,
              placeholder: t('resolutionPlaceholder'),
              onChange: (value) => patch('defaultResolution')(value.trim().toLowerCase() || 'auto'),
            }),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
              RESOLUTION_PRESETS.map((preset) =>
                h(
                  Chip,
                  {
                    key: preset,
                    active: form.defaultResolution === preset,
                    onClick: () => patch('defaultResolution')(preset),
                  },
                  preset === 'auto' ? t('resolutionAuto') : preset,
                ),
              ),
            ),
            resolutionNotice(form.defaultResolution, form.maxEdge, t),
          ),

          h(
            Row,
            { label: t('labelMaxEdge'), hint: t('hintMaxEdge') },
            h(TextField, {
              type: 'number',
              value: form.maxEdge,
              onChange: (value) => patch('maxEdge')(asNumber(value, 3840)),
            }),
          ),

          h(
            Row,
            { label: t('labelCompatibility'), hint: t('hintCompatibility') },
            h(CheckField, {
              label: t('toggleModeration'),
              value: form.sendsModeration,
              onChange: patch('sendsModeration'),
            }),
            h(CheckField, {
              label: t('toggleCompression'),
              value: form.sendsOutputCompression,
              onChange: patch('sendsOutputCompression'),
            }),
          ),

          h(
            Row,
            { label: t('labelTimeout'), hint: t('hintTimeout') },
            h(TextField, {
              type: 'number',
              value: form.requestTimeoutSec,
              onChange: (value) => patch('requestTimeoutSec')(asNumber(value, 600)),
            }),
          ),

          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 } },
            h(Button, { primary: true, disabled: busy || !state.writable, onClick: save }, busy ? t('saving') : t('save')),
            h(Button, { disabled: busy, onClick: load }, t('reload')),
            message
              ? h(
                  'span',
                  { style: { fontSize: 12, color: message.kind === 'ok' ? TOKENS.muted : TOKENS.danger } },
                  message.text,
                )
              : null,
          ),

          h(
            'div',
            { style: { marginTop: 22, paddingTop: 16, borderTop: `1px solid ${TOKENS.border}` } },
            h('div', { style: { fontSize: 13, fontWeight: 600, color: TOKENS.text, marginBottom: 8 } }, t('sectionMaintenance')),
            recordsConfirm
              ? h(
                  'div',
                  {
                    style: {
                      border: `1px solid ${TOKENS.danger}`,
                      borderRadius: 6,
                      padding: '10px 12px',
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: TOKENS.text,
                    },
                  },
                  h('div', { style: { fontWeight: 600, color: TOKENS.danger, marginBottom: 4 } }, t('clearWarnTitle')),
                  h('div', { style: { color: TOKENS.muted, marginBottom: 10 } }, t('clearWarnBody')),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                    h(Button, { danger: true, disabled: busy, onClick: clearRecords }, t('clearConfirm')),
                    h(Button, { disabled: busy, onClick: () => setRecordsConfirm(false) }, t('clearCancel')),
                  ),
                )
              : h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 12 } },
                  h(Button, { disabled: busy, onClick: () => { setRecordsMessage(null); setRecordsConfirm(true); } }, t('clearButton')),
                  recordsMessage
                    ? h('span', { style: { fontSize: 12, color: TOKENS.muted } }, recordsMessage)
                    : h('span', { style: hintStyle }, t('clearHint')),
                ),
          ),
          state.writable ? null : h('div', { style: { ...hintStyle, marginTop: 10 } }, t('readOnly')),
        );
      };
    }

    function readImages(meta) {
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
      if (!Array.isArray(meta.images)) return null;
      const usable = [];
      for (const image of meta.images) {
        if (!image || typeof image !== 'object') continue;
        let url;
        try {
          url = image.url;
        } catch {
          continue;
        }

        if (typeof url !== 'string' || url.length === 0) continue;
        let path = '';
        try {
          path = typeof image.path === 'string' ? image.path : '';
        } catch {
          path = '';
        }
        usable.push({ url, path });
      }
      return usable;
    }

    function parseArgs(raw) {
      if (typeof raw !== 'string') return null;
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }

    function parsePartialArgs(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return null;
      const salvaged = {};
      for (const field of ['prompt', 'resolution', 'quality', 'background', 'location']) {
        const pattern = new RegExp(String.raw`"` + field + String.raw`"\s*:\s*"((?:[^"\\]|\\.)*)"?`);
        const match = pattern.exec(raw);
        if (!match) continue;
        try {
          salvaged[field] = JSON.parse(`"${match[1]}"`);
        } catch {
          salvaged[field] = match[1];
        }
      }
      const number = /"count"\s*:\s*(\d+)/.exec(raw);
      if (number) salvaged.count = Number(number[1]);
      return Object.keys(salvaged).length > 0 ? salvaged : null;
    }

    function renderDisclosure(label, expanded, onToggle, body) {
      return h(
        'div',
        { style: { marginTop: 8 } },
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': expanded ? 'true' : 'false',
            onClick: onToggle,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: '4px 0',
              border: 'none',
              background: 'transparent',
              color: TOKENS.muted,
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12,
              textAlign: 'left',
            },
          },
          h('span', { 'aria-hidden': 'true', style: { display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none' } }, '▶'),
          label,
        ),
        expanded ? body : null,
      );
    }

    const PANE_STYLE = {
      marginTop: 6,
      padding: '8px 10px',
      border: `1px solid ${TOKENS.border}`,
      borderRadius: 6,
      background: TOKENS.input,
      color: TOKENS.text,
      fontSize: 12,
      lineHeight: 1.6,
    };

    const LIVE_PROMPT_LINES = 5;
    const LIVE_PROMPT_LINE_HEIGHT = 20;

    const LIVE_PROMPT_MAX_HEIGHT = LIVE_PROMPT_LINES * LIVE_PROMPT_LINE_HEIGHT + 16;
    const LIVE_PROMPT_STYLE = {
      ...PANE_STYLE,
      fontSize: 12,
      lineHeight: `${LIVE_PROMPT_LINE_HEIGHT}px`,
      maxHeight: `${LIVE_PROMPT_MAX_HEIGHT}px`,
      overflow: 'hidden',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    };
    const LIVE_PROMPT_CUT_STYLE = {
      ...LIVE_PROMPT_STYLE,
      // No line-clamp: the cut already appends an ellipsis, and the clamp would draw a second.
    };

    function promptPane(prompt, prefix) {
      return h(
        'div',
        {
          key: `${prefix}-prompt`,
          style: { ...PANE_STYLE, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto' },
        },
        prompt,
      );
    }

    function measureLineCut(element, maxHeight) {
      const doc = element?.ownerDocument;
      if (!doc?.createRange || typeof doc.createTreeWalker !== 'function' || !element.firstChild) return null;
      // Read once: inside the loop this forced a layout per character.
      const paneTop = element.getBoundingClientRect().top;
      const walker = doc.createTreeWalker(element, 4);
      const range = doc.createRange();
      let consumed = 0;
      let whole = '';
      let node = walker.nextNode();
      while (node) {
        const value = typeof node.nodeValue === 'string' ? node.nodeValue : '';
        whole += value;
        for (let index = 0; index < value.length; index += 1) {
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const box = range.getBoundingClientRect();

          if (box.height === 0 && box.width === 0) {
            consumed += 1;
            continue;
          }

          if (box.bottom - paneTop >= maxHeight) {
            return { text: whole.slice(0, consumed), truncated: true };
          }
          consumed += 1;
        }
        node = walker.nextNode();
      }
      return { text: whole, truncated: false };
    }

    function LivePrompt(props) {
      const { prompt, label, lines, lineHeight, style, cutStyle } = props;
      const [measured, setMeasured] = useState(null);
      const ref = React.useRef(null);

      // Dropping the dependency array runs this every commit and makes the state update
      // unbounded (React error #185).
      useLayoutEffect(() => {
        const measure = () => {
          const found = measureLineCut(ref.current, lines * lineHeight);
          if (!found) return;
          setMeasured((current) => {
            if (current && current.prompt === prompt && current.text === found.text && current.truncated === found.truncated) {
              return current;
            }
            return { prompt, text: found.text, truncated: found.truncated };
          });
        };
        measure();
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('resize', measure);
          return () => window.removeEventListener('resize', measure);
        }
        return undefined;
      }, [prompt, lines, lineHeight, measured === null]);

      React.useEffect(() => {
        setMeasured((current) => (current && current.prompt !== prompt ? null : current));
      }, [prompt]);

      const cut = measured && measured.prompt === prompt ? measured.text : null;
      const shown = cut === null ? prompt : cut;
      const truncated = Boolean(measured && measured.prompt === prompt && measured.truncated);
      const paneStyle = cut === null ? style : cutStyle;

      return h(
        'div',
        { key: 'live-prompt', style: { marginTop: 8 } },
        h('div', { style: { fontSize: 12, color: TOKENS.muted, marginBottom: 4 } }, label),
        h('div', { ref, style: paneStyle }, shown, truncated ? h('span', { 'data-live-prompt-cut': 'true' }, '…') : null),
      );
    }

    function renderPromptDisclosure(prompt, expanded, onToggle, label) {
      if (typeof prompt !== 'string' || prompt.length === 0) return null;
      return renderDisclosure(`${label} (${prompt.length})`, expanded, onToggle, promptPane(prompt, 'collapsed'));
    }

    function renderLivePrompt(prompt, t) {
      if (typeof prompt !== 'string' || prompt.length === 0) return null;
      return h(LivePrompt, {
        key: 'live-prompt',
        prompt,

        label: `${t('livePrompt')} (${t('receivedChars').replace('{n}', String(prompt.length))})`,
        lines: LIVE_PROMPT_LINES,
        lineHeight: LIVE_PROMPT_LINE_HEIGHT,
        style: LIVE_PROMPT_STYLE,
        cutStyle: LIVE_PROMPT_CUT_STYLE,
      });
    }

    function renderParamsDisclosure(args, images, expanded, onToggle, t) {
      const hasArgs = args && typeof args === 'object';
      const rows = [];
      const add = (key, value) => {
        if (value !== undefined && value !== null && value !== '') rows.push(h('div', { key }, `${t(key)}: ${String(value)}`));
      };
      if (hasArgs) {
        add('paramResolution', args.resolution ?? 'auto');
        add('paramQuality', args.quality);
        add('paramCount', args.count);
        add('paramBackground', args.background);
        add('paramLocation', args.location);
        if (Array.isArray(args.images)) add('paramImages', args.images.length);
        add('paramMask', args.mask);
      }

      if (images && images.length > 0) add('paramFiles', images.length);
      if (rows.length === 0) return null;
      return renderDisclosure(
        `${t('expandParams')} (${rows.length})`,
        expanded,
        onToggle,
        h('div', { style: PANE_STYLE }, rows),
      );
    }

    const usableDisclosure = (candidate) =>
      candidate && typeof candidate.expanded === 'boolean' && typeof candidate.toggle === 'function' ? candidate : null;

    function makeToolCardFace() {
      return { hooks: { toolCallArgumentsPartial: bindToolCallArgumentsPartial } };
    }

    function bindToolCallArgumentsPartial(_standard, context) {
      const assistant = context?.assistant;
      const callId = context?.callId;
      const subscribe = (listener) => (assistant === undefined ? () => {} : assistant.subscribe(listener));
      const getSnapshot = () => {

        try {
          if (assistant === undefined) return '';
          const blocks = assistant.getSnapshot()?.blocks;
          if (!Array.isArray(blocks)) return '';
          const found = blocks.find((candidate) => candidate.kind === 'tool-call' && candidate.callId === callId);
          return found && typeof found.argsRaw === 'string' ? found.argsRaw : '';
        } catch {
          return '';
        }
      };
      return function useToolCallArgumentsPartial() {
        return useSyncExternalStore(subscribe, getSnapshot);
      };
    }

    function ToolCallView(props) {
      const t = useLanguage();

      const safeProps = props && typeof props === 'object' ? props : {};
      const block = safeProps.block && typeof safeProps.block === 'object' ? safeProps.block : {};
      const [fallbackPromptOpen, setFallbackPromptOpen] = useState(false);
      const [fallbackParamsOpen, setFallbackParamsOpen] = useState(false);

      let promptHarness = null;
      let paramsHarness = null;
      try {
        promptHarness = usableDisclosure(typeof safeProps.useDisclosure === 'function' ? safeProps.useDisclosure() : null);
      } catch {
        promptHarness = null;
      }
      try {
        paramsHarness = usableDisclosure(typeof safeProps.useDisclosure === 'function' ? safeProps.useDisclosure() : null);
      } catch {
        paramsHarness = null;
      }

      let livePartial = null;
      try {
        livePartial = typeof safeProps.useToolCallArgumentsPartial === 'function' ? safeProps.useToolCallArgumentsPartial() : null;
      } catch {
        livePartial = null;
      }

      const settled = safeProps.phase === 'result';
      const running = !settled;
      const liveArgs = typeof livePartial === 'string' && livePartial.length > 0 ? livePartial : null;
      const carriedArgs = typeof block.argsRaw === 'string' && block.argsRaw.length > 0 ? block.argsRaw : null;

      const rawArgs = settled ? (block.call?.argsRaw ?? carriedArgs) : (liveArgs ?? carriedArgs);
      const args = parseArgs(rawArgs) ?? parsePartialArgs(rawArgs);
      const images = settled ? readImages(block.meta) : null;
      const prompt = typeof args?.prompt === 'string' ? args.prompt : '';

      const promptOpen = promptHarness ? promptHarness.expanded : fallbackPromptOpen;
      const paramsOpen = paramsHarness ? paramsHarness.expanded : fallbackParamsOpen;
      const togglePrompt = () => {
        if (promptHarness) promptHarness.toggle();
        else setFallbackPromptOpen((value) => !value);
      };
      const toggleParams = () => {
        if (paramsHarness) paramsHarness.toggle();
        else setFallbackParamsOpen((value) => !value);
      };

      return h(
        'div',
        {
          style: {
            border: `1px solid ${TOKENS.border}`,
            borderRadius: 8,
            padding: 12,
            margin: '6px 0',
            background: TOKENS.surface,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: images?.length ? 10 : 6 } },
          h('span', { style: { fontSize: 13, fontWeight: 600, color: TOKENS.text } }, t('cardTitle')),
          h(
            'span',
            { style: { fontSize: 12, color: TOKENS.muted } },
            settled ? `${images?.length ?? 0} ${t('images')}` : t('running'),
          ),
        ),
        images?.length
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
              images.map((image, index) =>
                h(
                  'a',
                  {
                    key: `${image.url}-${index}`,
                    href: image.url,
                    target: '_blank',
                    rel: 'noreferrer',
                    title: image.path ?? '',

                    style: { display: 'block', lineHeight: 0, width: 260, height: 260, overflow: 'hidden', borderRadius: 6 },
                  },
                  h('img', {
                    src: image.url,
                    alt: t('imageAlt'),
                    style: {
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      borderRadius: 6,
                      border: `1px solid ${TOKENS.border}`,
                      display: 'block',
                    },
                  }),
                ),
              ),
            )
          : null,

        running && prompt
          ? renderLivePrompt(prompt, t)
          : renderPromptDisclosure(prompt, promptOpen, togglePrompt, t('expandPrompt')),
        renderParamsDisclosure(args, images, paramsOpen, toggleParams, t),
      );
    }

    class ToolCardBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failure: null };
      }

      static getDerivedStateFromError(error) {
        return { failure: error };
      }

      render() {
        if (this.state.failure) {
          const chinese = localeReader() === 'zh-CN';
          const reason = String(this.state.failure?.message ?? this.state.failure);
          return h(
            'div',
            {
              style: {
                border: `1px solid ${TOKENS.border}`,
                borderRadius: 8,
                padding: 12,
                margin: '6px 0',
                background: TOKENS.surface,
                fontSize: 12,
                color: TOKENS.muted,
              },
            },
            h('div', { style: { fontWeight: 600, color: TOKENS.text, marginBottom: 4 } }, chinese ? ZH.cardTitle : EN.cardTitle),
            `${chinese ? ZH.cardFailed : EN.cardFailed}: ${reason}`,
          );
        }
        return h(ToolCallView, this.props);
      }
    }

    return {

      inject: ['slots', 'locale', 'remote', 'remote.settings'],
      apply(ctx) {
        const localeService = ctx.locale;
        localeReader = () => activeLocale(localeService);
        localeStore.source = localeService;
        ctx.effect(
          () => localeService.register(LOCALE_NS, { zh: ZH, en: EN }),
          'image-generation: copy dictionaries',
        );
        ctx.effect(
          () =>
            localeService.subscribe(() => {
              for (const listener of [...localeStore.listeners]) listener();
            }),
          'image-generation: follow the locale',
        );

        const resolveApi = () => {
          try {
            return ctx.remote?.settings ?? ctx.get('remote.settings');
          } catch {
            return undefined;
          }
        };

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: SECTION_ID, order: 13, label: () => t('section') },
            makeSettingsSection(resolveApi, localeService),
          ),
        );

        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            {
              name: 'tool.call.toolview',
              key: 'generate_image',

              inject: makeToolCardFace,
            },
            ToolCardBoundary,
          ),
        );
      },
    };
  },
});
