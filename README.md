# dsh-image-generation

![dsh-image-gen-plugin](assets/dsh-image-gen-plugin-logo.png)

一个 DeepSeek Harness 插件包，做两件事：

1. 给 Agent 注入一个 `generate_image` 工具：给提示词就能出图，并落盘到本机。
2. 在「设置」里加一页「图片生成」：模型、接口地址、密钥、输出格式等都在这里配。

请求走的是 **OpenAI 兼容的 `POST {apiUrl}/images/generations`**，参数名与 Dasipaint 的 `openai.rs::build_request` 一致（`model` / `prompt` / `n` / `size` / `quality` / `output_format` / `background`），所以官方 OpenAI、各种中转网关、自建反向代理都能用。

这个工具不挑模型类型：端点背后是自然语言驱动的自回归绘画模型时，提示词会原样透传，不做任何 GPT-image 风格的模板包装；端点背后是别的图片模型时，也照发不误。真正只有 OpenAI 图片接口才认的字段（`moderation`）默认就不发，还给了开关，见「设置项」。

**目录**

- [安装](#安装)
- [使用](#使用)
- [工具参数](#工具参数)
  - [图生图](#图生图)
  - [自定义分辨率的规则](#自定义分辨率的规则)
  - [画质档位](#画质档位)
  - [文件名模板](#文件名模板)
- [怎么写提示词](#怎么写提示词)
- [设置项](#设置项)
- [工具卡片](#工具卡片)
- [自检](#自检)
- [文件](#文件)
- [安全](#安全)
- [行为说明](#行为说明)
- [关于源码里的两处约定](#关于源码里的两处约定)
- [许可与来源](#许可与来源)

## 安装

`dsh plugin add` 会把包装进 profile，并对照包里的 `dsh.bundle.patch` 把它追加到 profile 的 bundle 栈上，不需要手改任何配置文件。

```powershell
dsh plugin --profile web add dsh-image-gen-plugin
```

Harness 里也可以让 Agent 执行 `plugin_manager` 的 `install_bundle`，`target` 填包名 `dsh-image-gen-plugin`。

或者从源码安装 —— 这个目录本身就是完整的包，不需要构建，把上面的包名换成本目录的绝对路径即可：

```powershell
dsh plugin --profile web add "D:\MyProject\deepseek-image-generation\dsh-image-gen-plugin"
```

装完刷新一下页面（`http://127.0.0.1:3080`）。升级：改完源码后重新跑一次 `add` 会覆盖安装；Host 侧的 JavaScript 需要重启 DSH 才会加载新的一代。

卸载：

```powershell
dsh plugin --profile web remove dsh-image-gen-plugin
```

## 使用

1. **设置 → 图片生成**：填 API 地址、API 密钥，选模型。
2. 新会话里对 Agent 说「画一只戴帽子的柯基」，它会调用 `generate_image`，图片落在输出目录里，聊天卡片上直接显示。
3. 图生图就直接把源图路径给它，说清楚要改什么。

## 工具参数

`generate_image` 暴露 8 个参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 提示词，用自然语言写。要求图里出现文字时，把文字原样引号写清楚，并说明位置和排法 |
| `resolution` | 否 | **自动比例**（`auto`，默认）或自定义分辨率。自定义写 `宽x高`，如 `1536x864` |
| `quality` | 否 | 画质：`low` / `medium` / `high` / `xhigh` / `max`，对应 低画质 / 标准画质 / 高画质 / 超高画质 / 顶级画质 |
| `count` | 否 | 本次生成几张，1–10；不传就用设置里的默认值 |
| `background` | 否 | `auto` / `transparent` / `opaque` |
| `location` | 否 | 存储位置。**不传就是会话工作区**；相对路径相对工作区解析，绝对路径原样使用，目录不存在会自动创建 |
| `images` | 否 | **图生图**：源图路径数组。最多 16 张，每张 ≤50MB |
| `mask` | 否 | 可选的 PNG 蒙版，标注要改的区域，**必须恰好配 1 张源图**。透明像素是允许重绘的区域，不透明像素保留 |

后几个不传时都取设置页里的默认值；**画质不在设置里**，它是纯调用参数，省略时按 `high` 出图。

**没有 `mode` 参数**：「生成」还是「编辑」由 `images` 有没有值决定——**这一个开关就够了**，多一个参数只会多一种自相矛盾的可能（声明 edit 却不给源图、声明 generate 却给了源图）。传 `images` 就是编辑，不传就是生成。

### 图生图

传 `images` 就把调用从「生成」变成「编辑」：

| | 无 `images`（文生图） | 有 `images`（图生图） |
| --- | --- | --- |
| 端点 | `POST /images/generations` | `POST /images/edits` |
| 编码 | `application/json` | `multipart/form-data` |
| 源图 | — | `image` 字段，可多张（**API 硬上限 16 张**） |
| 蒙版 | — | `mask` 字段，**恰好 1 张 PNG，且只配 1 张源图** |

提示词写法要跟着换：文生图描述整幅画面，图生图描述**改动**（"把背景换成纯色影棚墙"、"把毛色改成姜黄"、"加一条红围巾"）。

两条链路都有回归测试：断言传源图时确实打到 `/images/edits` 且是 multipart，以及**纯文本调用仍然走 `/images/generations` 的 JSON**（防止我把所有调用都塞进编辑分支）。

multipart 是**手写编码**，不是 `FormData`：boundary、CRLF、每个 part 的头部都由本插件控制。网关对 multipart 的挑剔远超 JSON，用 `FormData` 只能拿到一句「400 Bad Request」，手写能让失败指到具体位置。断言逐字节检查了开头的 boundary、结尾的 `--boundary--`、每个 part 的 `Content-Disposition`、`image` part 的 filename 与 Content-Type、数字字段以文本传输、以及**源图字节原样嵌入**。

### 自定义分辨率的规则

尺寸校验照抄 Dasipaint 的 `openai.rs::validate_size` 与 OpenAI 图片接口的文档，按同样的顺序校验：

1. 宽和高都必须是 **16 的整数倍**；
2. 长宽比不超过 **3:1**（即 1:3–3:1）；
3. 最长边不超过 **3840**；
4. 总像素在 **655,360 – 8,294,400** 之间。

第 4 条是关键：**3840×3840 反而超限**（14,745,600 像素），能被接受的尺寸里最大的正方形是 2880×2880；3840×2160 是合法且可用的。批量出图时注意这一点。

工具描述里附了一份全都合法的现成尺寸，覆盖竖版（知识卡、海报）、横版（导图、幻灯片）和超宽（时间轴、横幅）三种版式，例如 `1024x768` / `768x1024` / `2048x1536` / `3840x2160` / `2160x3840` / `3840x1920` / `3696x1584` / `2048x1024`。

### 画质档位

`quality` 五档，从低到高：`low`（低画质）、`medium`（标准画质）、`high`（高画质）、`xhigh`（超高画质）、`max`（顶级画质）。这五档沿用 Dasipaint `genspec.ts::GEN_QUALITIES` 的划分，直接映射到请求体的 `quality` 字段。

### 文件名模板

设置页里可配 `fileNameFormat`，四个占位符混搭随意：

| 占位符 | 渲染成 | 用途 |
| --- | --- | --- |
| `{time}` | `2026-10-07T08-14-43-188` | 时间排序 |
| `{prompt}` | `a-cat-in-a-hat`（slug，最长 60 字符） | 一眼看出内容 |
| `{index}` | `1`、`2`… | 区分数张 |
| `{uniq}` | `4a9ea17a` | 保证不重名 |

默认 `{time}-{prompt}`。**同名不会覆盖**：写文件用排他创建（`wx` 标志），撞名自动加 `-2`、`-3` 后缀——所以像 `{prompt}` 这种不含身份信息的模板也安全，只是可排序性差一点。

## 怎么写提示词

这个工具把提示词原样交给端点背后的模型，不做任何模板化包装。这个模型的自然语言控制力强、**会渲染文字、会排版、审美在线**，知识导图 / 知识卡 / 海报 / 信息图 / 幻灯片这类「有版式、有信息密度」的活正是它的主场。所以：

- **不要**堆风格形容词、权重语法（`(word:1.2)`、`::`）、质量咒语（`masterpiece, 8K, ultra detailed`）、参数旗标（`--ar 16:9`、`steps: 30`）。它自己的审美够用，这些只会挤掉真正的内容。
- **要**说清楚「这是什么、要说什么内容」：格式、分栏/分区/层级数量，每块放什么；图里必须出现的文字用引号原样给出，并说明位置和层级。
- 视觉语言和配色只在调用方明确要求时才指定，否则交给模型决定。
- 画场景、出照片同样可以，用描述场景的普通句子说就行。
- 图生图描述「改什么」，不要重新描述整幅画面。

想按场景切分得很细（构图/镜头/光线/材质分开写）也完全可以，但那是可选项，不是本插件的格式要求。

## 设置项

设置页里的字段直接对应插件的 Config（存在 profile 的 `cordis.patch.yml` 里）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiUrl` | `https://api.openai.com/v1` | 接口基地址，会自动拼 `/images/generations` |
| `secret` | 空 | Bearer 令牌，留空表示不改动。字段名与存法见「安全」 |
| `model` | `gpt-image-2.5-flare` | 模型 id，任意端点支持的都行，输入框可以直接改成你自己的模型名 |
| `count` | `1` | 默认张数 |
| `outputFormat` | `png` | `png`/`jpeg`/`webp`；透明背景不能用 jpeg |
| `outputCompression` | `100` | 只对 jpeg / webp 生效 |
| `background` | `auto` | 默认背景 |
| `moderation` | `auto` | 只有你显式选了 `low` 才会发这个字段（`auto` 是双方的默认值，不发） |
| `user` | 空 | 可选终端用户标识 |
| `defaultResolution` | `auto` | 调用没写分辨率时用的尺寸。`auto` 让模型自己决定比例 |
| `maxEdge` | `3840` | 自定义分辨率的最长边上限 |
| `outputDir` | 空 | 图片落盘目录；留空用插件包内的 `assets/` |
| `fileNameFormat` | `{time}-{prompt}` | 文件名模板，四个占位符见上 |
| `requestTimeoutSec` | `600` | 单次请求超时 |
| `sendsModeration` | `true` | 关掉后永远不发 `moderation`，给不认这个字段的模型用 |
| `sendsOutputCompression` | `true` | 关掉后永远不发 `output_compression` |

设置页里填自定义尺寸时会即时校验，违反上面四条规则会直接标红提示；`defaultResolution` 填了不合法的尺寸时，调用会在发请求前失败并给出原因，不会静默退回默认值；`maxEdge` 改小后 `generate_image` 的工具描述和可用档位会跟着变。画质那一栏已经不是输入框了，那是一段说明文字，告诉你它改成了调用参数。

## 工具卡片

卡片读的是结果的 presentationMeta（文件名和访问 URL），模型侧只看到纯文本的绝对路径列表。

- **标题 + 张数**；图片放在固定 260×260 且裁切的框里（**图取不到时不会让 alt 文本把卡片撑变形**）。
- **生成中**：直接显示提示词的**前 5 行**（最后可见字符换成省略号）。不用点任何按钮。
- **出图后**：提示词收起，换成两个展开按钮。
  - **展开提示词** —— 这次调用实际用的**完整**提示词（**全文，不是节段**），仅限高 260px 可滚动，正文一字不裁。
  - **参数** —— 只列这次真正传了的参数（尺寸、画质、张数、背景、位置、写盘文件数）。没传的不显示、不编造；尺寸省略时显示 `auto`。
- 运行时的参数还在流式写入、是残缺 JSON，所以宿主通过 `inject.hooks.toolCallArgumentsPartial` 注入读取流式前缀的 hook，客户端用容错解析只捞字符串字段（**闭合引号可选**，这正是「边生成边显示」的关键）。hook 缺失或抛错时退回 `block.argsRaw`。
- 展开状态由 DSH 的 `useDisclosure` 托管（所属 Turn 重置时自动收起）；该 hook 缺失、抛错或返回畸形对象时**自动退回本地状态**，按钮照常可用。空提示词则不显示提示词区块。
- **卡片不会因为畸形输入而消失**：卡片读的是本插件不拥有的日志，所以每处读取都是全函数（total）——`props`/`block` 不是对象就当归空、`meta.images` 不是数组就当归没有、`url` 不是非空字符串就不渲染（**包括访问器抛异常的条目**）、`argsRaw` 不是字符串就不解析、两个 hook 缺失/抛错/返回 Proxy 都退回本地状态。最外层还有一个 class 错误边界兜底：真抛错时渲染一张**说明失败原因的最小卡片**，而不是留下一行空白。渲染的鲁棒性有一整套畸形输入断言网兜着。

## 自检

```powershell
cd D:\MyProject\deepseek-image-generation\dsh-image-gen-plugin

# 依赖已随插件安装装好时
npm run check

# 依赖还没装时，指向本机 DSH 安装里的 @deepseek-ai 目录
$env:DSH_PACKAGE_ROOT = "C:\Users\<你>\AppData\Local\nvm\v22.22.1\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
npm run check

# 想看模型实际读到的工具描述（改完提示词先跑这个）
node show-prompt.mjs
```

四个套件：

- `checks/host.mjs`：Config 默认值、尺寸四条规则、请求体组装、multipart 逐字节结构、工具注册形状与八个参数、凭证字段命名、文件名消毒、源图校验。
- `checks/client.mjs`：设置页渲染与保存（含密钥不被回写）、尺寸即时校验与主机同判定、提示词在**三个 phase 全生命周期**的可读性、翻译函数的签名契约、错误边界、中英文切换。
- `checks/live.mjs`：用假的 fetch 跑完整调用链——落盘、路由取图、错误信息、取消、重试、`images` 路由、输出 schema 校验。
- `checks/pressure.mjs`：**极端压力套件**。上千条合成畸形输入打向尺寸规则、base64 解码、文件名模板、源图规范化、multipart 编码、生成入口，**任何引擎级异常（TypeError / ReferenceError / Cannot read / is not iterable）都算失败**（「用文字拒绝」是正确结果）。这套件把手写 fetch 桩设为**先记录再抛错**，所以**结构上不可能产生 API 费用**，并会把「出网尝试次数」报出来。

## 文件

```
dsh-image-gen-plugin/
├── package.json          包清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml      插入插件行，带一份默认 config
├── index.js              Host 侧：Config schema + generate_image 工具 + 图片路由
├── client.js             浏览器侧：设置页 + 工具卡片（原生 JS，无构建）
├── icon.svg              插件管理页的图标
├── show-prompt.mjs       打印模型实际读到的工具定义全文（不是测试，是查看器）
├── LICENSE               MIT
├── assets/               插件自己的资源目录
│   ├── dsh-image-gen-plugin-logo.png   项目 logo
│   ├── served-index.json               已写出文件的索引（自动维护）
│   └── <生成的图>.png                   outputDir 留空时的落盘位置
└── checks/               自检脚本，与插件运行无关
    ├── all.mjs           依次跑下面四套
    ├── host.mjs          Host 契约
    ├── client.mjs        浏览器契约
    ├── live.mjs          完整调用链（假 fetch）
    └── pressure.mjs      极端压力套件（零出网）
```

## 安全

- **密钥的字段名与存法**：配置字段名叫 `secret`（故意不叫 `apiKey`，避免扫盘一眼看出价值），并标记为 `role('secret')`，设置接口只回传「是否已配置」，从不回传值。但要说清楚：它是**明文存在 profile 配置里**的，DSH 的凭证库同样是明文（`$DSH_HOME/.credentials.yaml`，靠文件权限保护，Windows 上连权限检查都跳过）。**别把 profile 目录连带密码一起交出去。**
- **文件名会被消毒**：Windows 禁止的字符 `\ / : * ? " < > |` 换成 `-`；`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` 这些**保留设备名**（Windows 会把它们解析到设备命名空间，写盘会进控制台而不是文件）自动加 `-image` 后缀；名字截到 120 字符，给目录、扩展名和冲突后缀留出 Windows 的 260 字符路径预算。
- **文件名不会注入 multipart 请求头**：文件名写在带引号的 header 行里，只转义 `"` 是不够的——CRLF 能提前结束该行并**伪造出一整个 part**。现在控制字节、`"`、`\`、`/` 全部替换为 `_`，并且**先取 basename 再剥前导点**（顺序反了的话，`..` 在被归一化后会留下一个 `_` 开头的名字）。字段名也按 RFC token 校验，拒绝任何可能伪造 header 的名字。
- **图生图会先校验源图再发请求**：路径不存在、不是文件、零字节、超过 50MB、超过 16 张，都在**任何字节离开本机之前**报错并**指名是哪个文件**。源图必须**真的解码成图片**（PNG/JPEG/WebP/GIF 魔数嗅探）——伪装成 `.png` 的文本文件会被本地拒绝，而不是带着 `image/png` 发给网关换回一句看不懂的错。符号链接会被跟随（`stat`），指向目录的链接仍被拒。

## 行为说明

**请求与响应**

- **每张图都会先验证再落盘**：base64 必须合法、必须解码成 PNG/JPEG/WebP/GIF 之一（按魔数嗅探）、不能是零字节、不能超过 50MB。解不出图片时**拒绝写入**并打印开头字节，不会留下一个打开后什么都没有的文件。格式以**字节实际是什么**为准，所以网关被要求 png 却回 jpeg 时不会错标。
- **瞬时故障会自动重试**：408/409/425/429/500/502/503/504/522/524 和连接层故障最多重试 3 次，优先采用 `Retry-After`；429 这类限流不会白等。**4xx（除 429）不重试**——那是调用方自己的错，重试只会烧同样的失败。调用方取消的请求**立即终止**，不会偷偷重发。
- 工具不发送 `stream`；`partial_images` 因此也不会出现。

**文件**

- **写文件是排他创建**，不是「先检查再写」，所以两次生成同时完成也不会互相覆盖（消毒规则见「安全」）。
- 图片通过 Host 的 `/dsh-image-generation/file/<文件名>` 路由展示，到 `location` 指定的任意目录也能取到。路由查表的顺序是「本进程写过的文件表 → 目录扫描 → 落盘索引」：扫描是兜底的那一环（它直接问文件系统，所以无论图是谁写的、有没有被记录过都找得到），前两者只是让重复请求变便宜。**同名优先最新的**，因为 URL 只带文件名，无法区分不同目录的同名文件；越界的 `..` 读取被拒，**畸形的百分号转义返回 400 而不是抛异常**（`decodeURIComponent` 遇 `%` 会抛，未捕获会让请求没有响应）。
- 卸载后已经生成的图不会被删，会作为孤儿留在原目录里。

## 关于源码里的两处约定

改这个插件的代码之前值得先看这两段，都是踩过坑之后写下来的。

### 为什么依赖必须写成 peerDependencies

`@deepseek-ai/dsh-tools` 和 `@deepseek-ai/schemastery` **只能放在 `peerDependencies`，不能放到 `dependencies`**。

从源码安装时，`dsh plugin add <目录>` 是把本包**符号链接**进 profile 的：

```
<profile>/node_modules/dsh-image-gen-plugin -> D:\MyProject\...\dsh-image-gen-plugin
```

所以运行时这个包的真实路径仍在它被克隆的盘上（这里是 D 盘）。Node 解析裸包名时是**沿真实路径**向上找 `node_modules`，于是会走到 `D:\node_modules` 然后失败——profile 里装没装都不影响它找不到。DSH 只对插件**自己声明为 peer** 的包，才把裸包名路由到宿主已经加载的那一份（`dsh-app-boot` 的 `routeLinked` + `readPeerNames`）。从 npm 装进来的是普通依赖，路径就落在 profile 的 `node_modules` 里，不存在这个问题——但两种渠道必须共用同一份 `package.json`，所以 peer 声明照旧。

写回 `dependencies` 的症状是：包安装成功、profile 里也看得见，但激活时 `import '@deepseek-ai/dsh-tools'` 抛 `ERR_MODULE_NOT_FOUND`，工具不会注册。

改完清单要**重跑一次 `add`**，让 profile 的依赖图重新计算：

```powershell
dsh plugin --profile web add "D:\MyProject\deepseek-image-generation\dsh-image-gen-plugin"
```

### 客户端插件的服务注入规则

客户端半边声明的 `inject` 是 **Cordis 服务名**，宿主按名字把服务挂到 `ctx` 上：

```js
inject: ['slots', 'locale', 'remote', 'remote.settings']
// 声明之后 ctx.remote.settings 才有值
```

两个已经踩过的坑，都写进了 `checks/client.mjs` 的断言，别再踩：

1. **`ctx.get('remote')?.settings` 拿不到东西。** `ctx.get('remote')` 返回的是 `remote` 服务对象本身，设置控制器是挂在它上面的命名空间。正确做法是把 `remote.settings` 写进 `inject`，然后直接读 `ctx.remote.settings`。漏声明时 `ctx.remote` 直接是 `undefined`，症状是设置页**永远停在「正在读取设置...」**。
2. **远程调用返回 `{ ok, value }` 信封，不直接返回结果、也不抛异常。** 失败是 `{ ok: false, error: { code, message } }`。所以 `describe()` 要读 `response.value.namespaces`，`mutate()` 要读 `response.value`（新的 namespace view）。照着普通 Promise 写，报错信息会全部丢失。

翻译不要自己嗅探 `document.lang`（页面设置该属性的时机晚于插件注册，标签会一直是英文），改用 locale 服务：

```js
const localeService = ctx.locale;
const t = (key) => (localeService.getSnapshot().active.startsWith('zh') ? ZH : EN)[key];
ctx.effect(() => localeService.register('dsh-image-generation', { zh: ZH, en: EN }));
```

## 许可与来源

本插件由 DeepSeek Harness 制作。

许可证：MIT（全文见 [LICENSE](LICENSE)）
作者：MELLER_OwO
