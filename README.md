# 默认工作区 · dsh-bundle-default-workspace

一个 [DeepSeek Harness](https://github.com/OraSkyC/dsh-bundle-default-workspace)（DSH）插件：
**给「杂七杂八、不想区分项目」的小事一个固定的落脚点。**

临时算个数、随手写段调试脚本、查个资料做点笔记、问一句就完事 —— 这些事不值得为它新建一个工作区，
但随手丢进某个项目目录又很脏。这个插件提供**一个**默认工作区，自动建好、自动登记、
并在「设置 → 插件」里给你一张配置卡。

> [English](README.en.md) · 简体中文

---

## 为什么需要它

DSH 里每个会话都要落在某个工作区。真正做项目时这很自然，但日常里大量的是**一次性小事**：

- 新建一个工作区 → 要起名字、选目录、想它属于哪个项目……为了一个 5 分钟的小事，成本太高；
- 随便塞进手头那个项目 → 项目目录被临时文件污染，过两天自己也忘了哪些是垃圾。

结果就是两种坏情况二选一。这个插件的做法是：**承认有一类工作就是「做完就走」的**，
给它一个专用的、被明确标记为「不是项目」的地方。

关键是它会往目录里写一份 `AGENTS.md`，**直接告诉智能体这里不是项目** ——
不要搭 `src/`、`tests/`、`package.json` 那套，不要初始化 git 仓库，
保持根目录整洁，用完有价值的迁走、没价值的删掉。这样智能体不会自作主张把草稿区变成一个半成品项目。

## 特性

- **一个默认工作区** —— 默认落在 `<你的文档目录>/deepseek-harness/default-workspace`，
  自动创建并登记到 DSH 工作区列表，标题为「默认工作区」。
- **`AGENTS.md` 种子** —— 创建时写入中文说明。**最重要的一条是「顶层目录不要直接放文件」**：
  明确禁止在顶层创建临时文件、草稿、验证脚本、依赖与构建产物，并给出
  `_scratch/` / `notes/` / `scripts/` 这些去处，最后补一句「拿不准就先问」。
  这样智能体不会把你唯一的「干净落脚点」也搞乱。
  里面还专门说明 **`_trash/` 是回收站、不要动它**——否则智能体看到它会当成该清掉的垃圾。
  **默认不覆盖**你已有的文件。
- **智能体工具 `default_workspace`** —— 会话里直接问「默认工作区在哪」「建好了没」，
  或让它 `ensure` 一下把目录建出来。
- **可视化配置** —— 在插件页改目录位置、标题、用途说明、种子文案等，**改完立即生效，不用重启**。
- **可恢复的清空 / 重置** —— 用久了想归零，在面板里点一下就行。删除**永远不是直接删**：
  文件和目录先被搬进工作区里的 `_trash/<时间戳>/`，随时能捞回来。而且要求你**逐字输入目录名**
  才放行 —— 这个动作会一次搬空整个工作区，值得多花三秒。
- **三级目录回落** —— 自定义父目录 → 系统文档目录 → `~/.dsh/workspaces`，探测失败也不会没有着落。
- **只读面板轮询** —— `GET /state` 严格无副作用，不会在你不知情时创建目录。
- **零构建、零运行时依赖** —— 全部是手写纯 JS，只用 `node:` 内建模块，从 git 装完就能跑。

## 安装

插件安装后需要**重启 DSH** 才会加载（安装界面自己也会提示「下次启动后加载」）。

### 方式一：插件管理器（推荐）

1. 打开 **设置 → 插件**
2. 点右上角 **「添加插件」**
3. 在「包名或地址」里填入本仓库地址：

   ```
   https://github.com/OraSkyC/dsh-bundle-default-workspace
   ```

4. 点「安装」，然后重启 DSH

> 这个输入框同时接受 **npm 包名**、**GitHub 仓库地址**、**本地目录路径**三种形式。
> 用 GitHub 地址时，本机需要能直接访问 github.com（不走 npm 镜像源）。

### 方式二：命令行

```bash
dsh plugin --profile desktop add https://github.com/OraSkyC/dsh-bundle-default-workspace
```

### 方式三：本地目录（开发用）

如果你已经 clone 到本地，直接把目录链进 profile：

```bash
dsh plugin --profile desktop add /path/to/dsh-bundle-default-workspace
```

Windows 上手动做等价于三步：

1. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dependencies` 里加
   `"dsh-bundle-default-workspace": "link:D:/path/to/dsh-bundle-default-workspace"`
2. 在同一个文件的 `dsh.profile.bundles` 数组里加上 `"dsh-bundle-default-workspace"`
3. 建目录链接：`mklink /J node_modules\dsh-bundle-default-workspace D:\path\to\dsh-bundle-default-workspace`

### 升级

插件管理器目前**不支持自动更新**：请先「卸载」，再按上面的步骤安装新版，然后重启。

## 配置

配置分两层，优先级从低到高：

| 层 | 位置 | 生效时机 |
| --- | --- | --- |
| 部署默认值 | 本包的 [`cordis.patch.yml`](./cordis.patch.yml) | 改完需**重启 DSH** |
| 用户覆盖 | `%USERPROFILE%\.dsh\state\dsh-bundle-default-workspace\settings.json` | **立即生效**，无需重启 |

用户覆盖层是**稀疏**的：只存你在面板里真正改过的字段。点「恢复默认」是把那个键**删掉**
（而不是把默认值再写一遍），于是自动回落到部署配置。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不创建目录、不登记工作区、不提供工具，面板只读。 |
| `directoryName` | `default-workspace` | 叶子目录名。与 DSH 内核首用工作区同名，默认配置下直接包装内核行为。只允许字母数字点下划线连字符。 |
| `parentDirectory` | `""` | 父目录。留空走下面的自动解析；填**绝对路径**则直接用它。 |
| `documentsDirectory` | `""` | 系统文档目录覆盖，**仅在 `parentDirectory` 为空时生效**。留空则自动探测。 |
| `title` | `""` | 展示标题。留空由目录名派生（`default-workspace` → 「默认工作区」）。改标题会调用 `workspaceRegistry.setTitle`。 |
| `description` | `""` | 用途说明，展示在面板与 `AGENTS.md`。留空用内置文案。 |
| `autoCreate` | `true` | 首次使用时自动创建目录并登记，不用手动点「确保」。 |
| `seedAgentsMd` | `true` | 创建时写入 `AGENTS.md`。 |
| `instructions` | `""` | 非空则**整篇替换**内置种子正文。 |
| `overwriteSeed` | `false` | 即使 `AGENTS.md` 已存在也重写。默认关闭以保留你自己的修改。 |
| `pollSeconds` | `30` | 面板刷新间隔，夹在 5–600 秒之间。 |
| `trashKeep` | `5` | 回收站保留份数，夹在 0–100 之间。超出份数的**最旧批次**才会被真正删除；`0` = 不自动清理。只影响插件自己创建的批次。 |
| `allowedHosts` | `[]` | 额外可信主机名（**叠加**到 `localhost` / `127.0.0.1` / `::1`，不替换）。 |

### 目录是怎么定下来的

```
1. parentDirectory 非空？      → 直接用它                      来源 = config
2. documentsDirectory 非空？   → <它>/deepseek-harness          来源 = documents
3. 自动探测系统文档目录？       → <文档>/deepseek-harness        来源 = documents
4. 都失败                      → ~/.dsh/workspaces/deepseek-harness  来源 = fallback

最终目录 = <父目录> / <directoryName>
```

探测方式与 DSH 内核保持一致：Windows 走 `[Environment]::GetFolderPath`、
macOS 走 `osascript`、Linux 走 `xdg-user-dir`，带 10 秒超时。

**当前用的是哪一种来源会显示在面板上** —— 「我的工作区到底建哪去了」是最常问的问题。

## 智能体工具

注册一个 `default_workspace` 工具：

| action | 行为 |
| --- | --- |
| `status`（默认） | 目录、是否存在、是否已登记、标题与会话数、`AGENTS.md` 状态。**只读**。 |
| `ensure` | 创建目录、登记为工作区、写入 `AGENTS.md`。**幂等**。 |
| `path` | 只返回目录路径与来源。 |
| `describe` | 返回用途说明（面板里配的文字）。 |

工具描述里明确写了：**要换目录请让用户去设置里改 `parentDirectory`**，不要在工具里擅自改 ——
避免智能体在没有人类知情的情况下把工作区挪走。

工具描述里也写明了：**清空 / 重置只有用户能在面板里操作**，刻意不提供工具入口。
理由同上，而且更严重 —— 这两个动作会一次搬空整个工作区。

## 清空与重置

用久了这里会堆满跑完就没用的草稿。面板最后一个区块「清理与重置」（默认收起）提供两个操作：

| 操作 | 搬走什么 | 留下什么 |
| --- | --- | --- |
| **清空工作区** | 顶层的全部内容与子目录 | `AGENTS.md`、`_trash/` |
| **重置工作区** | 内容**以及** `AGENTS.md` | 搬完后按当前设置**重新生成** `AGENTS.md`，并确认工作区登记仍有效 |

「重置」是真正意义上的恢复初始化：做完之后目录里的状态和你第一次用这个插件时一模一样。

### 删除是可恢复的

两个操作都**不直接删除任何东西**。实现上是对每个顶层条目做一次 `rename`，
把它们搬进工作区里的回收站：

```
<工作区>/
├── AGENTS.md
└── _trash/
    ├── 20261009-010132-341/      ← 一次操作的批次
    │   ├── tmp.txt
    │   ├── _scratch/
    │   └── notes/
    └── 20261008-231500-123/
```

想找回什么，直接从 `_trash/<批次>/` 里拿回去就行；确认不要了，把批次目录删掉即可。
「当前内容」那一行会告诉你待清理的条目数与体积，「回收站」那一行告诉你已经攒了几批。

### 两层护栏

1. **打字确认**。确认面板会列出将被搬走的条目，并要求你**逐字输入工作区目录名**
   （默认就是 `default-workspace`）才让点确认。按钮在输入正确之前是禁用的。
   没有用「确定 / 取消」弹窗，因为它挡不住手滑，而输入框能 —— 而且它逼你确认自己清的是哪一个目录，
   毕竟目录名和父目录都是可以改的。
2. **`_trash` 永远不动**。「清空」保留它，「重置」也排除它。如果 `reset` 把回收站也当成待清理内容，
   它就会试图把 `_trash` 搬进 `_trash/<批次>/_trash` —— 自己搬自己。这个 bug 真实存在过，
   被测试逮住（Windows 上直接 `EPERM`）。

### 回收站不会无限长大

`trashKeep`（默认 `5`）决定保留几批。超出份数后，**最旧的批次才被真正删除**。

自动清理的边界是**目录名必须严格匹配** `YYYYMMDD-HHmmss-SSS`。也就是说它只删得掉
插件自己创建的批次；你自己往 `_trash` 里放的东西 —— 哪怕恰好叫 `trash`、`backup` 或 `2026` ——
永远不会被自动清理碰到。名字受这个格式约束就不含路径分隔符，
拼出来的路径也不可能逃出 `_trash`。

## HTTP 端点

面板用，全部只对**本机回环**开放（`localhost` / `127.0.0.1` / `::1`）以及 `allowedHosts` 白名单；
来源不匹配一律 `403`。只校验 `Host` 头 —— 这些端点跑在宿主自己的回环 webserver 上，
跨源请求到不了这里，`Host` 是这条链上唯一可信的入口。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/dsh-bundle-default-workspace/state` | 状态快照。**严格无副作用**。 |
| `POST` | `/api/dsh-bundle-default-workspace/settings` | body `{ "field": "<key>", "value": <v\|null> }`；`null` = 删除覆盖、回落部署默认值。 |
| `POST` | `/api/dsh-bundle-default-workspace/ensure` | 创建 / 登记 / 播种。幂等。 |
| `POST` | `/api/dsh-bundle-default-workspace/clear` | body `{ "confirm": "<目录名>" }`。`{"dryRun": true}` 只预演。 |
| `POST` | `/api/dsh-bundle-default-workspace/reset` | 同上，但连 `AGENTS.md` 一起搬走并重新生成。 |

`/clear` 与 `/reset` 的校验顺序是：来源 → 方法 → JSON body → 插件是否启用 → `dryRun` → 确认词。
确认词必须与工作区目录名**逐字相同**，否则 `400`，并在错误信息里告诉你该输入什么。
插件停用时这两个端点一律拒绝 —— 面板只读，接口也不放行。

## 工作逻辑

### 只读与副作用被严格分开

| 函数 | 行为 |
| --- | --- |
| `describeWorkspace` | 只 `resolveByPath` 探查，**绝不创建任何东西** |
| `ensureRegistered` | 命中就复用，否则 `mkdir` + `create`，再套用标题 |
| `buildState` | 只 `stat` + 探查，只读 |
| `writeSeed` | 已存在且未开启 `overwriteSeed` → 不写 |
| `listClearable` | 只 `readdir` + `lstat` 汇总，只读，目录不存在也不创建 |

所以面板每 30 秒轮询的 `GET /state` **不会**偷偷建目录。要创建只能走 `/ensure` 或工具的 `ensure`。

### 清理为什么用 rename 而不是递归删除

`moveToTrash` 对每个待清理的顶层条目只做**一次 `rename`**，从不递归进入子目录。这样有三个好处：

- **快**。清空一个塞满几千个文件的目录是一次系统调用，不是几千次。
- **不可能删到工作区外面**。删目录树最怕符号链接与 Windows 联接点：递归删除会顺着链接走进
  `C:\` 或网络盘。而 `rename` 搬走的是**链接本身**，目标完全不受影响。
  这条不是纸上推导 —— 测试里真的建了一个指向工作区外面的联接点，断言搬完之后
  目标目录与其中文件毫发无损。
- **可恢复**。这正是回收站能成立的前提。

配套的体积统计（`measureTree`）反过来**必须**递归，所以它用 `lstat` 而不是 `stat`
（不跟随符号链接），并且有硬上限：最多 2000 个条目、8 层深度，撞到上限就置 `truncated`
并如实告诉面板「N 项以上」。

这里有个实测才发现的细节：光对**子**条目查 `isSymbolicLink()` 不够 ——
`readdir` 会跟随**作为根**传进来的链接。所以 `measureTree` 在入口处也检查自己，
根是链接就直接返回 0 个字节、0 个条目。链接自身的元数据大小同样不计入体积：
那不是用户要搬走的内容。

还有一个边界：如果顶层条目超过 5000 个，`moveToTrash` **拒绝执行**并说明原因。
宁可让用户手动整理，也不要出现「搬走了一部分然后报告成功」——
那种「清空」比不清空更糟。

### 一个幂等的刷新函数服务三个调用方

```
apply(ctx, config)
  ├─ new FileStore($DSH_HOME/state/<name>/settings.json)
  ├─ registerRoutes()                 同步，挂上五条路由
  ├─ registerTool()                   异步，拿不到 tools 服务就返回 null
  ├─ void refreshFromSettings()       首轮
  ├─ setInterval(refresh, pollSeconds).unref()
  └─ ctx.effect(() => () => stop())   卸载钩子

refreshFromSettings(wiring)     ← 首轮 / 轮询兜底 / 面板写入后 都走它
  ├─ disposed / refreshing 守卫
  ├─ 读覆盖层 → resolveSettings 重算 → 写回 wiring
  ├─ !enabled || !autoCreate ? 直接返回
  ├─ resolveParent → mkdir
  ├─ ensureRegistered
  └─ writeSeed
```

那个 `refreshing` 布尔守卫不是装饰：没有它，用户点「确保工作区」时轮询正好触发，
两条路径会并发 `mkdir` + `create`，可能登记出两个工作区。

### `apply()` 永不抛错

拿不到 `tools` 就不注册工具，拿不到 `workspaceRegistry` 就只建目录不登记，都只记一条 warn。
理由很实际：插件的挂载失败会连累 DSH 启动，一个可选插件不值得。

但这里有个**反直觉的陷阱**，也是本插件开发中真实踩过的坑 ——
Cordis 的 `ctx` 是**受限代理**，访问未声明在 `inject` 里的属性会**抛错**，而不是返回 `undefined`：

```
cannot get property "webServer" without inject
```

所以「静默降级」**不能**写成 `ctx.webServer ?? fallback` —— 异常在求值那一刻就抛出去了，
`??` 根本没机会执行，结果是整个 `apply()` 失败、插件在面板显示「异常」、三条路由全部 404。

正确做法是区分两类服务：

- `webServer` 这类**必然存在**的服务 → 声明进 `inject`；
- `tools`、`workspaceRegistry` 这类**可选**服务 → 用 `ctx.get()` 包 `try` 去读。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| DSH | `web` profile（用到 `webServer` 与 `slots`） |
| Node | `>= 22.19.0` |
| 运行时依赖 | **无**（只用 `node:` 内建模块） |
| 构建步骤 | **无**（手写纯 JS，从 git 装完直接可用） |

`peerDependencies` 只声明了 `@deepseek-ai/cordis`，且用**范围**而非精确版本：

```json
"peerDependencies": { "@deepseek-ai/cordis": ">=4.0.0 <5.0.0" }
```

两个刻意的选择：

1. **不静态 import 任何 `@deepseek-ai/*` 包**。宿主半侧只用 `node:` 内建模块；
   浏览器半侧的 React 由 loader 在运行时交进来（`loaderRequire("react")`）。
   这样插件不会因为 DSH 内部包路径变动而挂掉。
2. **peer 版本用范围**。DSH 的 peer 兼容性检查只针对 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*`
   前缀的包；`@deepseek-ai/cordis` 不在其列。但写精确版本仍然危险 ——
   会因为 peer 版本不匹配被插件管理器直接拒绝安装。

## 开发

```bash
node --check lib/index.js     # 语法检查
node --check client.js

node test-e2e.mjs             # 宿主半侧（64 项断言组）
node test-client.mjs          # 浏览器半侧（38 项断言组）

npm test                     # 两个都跑
```

两个测试各用一个独立的 `DSH_HOME` 临时目录，跑完自动清理，**不会碰你的真实配置**。

### ⚠️ 改完代码必须重启 DSH

**光刷新页面是不够的。** 客户端 bundle 由宿主在**激活时**读进内存
（`@deepseek-ai/dsh-client-modules` 的 `initialBundleSnapshot` → `readFileSync`），
之后一直发那份快照；revision 也由那一次的 `mtimeMs / ctimeMs / size` 算出。

决定要不要重新扫描的 `sourceKey` 只由 `baseUrl + loaderName` 组成，**不含任何文件元数据**，
所以宿主见它没变就直接返回，既不重新 stat 也不重读文件。
加上 `cache-control` 是 `public, max-age=31536000, immutable`，刷新只会命中旧 URL。

判断新构建有没有真的生效：**面板标题右边有一颗版本号小标**（如 `v0.1.2`）。
版本号由 `lib/index.js` 在加载时从 `package.json` 读出，不会漂移。

### 目录结构

```
dsh-bundle-default-workspace/
├── package.json         # 清单：dsh.bundle.patch / dsh.client.inject / peerDependencies
├── cordis.patch.yml     # 部署默认值（补丁层）
├── lib/index.js         # 宿主半侧：配置、目录解析、FileStore、路由、工具、轮询
├── client.js            # 浏览器半侧：设置卡（React 由 loader 注入）
├── icon.svg
├── locale/zh.json       # meta.title / meta.description
├── locale/en.json
├── README.md            # 本文件
├── README.en.md         # 英文版
├── CHANGELOG.md
├── LICENSE
├── test-e2e.mjs         # 宿主半侧测试
└── test-client.mjs      # 浏览器半侧测试
```

## 常见问题

**面板显示「读取失败：HTTP 404」，插件状态是「异常」**
宿主半侧的 `apply()` 挂了，路由没注册上。最常见的原因是 `lib/index.js` 的 `inject`
漏声明了 `webServer`（见上面「`apply()` 永不抛错」一节）。

**建到别的地方去了**
看面板「父目录来源」那一行。要固定下来，就在面板里把 `parentDirectory` 填成绝对路径。

**改了设置没反应**
面板里的改动是立即生效的（走状态覆盖层）。但改 `cordis.patch.yml` 需要重启 DSH。

**改了 `client.js` / `lib/index.js` 没反应**
必须重启 DSH，刷新页面无效（见上面「改完代码必须重启 DSH」）。

**`AGENTS.md` 被覆盖了**
默认不会。检查是不是打开了 `overwriteSeed`。

**清空之后文件去哪了**
在工作区里的 `_trash/<时间戳>/` 下，原样保留。面板「清理与重置」区块的「回收站」那一行会显示
批次数与最新批次名，照着路径去找就行。

**`_trash` 会不会被自动删掉**
只有符合 `YYYYMMDD-HHmmss-SSS` 命名、且超出 `trashKeep` 份数的最旧批次会被删。
你自己放进 `_trash` 的任何东西都不会被碰。

**能不能让智能体帮我清空工作区**
不能，这是刻意的。这个动作一次搬空整个工作区，只留了面板入口，并且要求逐字输入目录名。
智能体只能告诉你「去面板的清理与重置区块操作」。

**和 DSH 内核自带的默认工作区冲突吗**
不冲突。`directoryName` 默认就叫 `default-workspace`，与内核首用工作区**同路径**，
插件会通过 `resolveByPath` 复用它而不是另建一个。

## 许可证

[MIT](./LICENSE)
