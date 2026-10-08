# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的 git 历史从 `0.1.2` 开始发布。`0.1.0` 与 `0.1.1` 两条记录是发布前的开发过程，
> 对应的 git tag 不存在，因此不加版本比较链接。

## [未发布]

## [0.1.4] - 2026-10-08

### 修复

- **开关看起来永远处于关闭状态**。轨道背景写成了
  `var(--dsw-alias-bg-brand, var(--dsw-alias-state-success))` —— 这两个变量在 DSH 主题里
  **都不存在**，于是整条 `background` 声明被判为非法、浏览器直接忽略，轨道没有任何背景色，
  不管开还是关都只是一个空心胶囊；滑块又是写死的 `#fff`，压在浅色背景上几乎看不见。
  开关改为与 DSH 自带开关组件（`web-frontend` 的 `._switch_1ik0f_5`）**完全一致的几何与配色**：
  36×20、`padding: 2px`、无边框；关闭态轨道用 `--dsw-alias-border-l3`、开启态用
  `--dsw-alias-brand-primary`；滑块 16×16，开启态用 `--dsw-alias-label-primary-foreground`
  并位移 16px，关闭态用 `--dsw-alias-switch-thumb`。

- **所有输入框都没有可见标签**。`Field` 只在 `aria-label` 里用了 `label`，从来没有渲染它，
  界面上只剩「一个孤零零的输入框 + 一串说明」，用户无从判断哪个框是哪个设置。
  现在字段统一为两列网格：左列是标签 + 说明，右列是控件。

### 变更

- 面板按 DSH 的设计令牌重做：按钮有 hover 反馈与主/次/幽灵三种变体，输入框有聚焦描边，
  「保存」只在真有改动时才升为主按钮；圆角、字号、间距统一走 `--dsw-radius-*` / `--dsw-alias-*`。
- 修正一批**引用了不存在变量名**的样式：`--dsw-alias-bg-brand`、`--dsw-alias-state-success`、
  `--dsw-alias-state-danger`、`--dsw-alias-state-warning`、`--dsw-alias-font-mono`
  全部替换为真实 token。
- 新增开/关状态文字（`switch.on` / `switch.off`）。

### 测试

- 新增回归：**所有 `var(--dsw-*)` 必须存在于 DSH 主题的 token 清单中** ——
  这类错误会让整条样式静默失效、界面无任何报错，只能靠断言拦住。
- 新增回归：`Field` / `BoolField` 必须渲染**可见标签**（不能只靠 `aria-label`）。
- 新增回归：开关轨道在开/关两态都必须有背景色，且几何与配色对齐原生组件。
- 测试脚手架修正：`createElement` 现在会真正调用函数组件、`useEffect` 会真正执行，
  并新增可多次渲染的迷你 React。原来这些是空实现，面板永远停在 loading 分支 ——
  上面这几类 bug 正是因此才没被测出来。

## [0.1.3] - 2026-10-08

### 变更

- **`AGENTS.md` 种子重写，把「顶层目录不要直接放文件」写成硬规则。**
  原来的措辞是「保持根目录整洁；按主题建子目录，别把文件平铺在这里」+
  「大文件、依赖安装、构建产物都不要留在根目录」，三个问题：

  1. 语气是建议而非禁令，且埋在「约定」小节里；
  2. 只覆盖大文件、依赖、构建产物，**普通小文件和临时文件完全没提**；
  3. 没给替代位置，智能体知道不该放顶层，但不知道该放哪。

  现在独立成节、排在所有内容之前（越靠前权重越高），明确禁止在顶层创建文件、
  点名临时文件与中间产物、给出 `_scratch/` / `notes/` / `scripts/` 的去处、
  列出依赖与构建产物，并补了一条兜底：「如果觉得必须往顶层写新文件，先停下来问一句」。

  **注意**：种子只在目录里没有 `AGENTS.md` 时写入。已有文件的用户需要手动删除，
  或打开 `overwriteSeed` 后点一次「确保工作区」，才能拿到新文案。
  想完全自定义也可以在面板里填 `instructions`（非空则整篇替换）。

## [0.1.2] - 2026-10-08

### 修复

- **面板区块收起后无法再展开**。四个区块的渲染条件写成了
  `data && openSections.x ? <SectionCard/> : null`，收起时把整张卡片（连同标题按钮）
  一起移出渲染树，用户再也点不回来；同时 `open` prop 被写死为 `true`，
  `SectionCard` 自身的折叠逻辑根本没被用上。现在卡片只以 `data` 为渲染条件，
  展开态通过 `open` prop 下发。

### 新增

- 面板标题右侧显示**版本号小标**，用来确认新构建是否已被宿主加载
  （宿主在激活时把客户端 bundle 读进内存，改完不重启看不到变化）。
- `test-client.mjs` 补齐了可多次渲染的迷你 React 测试脚手架
  （原来 `useEffect` 是空实现、`createElement` 不调用函数组件，
  导致面板永远停在 loading 分支，折叠类回归根本测不到），并加入收起/展开回归测试。
- `package.json` 增加 `repository` / `homepage` / `bugs` 字段与 `scripts`。
- 新增英文文档 `README.en.md`。

### 变更

- `VERSION` 改为在模块加载时从 `package.json` 读取，不再硬编码。
  之前写死为 `"0.1.0"` 而 `package.json` 已到 `0.1.2`，会让版本号小标失去意义。
  测试中加入防漂移断言。

### 修复（其他）

- 修正 `lib/index.js` 顶部注释中的错别字，以及一处与代码矛盾的遗留注释。

## [0.1.1] - 2026-10-08

### 修复

- **插件在面板里显示「异常」，且三条 HTTP 路由全部返回 404**。
  `inject` 声明为空数组，而 Cordis 的 `ctx` 是**受限代理** ——
  访问未声明在 `inject` 里的属性会抛
  `cannot get property "webServer" without inject`，而不是返回 `undefined`。
  `registerRoutes` 第一行求值 `ctx.webServer` 时即抛错，`?? fallback` 没有机会执行，
  整个 `apply()` 失败，路由一条都没注册。
  现在 `inject = ["webServer"]`，并给该访问加了一层 `try` 兜底。

### 新增

- `test-e2e.mjs` 加入受限代理回归测试：模拟未声明属性的抛错行为，
  断言 `apply()` 仍然静默降级、不向外抛错。

## [0.1.0] - 2026-10-08

### 新增

- 首个版本。
- 宿主半侧：配置归一化与非法值回落、三级目录解析、稀疏状态覆盖层
  （`$DSH_HOME/state/dsh-bundle-default-workspace/settings.json`）、
  `AGENTS.md` 种子写入（默认不覆盖）、三条本机回环 HTTP 路由、
  `default_workspace` 智能体工具、按 `pollSeconds` 的幂等轮询刷新。
- 浏览器半侧：设置卡（四个可折叠区块、逐字段保存与恢复默认、「确保工作区」按钮），
  中英双语字典。
- 图标、双语 locale 元数据、`cordis.patch.yml` 部署默认值。
