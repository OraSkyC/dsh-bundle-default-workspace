# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.1.2] - 2026-10-08

### 修复

- **面板区块收起后无法再展开**。四个区块的渲染条件写成了
  `data && openSections.x ? <SectionCard/> : null`，收起时把整张卡片（连同标题按钮）
  一起移出渲染树，用户再也点不回来；同时 `open` prop 被写死为 `true`，
  `SectionCard` 自身的折叠逻辑根本没被用上。现在卡片只以 `data` 为渲染条件，
  展开态通过 `open` prop 下发。（[#1]）

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
  （[#1]）

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

[未发布]: https://github.com/OraSkyC/dsh-bundle-default-workspace/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/OraSkyC/dsh-bundle-default-workspace/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/OraSkyC/dsh-bundle-default-workspace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/OraSkyC/dsh-bundle-default-workspace/releases/tag/v0.1.0
[#1]: https://github.com/OraSkyC/dsh-bundle-default-workspace/issues/1
