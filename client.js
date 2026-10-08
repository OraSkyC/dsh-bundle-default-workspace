/**
 * dsh-bundle-default-workspace —— 浏览器半侧。
 *
 * 在「设置 → 插件 → 默认工作区」页里渲染一张配置卡。
 * 与宿主之间只有两个 HTTP 端点：
 *   GET  /api/<name>/state     读状态（只读，无副作用）
 *   POST /api/<name>/settings  写一个设置字段（null = 删除覆盖，回落到部署配置）
 *   POST /api/<name>/ensure    确保目录、登记、播种
 *
 * 写法约定（与宿主其他插件一致，务必保留）：
 *   - 整个文件是一个 IIFE，返回一个模块对象；
 *   - REGISTRATION = { id, factory } 通过 window.__ModuleLoader__.load() 注册；
 *   - React 不是依赖，而是由 factory 收到的 loaderRequire("react") 交进来，
 *     所以本文件不 import react；
 *   - 同时在 CommonJS 下导出 REGISTRATION，方便 Node 侧测试直接加载。
 *
 * @module dsh-bundle-default-workspace/client
 */
var dsh_bundle_default_workspace_client = (function () {

	/* ------------------------------------------------------------------ */
	/* 常量                                                                 */
	/* ------------------------------------------------------------------ */
	const NS = "dsh-bundle-default-workspace";
	const STATE_PATH = "/api/" + NS + "/state";
	const SETTINGS_PATH = "/api/" + NS + "/settings";
	const ENSURE_PATH = "/api/" + NS + "/ensure";
	const CLEAR_PATH = "/api/" + NS + "/clear";
	const RESET_PATH = "/api/" + NS + "/reset";

	/**
	 * 面板状态订阅：任何一次 /settings 写入成功后，把宿主的响应广播给面板。
	 *
	 * 为什么用订阅而不是给每个字段层层传 prop：「保存后同步界面」这件事**每个字段都必须做**，
	 * 而漏掉一个的症状是静默的 —— 开关不动、或者「未保存」一直挂着不消失，
	 * 只有退出重进设置页才看到新值（因为那是重新拉了一次 /state）。
	 * 真实事故：Field / BoolField 都把响应整个丢掉了，界面只能等下一次轮询
	 * （默认 30 秒）。订阅还有个好处：DangerZone 里那个嵌套的 Field 也自动覆盖到了，
	 * 不用再往深处多传一层 prop。
	 */
	let settingsSavedListener = null;
	/** 广播一次保存结果。没有订阅者、响应不是对象、或订阅者自己抛错，都静默跳过。 */
	function broadcastSettingsSaved(payload) {
		if (typeof settingsSavedListener !== "function") return;
		try {
			settingsSavedListener(payload);
		} catch {
			/* 订阅者自己出错不该影响保存本身 */
		}
	}
	/** 面板轮询的上下界（毫秒）；宿主会按 pollSeconds 覆写。 */
	const CADENCE_MIN_MS = 5_000;
	const CADENCE_MAX_MS = 3_600_000;

	/* ------------------------------------------------------------------ */
	/* 文案                                                                 */
	/* ------------------------------------------------------------------ */
	const zh = {
		"entry.label": "默认工作区",
		"panel.title": "默认工作区",
		"panel.subtitle": "杂七杂八的小事不用区分项目时，就用它。",
		"panel.loading": "读取中…",
		"panel.empty": "还没有数据。",
		"panel.error": "读取失败：{error}",
		"panel.updated": "更新于 {time}",
		"panel.versionHint": "宿主在激活时把客户端 bundle 读进内存，改完 client.js 需要重启 DSH 才会生效；这个版本号变了就说明新构建已加载。",
		"panel.refresh": "刷新",
		"panel.configError": "配置有误：{error}",
		"panel.disabled": "插件已禁用：不创建目录、不登记工作区、不提供工具。",
		"section.status": "状态",
		"section.base": "基础设置",
		"section.create": "自动创建",
		"section.advanced": "高级",
		"section.expand": "展开",
		"section.collapse": "收起",
		"status.directory": "目录",
		"status.parentSource": "父目录来源",
		"source.config": "自定义父目录",
		"source.documents": "系统文档目录",
		"source.fallback": "回退目录",
		"status.exists": "目录已存在",
		"status.notExists": "目录不存在",
		"status.registered": "已登记为工作区",
		"status.notRegistered": "尚未登记为工作区",
		"status.title": "工作区标题",
		"status.sessions": "会话数",
		"status.agentsMd": "AGENTS.md",
		"status.agentsMdYes": "已写入（{size}）",
		"status.agentsMdNo": "尚未写入",
		"status.tool": "智能体工具",
		"status.toolYes": "已注册 default_workspace",
		"status.toolNo": "未注册（宿主没有 tools 服务）",
		"status.workspaceError": "登记失败：{error}",
		"status.ensure": "确保工作区",
		"status.ensureBusy": "处理中…",
		"status.ensureOk": "已就绪",
		"status.ensureDone": "目录已创建并登记，AGENTS.md {state}",
		"status.ensureSeedWritten": "已写入",
		"status.ensureSeedSkipped": "已存在，未覆盖",
		"status.ensureError": "失败：{error}",
		"status.docsError": "{error}",
		"field.enabled": "启用插件",
		"field.enabledHint": "关闭后不创建目录、不登记工作区，面板只读。",
		"field.directoryName": "目录名",
		"field.directoryNameHint": "叶子目录名。default-workspace 与 DSH 内核首用工作区同名。",
		"field.parentDirectory": "父目录",
		"field.parentDirectoryHint": "留空则使用系统文档目录下的 deepseek-harness。填绝对路径直接生效。",
		"field.documentsDirectory": "文档目录覆盖",
		"field.documentsDirectoryHint": "仅在父目录留空时生效；留空则自动探测。",
		"field.title": "展示标题",
		"field.titleHint": "留空则由目录名派生（中文为「默认工作区」）。",
		"field.autoCreate": "自动创建",
		"field.autoCreateHint": "首次使用时自动创建目录并登记为工作区，无需手动点一次。",
		"field.seedAgentsMd": "写入 AGENTS.md",
		"field.seedAgentsMdHint": "告诉智能体这个工作区是干什么的、不是什么。",
		"field.overwriteSeed": "覆盖已有 AGENTS.md",
		"field.overwriteSeedHint": "默认不覆盖，以保留用户自己的修改。",
		"field.description": "用途说明",
		"field.descriptionHint": "展示在面板与 AGENTS.md；留空使用内置文案。",
		"field.instructions": "AGENTS.md 正文",
		"field.instructionsHint": "非空则整篇替换内置正文。留空使用内置文案。",
		"field.pollSeconds": "面板刷新间隔（秒）",
		"field.pollSecondsHint": "5 到 600 之间；保存后立即生效。",
		"field.allowedHosts": "额外可信主机名",
		"field.allowedHostsHint": "逗号分隔，叠加到 localhost / 127.0.0.1 / ::1 之外。",
		"action.save": "保存",
		"action.saving": "保存中…",
		"action.reset": "恢复默认",
		"action.saved": "已保存",
		"action.saveError": "保存失败：{error}",
		"action.dirty": "未保存",
		"action.resetting": "恢复中…",
		"switch.on": "已开启",
		"switch.off": "已关闭",
		"section.danger": "清理与重置",
		"danger.intro": "这两个操作只影响当前工作区目录。删除的文件不会直接消失，而是先搬进工作区里的回收站，可以手动找回。",
		"danger.unavailable": "宿主没有提供清理接口。新版本需要重启 DSH 才会加载。",
		"danger.content": "当前内容",
		"danger.contentValue": "{count} 项 · {size}",
		"danger.contentEmpty": "空",
		"danger.contentMore": "{count} 项以上 · {size}",
		"danger.trash": "回收站",
		"danger.trashValue": "{count} 批",
		"danger.trashEmpty": "空",
		"danger.trashLatest": "最新：{name}",
		"danger.trashKeep": "回收站保留份数",
		"danger.trashKeepHint": "超出份数的最旧批次会被真正删除；填 0 则不自动清理。自动清理只认插件自己创建的批次名。",
		"danger.clear": "清空工作区",
		"danger.clearHint": "搬走所有内容与子目录，保留 AGENTS.md 和回收站。",
		"danger.reset": "重置工作区",
		"danger.resetHint": "全部恢复初始化：内容与 AGENTS.md 一起搬走，随后按当前设置重新生成 AGENTS.md。",
		"danger.action.clear": "清空",
		"danger.action.reset": "重置",
		"danger.confirmTitle": "确认{action}「{dir}」",
		"danger.confirmList": "将被搬进回收站的顶层条目：",
		"danger.confirmMore": "…还有 {count} 项",
		"danger.confirmEmpty": "目录里没有可清理的内容。",
		"danger.confirmResetNote": "AGENTS.md 也会被搬走，随后按当前设置重新生成。",
		"danger.confirmHint": "逐字输入这个目录名以确认：",
		"danger.confirm": "确认{action}",
		"danger.cancel": "取消",
		"danger.busy": "处理中…",
		"danger.clearDone": "已清空 {count} 项（{size}），可在 {trash} 找回。",
		"danger.resetDone": "已重置：搬走 {count} 项（{size}），AGENTS.md {seed}。",
		"danger.seedWritten": "已重新生成",
		"danger.seedSkipped": "未重新生成（写入已关闭）",
		"danger.nothingToDo": "目录里没有可清理的内容，什么都没动。",
		"danger.pruned": "顺带删掉了 {count} 个最旧批次。",
		"danger.failed": "以下条目没能搬走：{names}",
		"danger.error": "失败：{error}"
	};
	const en = {
		"entry.label": "Default workspace",
		"panel.title": "Default workspace",
		"panel.subtitle": "Use it for the small miscellaneous stuff when you don't need a project.",
		"panel.loading": "Loading…",
		"panel.empty": "No data yet.",
		"panel.error": "Failed to load: {error}",
		"panel.updated": "Updated {time}",
		"panel.versionHint": "The host reads the client bundle into memory at activation, so client.js changes need a DSH restart; a new number here means the new build is loaded.",
		"panel.refresh": "Refresh",
		"panel.configError": "Invalid config: {error}",
		"panel.disabled": "Plugin disabled: no directory, no workspace registration, no tool.",
		"section.status": "Status",
		"section.base": "Basics",
		"section.create": "Auto-create",
		"section.advanced": "Advanced",
		"section.expand": "Expand",
		"section.collapse": "Collapse",
		"status.directory": "Directory",
		"status.parentSource": "Parent source",
		"source.config": "Custom parent",
		"source.documents": "Documents folder",
		"source.fallback": "Fallback folder",
		"status.exists": "Directory exists",
		"status.notExists": "Directory missing",
		"status.registered": "Registered as a workspace",
		"status.notRegistered": "Not registered yet",
		"status.title": "Workspace title",
		"status.sessions": "Sessions",
		"status.agentsMd": "AGENTS.md",
		"status.agentsMdYes": "Written ({size})",
		"status.agentsMdNo": "Not written yet",
		"status.tool": "Agent tool",
		"status.toolYes": "default_workspace registered",
		"status.toolNo": "Not registered (no tools service on the host)",
		"status.workspaceError": "Registration failed: {error}",
		"status.ensure": "Ensure workspace",
		"status.ensureBusy": "Working…",
		"status.ensureOk": "Ready",
		"status.ensureDone": "Directory created and registered; AGENTS.md {state}",
		"status.ensureSeedWritten": "written",
		"status.ensureSeedSkipped": "already present, not overwritten",
		"status.ensureError": "Failed: {error}",
		"status.docsError": "{error}",
		"field.enabled": "Enable plugin",
		"field.enabledHint": "When off, no directory, no workspace registration, and the panel is read-only.",
		"field.directoryName": "Directory name",
		"field.directoryNameHint": "Leaf directory name. default-workspace matches DSH's own first-use workspace.",
		"field.parentDirectory": "Parent directory",
		"field.parentDirectoryHint": "Leave empty for deepseek-harness under your Documents folder; an absolute path wins.",
		"field.documentsDirectory": "Documents override",
		"field.documentsDirectoryHint": "Only used when the parent is empty; empty means auto-detect.",
		"field.title": "Display title",
		"field.titleHint": "Leave empty to derive it from the directory name.",
		"field.autoCreate": "Auto-create",
		"field.autoCreateHint": "Create the directory and register the workspace on first use.",
		"field.seedAgentsMd": "Write AGENTS.md",
		"field.seedAgentsMdHint": "Tells the agent what this workspace is for — and is not.",
		"field.overwriteSeed": "Overwrite an existing AGENTS.md",
		"field.overwriteSeedHint": "Off by default so your own edits survive.",
		"field.description": "Purpose",
		"field.descriptionHint": "Shown here and in AGENTS.md; empty uses the built-in text.",
		"field.instructions": "AGENTS.md body",
		"field.instructionsHint": "Non-empty replaces the built-in body entirely.",
		"field.pollSeconds": "Panel refresh interval (seconds)",
		"field.pollSecondsHint": "Between 5 and 600; takes effect as soon as it is saved.",
		"field.allowedHosts": "Extra trusted host names",
		"field.allowedHostsHint": "Comma separated; added to localhost / 127.0.0.1 / ::1.",
		"action.save": "Save",
		"action.saving": "Saving…",
		"action.reset": "Reset",
		"action.saved": "Saved",
		"action.saveError": "Save failed: {error}",
		"action.dirty": "Unsaved",
		"action.resetting": "Resetting…",
		"switch.on": "On",
		"switch.off": "Off",
		"section.danger": "Clean up and reset",
		"danger.intro": "Both actions only touch the current workspace directory. Nothing is deleted outright — files are moved into a recycle bin inside the workspace first, so you can take them back.",
		"danger.unavailable": "The host does not expose the cleanup endpoint. A new build needs a DSH restart to load.",
		"danger.content": "Current contents",
		"danger.contentValue": "{count} items · {size}",
		"danger.contentEmpty": "Empty",
		"danger.contentMore": "{count}+ items · {size}",
		"danger.trash": "Recycle bin",
		"danger.trashValue": "{count} batches",
		"danger.trashEmpty": "Empty",
		"danger.trashLatest": "Newest: {name}",
		"danger.trashKeep": "Batches to keep",
		"danger.trashKeepHint": "The oldest batches beyond this count are really deleted; 0 disables automatic cleanup. Only batches this plugin created are ever touched.",
		"danger.clear": "Clear the workspace",
		"danger.clearHint": "Moves every file and subdirectory away, keeping AGENTS.md and the recycle bin.",
		"danger.reset": "Reset the workspace",
		"danger.resetHint": "Back to a fresh start: contents and AGENTS.md are moved away, then AGENTS.md is regenerated from the current settings.",
		"danger.action.clear": "clear",
		"danger.action.reset": "reset",
		"danger.confirmTitle": "Confirm {action} of \"{dir}\"",
		"danger.confirmList": "Top-level entries that will be moved to the recycle bin:",
		"danger.confirmMore": "…and {count} more",
		"danger.confirmEmpty": "There is nothing to clean up in this directory.",
		"danger.confirmResetNote": "AGENTS.md is moved away too and then regenerated from the current settings.",
		"danger.confirmHint": "Type this directory name to confirm:",
		"danger.confirm": "Confirm {action}",
		"danger.cancel": "Cancel",
		"danger.busy": "Working…",
		"danger.clearDone": "Cleared {count} items ({size}); recover them from {trash}.",
		"danger.resetDone": "Reset done: moved {count} items ({size}); AGENTS.md {seed}.",
		"danger.seedWritten": "regenerated",
		"danger.seedSkipped": "not regenerated (writing is off)",
		"danger.nothingToDo": "Nothing to clean up; nothing was touched.",
		"danger.pruned": "Also removed {count} of the oldest batches.",
		"danger.failed": "These entries could not be moved: {names}",
		"danger.error": "Failed: {error}"
	};

	/* ------------------------------------------------------------------ */
	/* HTTP                                                                 */
	/* ------------------------------------------------------------------ */
	async function getJson(path) {
		const response = await fetch(path, {
			headers: { accept: "application/json" },
			cache: "no-store"
		});
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	}
	async function postJson(path, payload) {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			cache: "no-store",
			body: JSON.stringify(payload)
		});
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	}
	/** POST 并要求 ok:true；不成功就抛宿主自己的措辞。 */
	async function postJsonOrThrow(path, payload) {
		const { status, body } = await postJson(path, payload);
		if (body === null || body.ok !== true) {
			throw new Error(typeof body?.error === "string" ? body.error : "HTTP " + status);
		}
		return body;
	}

	/* ------------------------------------------------------------------ */
	/* React（由 loader 注入，不是依赖）                                     */
	/* ------------------------------------------------------------------ */
	let api = null;
	function provideClientReact(value) {
		if (typeof value !== "object" || value === null) {
			throw new Error("client: the loader did not hand over a react module");
		}
		api = value;
	}
	function reactApi() {
		if (api === null) throw new Error("client: react used before clientFactory ran");
		return api;
	}
	const h = (type, props, ...children) => reactApi().createElement(type, props, ...children);
	const useState = (initial) => reactApi().useState(initial);
	const useEffect = (effect, deps) => reactApi().useEffect(effect, deps);
	const useCallback = (callback, deps) => reactApi().useCallback(callback, deps);
	const useRef = (initial) => reactApi().useRef(initial);

	/* ------------------------------------------------------------------ */
	/* 样式（用宿主的设计令牌，不硬编码颜色）                                */
	/* ------------------------------------------------------------------ */
	// 控件尺寸与圆角统一走 DSH 自己的 token，明暗主题自动适配。
	// 注意：这些名字必须与 @deepseek-ai/dsh-client-ui-theme 里定义的完全一致，
	// 写错一个 var() 会让整条声明失效（曾经把开关轨道写成不存在的变量，
	// 结果开关不管开关都是个空心胶囊）。
	const CONTROL_HEIGHT = 32;
	const BUTTON = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		height: CONTROL_HEIGHT,
		padding: "0 12px",
		borderRadius: "var(--dsw-radius-md, 8px)",
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "var(--dsw-alias-bg-layer-2)",
		color: "var(--dsw-alias-label-primary)",
		fontSize: 13,
		fontWeight: 500,
		fontFamily: "inherit",
		lineHeight: 1,
		whiteSpace: "nowrap",
		cursor: "pointer",
		transition: "background .12s ease, border-color .12s ease, opacity .12s ease"
	};
	const S = {
		page: {
			flex: "1 1 auto",
			height: "100%",
			minHeight: 0,
			display: "flex",
			flexDirection: "column",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 14,
			lineHeight: "22px"
		},
		header: {
			flex: "none",
			display: "flex",
			alignItems: "flex-start",
			gap: 12,
			padding: "16px 0 12px"
		},
		titleBlock: { flex: 1, minHeight: 0 },
		title: {
			margin: 0,
			fontSize: 20,
			fontWeight: 600,
			lineHeight: "28px"
		},
		subtitle: {
			margin: "2px 0 0",
			fontSize: 13,
			color: "var(--dsw-alias-label-secondary)"
		},
		updated: {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			whiteSpace: "nowrap"
		},
		versionChip: {
			display: "inline-block",
			marginLeft: 8,
			padding: "0 7px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			fontWeight: 400,
			lineHeight: "19px",
			verticalAlign: "middle",
			cursor: "help"
		},
		scroll: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" },
		content: { padding: "6px 0 56px" },
		cluster: {
			display: "inline-flex",
			alignItems: "center",
			gap: 10,
			flexWrap: "wrap",
			justifyContent: "flex-end"
		},
		button: BUTTON,
		buttonHover: {
			background: "var(--dsw-alias-interactive-bg-hover)",
			borderColor: "var(--dsw-alias-border-l3)"
		},
		buttonPrimary: {
			...BUTTON,
			background: "var(--dsw-alias-button-primary-fill)",
			borderColor: "transparent",
			color: "var(--dsw-alias-label-primary-foreground)",
			fontWeight: 600
		},
		buttonPrimaryHover: {
			background: "var(--dsw-alias-button-primary-hover)"
		},
		buttonGhost: {
			...BUTTON,
			background: "transparent",
			borderColor: "transparent",
			color: "var(--dsw-alias-label-secondary)"
		},
		buttonGhostHover: {
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)"
		},
		// 破坏性操作用错误色：红字 + 红边，hover 时铺一层半透明红底。
		//
		// 这里刻意**不**做「红底白字」的实心按钮。翻过 DSH 自己的样式（审批面板的
		// 拒绝按钮 .j_8BDW_reject）之后发现，它的危险态就是这两个令牌：
		//   color: var(--dsw-alias-state-error-primary)
		//   background: var(--dsw-alias-interactive-bg-hover-danger)   ← 只有 5%~15% 透明度
		// 也就是说 state-error-primary 在 DSH 里从来只当**前景色/描边**用，
		// 拿它填满按钮再配 label-primary-foreground 是我自己臆造的搭配，
		// 对比度和观感都没人保证过。照抄原生那一套更稳。
		buttonDanger: {
			...BUTTON,
			background: "transparent",
			borderColor: "var(--dsw-alias-state-error-primary)",
			color: "var(--dsw-alias-state-error-primary)",
			fontWeight: 600
		},
		buttonDangerHover: {
			background: "var(--dsw-alias-interactive-bg-hover-danger)"
		},
		buttonDisabled: {
			opacity: 0.45,
			cursor: "default"
		},
		notice: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-secondary)"
		},
		noticeBad: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-state-error-primary)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-state-error-primary)"
		},
		noticeWarn: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-state-warn-primary)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-state-warn-label)"
		},
		sectionCard: {
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			background: "var(--dsw-alias-bg-layer-1)",
			overflow: "hidden",
			marginTop: 16
		},
		sectionHead: {
			display: "flex",
			alignItems: "center",
			gap: 10,
			width: "100%",
			padding: "12px 16px",
			background: "none",
			border: "none",
			cursor: "pointer",
			textAlign: "left",
			font: "inherit",
			color: "inherit"
		},
		sectionHeadTitle: {
			flex: 1,
			minWidth: 0,
			fontSize: 15,
			fontWeight: 600
		},
		sectionBody: { padding: "4px 16px 16px" },
		// 字段统一用两列网格：左列「标签 + 说明」，右列控件。
		// 这样每个输入框都有可见标签，不会再出现「一个孤零零的输入框 + 一串说明」。
		fieldGrid: {
			display: "grid",
			gridTemplateColumns: "minmax(110px, 180px) minmax(0, 1fr)",
			gap: "4px 20px",
			alignItems: "start",
			padding: "14px 0",
			borderTop: "1px solid var(--dsw-alias-border-l1)"
		},
		fieldGridFirst: {
			display: "grid",
			gridTemplateColumns: "minmax(110px, 180px) minmax(0, 1fr)",
			gap: "4px 20px",
			alignItems: "start",
			padding: "6px 0 14px"
		},
		fieldLabel: {
			fontSize: 13,
			fontWeight: 600,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-primary)"
		},
		fieldHint: {
			marginTop: 3,
			fontSize: 12,
			lineHeight: "17px",
			color: "var(--dsw-alias-label-tertiary)"
		},
		fieldControl: { minWidth: 0 },
		fieldActions: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			flexWrap: "wrap",
			marginTop: 8
		},
		value: { fontSize: 13, lineHeight: "20px", overflowWrap: "anywhere", wordBreak: "break-word" },
		valueMuted: {
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		code: {
			display: "inline",
			fontFamily: "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)",
			fontSize: 12,
			padding: "1px 6px",
			borderRadius: "var(--dsw-radius-xs, 4px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-markdown-inline-code, var(--dsw-alias-bg-layer-2))",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		input: {
			width: "100%",
			minWidth: 0,
			height: CONTROL_HEIGHT,
			padding: "0 10px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 13,
			outline: "none",
			transition: "border-color .12s ease"
		},
		inputFocus: { borderColor: "var(--dsw-alias-brand-primary)" },
		textarea: {
			width: "100%",
			minWidth: 0,
			minHeight: 84,
			padding: "8px 10px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			resize: "vertical",
			outline: "none"
		},
		// 开关与 DSH 自带的开关组件（web-frontend 里的 ._switch_1ik0f_5）保持完全一致：
		// 36x20、padding 2、无边框；OFF 轨道用 border-l3，ON 用 brand-primary；
		// 滑块 16x16 圆，ON 用 label-primary-foreground / OFF 用 switch-thumb，位移 16px。
		// 这样它和插件页里其它原生开关看起来就是同一个东西，而不是我臆造的样式。
		switchTrack: {
			boxSizing: "border-box",
			position: "relative",
			flex: "0 0 auto",
			width: 36,
			height: 20,
			padding: 2,
			border: 0,
			borderRadius: 999,
			cursor: "pointer",
			transition: "background .12s ease"
		},
		switchTrackOn: { background: "var(--dsw-alias-brand-primary)" },
		switchTrackOff: { background: "var(--dsw-alias-border-l3)" },
		switchTrackFocus: {
			outline: "var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))",
			outlineOffset: 2
		},
		switchThumb: {
			display: "block",
			width: 16,
			height: 16,
			borderRadius: "50%",
			background: "var(--dsw-alias-label-primary-foreground)",
			transition: "transform .12s ease, background .12s ease"
		},
		switchThumbOn: { transform: "translateX(16px)" },
		switchThumbOff: { background: "var(--dsw-alias-switch-thumb)" },
		switchTextOn: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
		switchTextOff: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" },
		dirty: {
			fontSize: 12,
			color: "var(--dsw-alias-state-warn-label)",
			whiteSpace: "nowrap"
		},
		saved: {
			fontSize: 12,
			color: "var(--dsw-alias-state-success-primary)",
			whiteSpace: "nowrap"
		},
		error: {
			fontSize: 12,
			color: "var(--dsw-alias-state-error-primary)",
			overflowWrap: "anywhere"
		},
		// 危险操作区的确认面板：用错误色描边圈起来，醒目但不刺眼。
		dangerBox: {
			marginTop: 14,
			padding: "12px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			border: "1px solid var(--dsw-alias-state-error-primary)",
			background: "var(--dsw-alias-bg-layer-2)"
		},
		dangerTitle: {
			fontSize: 13,
			fontWeight: 600,
			lineHeight: "20px",
			marginBottom: 6,
			color: "var(--dsw-alias-label-primary)"
		},
		dangerNote: {
			fontSize: 12,
			lineHeight: "18px",
			marginBottom: 8,
			color: "var(--dsw-alias-label-secondary)"
		},
		dangerList: {
			margin: "0 0 10px",
			padding: "0 0 0 2px",
			listStyle: "none",
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-secondary)",
			maxHeight: 126,
			overflowY: "auto"
		},
		dangerItem: {
			fontFamily: "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		dangerInput: {
			width: "100%",
			minWidth: 0,
			maxWidth: 320,
			height: CONTROL_HEIGHT,
			padding: "0 10px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)",
			fontSize: 13,
			outline: "none"
		},
		dangerInputOk: { borderColor: "var(--dsw-alias-state-success-primary)" },
		ok: {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-state-success-primary)",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		}
	};

	/* ------------------------------------------------------------------ */
	/* 小组件                                                               */
	/* ------------------------------------------------------------------ */
	/** 一个可折叠区块：标题按钮 + 正文。open/onToggle 走 props，方便无 React 状态地测试。 */
	function SectionCard({ title, open, onToggle, children, tt }) {
		return h("div", { style: S.sectionCard },
			h("button", {
				type: "button",
				style: S.sectionHead,
				"aria-expanded": open,
				"aria-label": tt(open ? "section.collapse" : "section.expand") + ": " + title,
				onClick: onToggle
			},
				h("span", { style: S.sectionHeadTitle }, title),
				h("svg", {
					viewBox: "0 0 16 16",
					width: 14,
					height: 14,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					style: { transition: "transform .15s ease", transform: open ? "rotate(180deg)" : "none" }
				}, h("path", { d: "M4 6l4 4 4-4" }))
			),
			open ? h("div", { style: S.sectionBody }, children) : null
		);
	}

	/**
	 * 一个带 hover 反馈的按钮。内联样式写不了 :hover，所以用本地 state 模拟。
	 * variant: "secondary"（默认）| "primary" | "danger" | "ghost"
	 */
	function Button({ variant = "secondary", disabled, onClick, children, title, label }) {
		const [hover, setHover] = useState(false);
		const base = variant === "primary"
			? S.buttonPrimary
			: variant === "danger" ? S.buttonDanger
				: variant === "ghost" ? S.buttonGhost : S.button;
		const hoverStyle = variant === "primary"
			? S.buttonPrimaryHover
			: variant === "danger" ? S.buttonDangerHover
				: variant === "ghost" ? S.buttonGhostHover : S.buttonHover;
		const off = disabled === true;
		return h("button", {
			type: "button",
			style: off ? { ...base, ...S.buttonDisabled } : hover ? { ...base, ...hoverStyle } : base,
			disabled: off,
			title,
			"aria-label": label,
			onClick: off ? undefined : onClick,
			onMouseEnter: () => setHover(true),
			onMouseLeave: () => setHover(false)
		}, children);
	}

	/** 状态行：左标签、右取值。与字段网格共用列宽，视觉上对齐。 */
	function StatusRow({ label, value, muted, first, children }) {
		return h("div", { style: first ? S.fieldGridFirst : S.fieldGrid },
			h("div", { style: S.fieldLabel }, label),
			h("div", { style: S.fieldControl },
				children !== undefined
					? children
					: h("div", { style: muted ? S.valueMuted : S.value }, value))
		);
	}

	/** 一行「左标签+说明、右操作」——危险操作区用它摆按钮。 */
	function ActionRow({ label, hint, first, children }) {
		return h("div", { style: first ? S.fieldGridFirst : S.fieldGrid },
			h("div", null,
				h("div", { style: S.fieldLabel }, label),
				hint ? h("div", { style: S.fieldHint }, hint) : null
			),
			h("div", { style: S.fieldControl },
				h("div", { style: { ...S.fieldActions, marginTop: 0 } }, children)
			)
		);
	}

	/** 把 ISO 毫秒变成「HH:MM:SS」。 */
	function clock(ms) {
		if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
		const date = new Date(ms);
		const pad = (n) => String(n).padStart(2, "0");
		return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
	}

	/** 把字节数变成人话。 */
	function sizeOf(bytes) {
		if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
		if (bytes < 1024) return bytes + " B";
		if (bytes < 1024 * 1024) return Math.round(bytes / 102.4) / 10 + " KB";
		return Math.round(bytes / 1024 / 102.4) / 10 + " MB";
	}

	/**
	 * 一个可编辑字段：草稿 + 保存/恢复默认。
	 * value 是宿主当前生效值，draft 是本地输入；只有 draft !== value 时才允许保存。
	 * kind: "text" | "textarea" | "number"
	 */
	function Field({
		name,
		label,
		hint,
		value,
		kind,
		placeholder,
		disabled,
		emptyMeansDefault,
		tt
	}) {
		const [draft, setDraft] = useState(value === undefined || value === null ? "" : String(value));
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const [notice, setNotice] = useState(null);
		// 宿主值变化时同步草稿（例如轮询回来一个更新的值）
		useEffect(() => {
			setDraft(value === undefined || value === null ? "" : String(value));
		}, [value]);

		const dirty = draft !== (value === undefined || value === null ? "" : String(value));
		const flash = (kind, message) => {
			setNotice({ kind, message });
			setTimeout(() => setNotice(null), 2200);
		};

		const commit = useCallback(async (payloadValue) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			setNotice(null);
			try {
				const body = await postJsonOrThrow(SETTINGS_PATH, { field: name, value: payloadValue });
				// 把宿主重算后的设置广播给面板。漏掉这一步，dirty 会一直挂在 true 上
				// 显示「未保存」，输入框里还是用户打的草稿 —— 看起来像没保存成功。
				broadcastSettingsSaved(body);
				if (payloadValue === null) setDraft("");
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);

		const [focused, setFocused] = useState(false);

		return h("div", { style: S.fieldGrid },
			// 左列：可见标签 + 说明。这一列以前整个漏掉了，所以输入框没有任何标签。
			h("div", null,
				h("div", { style: S.fieldLabel }, label),
				hint ? h("div", { style: S.fieldHint }, hint) : null
			),
			// 右列：控件 + 操作
			h("div", { style: S.fieldControl },
				kind === "textarea"
					? h("textarea", {
						style: S.textarea,
						value: draft,
						placeholder,
						disabled: disabled || busy,
						"aria-label": label,
						onChange: (event) => setDraft(event.target.value)
					})
					: h("input", {
						style: focused && !disabled ? { ...S.input, ...S.inputFocus } : S.input,
						type: kind === "number" ? "number" : "text",
						value: draft,
						placeholder,
						disabled: disabled || busy,
						"aria-label": label,
						onChange: (event) => setDraft(event.target.value),
						onFocus: () => setFocused(true),
						onBlur: () => setFocused(false)
					}),
				h("div", { style: S.fieldActions },
					// 只有真改了东西，「保存」才升为主按钮，平时不抢注意力
					h(Button, {
						variant: dirty ? "primary" : "secondary",
						disabled: busy || !dirty,
						onClick: () => commit(draft),
						label: tt("action.save") + " " + label
					}, busy ? tt("action.saving") : tt("action.save")),
					emptyMeansDefault
						? h(Button, {
							variant: "ghost",
							disabled: busy || draft === "",
							onClick: () => commit(null),
							label: tt("action.reset") + " " + label
						}, busy ? tt("action.resetting") : tt("action.reset"))
						: null,
					dirty ? h("span", { style: S.dirty }, tt("action.dirty")) : null,
					notice && notice.kind === "ok" ? h("span", { style: S.saved }, notice.message) : null
				),
				error ? h("div", { style: { ...S.error, marginTop: 6 }, role: "alert" }, error) : null
			)
		);
	}

	/** 一个开关字段：切换即提交。 */
	function BoolField({ name, label, hint, value, disabled, tt }) {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const [notice, setNotice] = useState(null);
		const [focused, setFocused] = useState(false);
		const flash = (kind, message) => {
			setNotice({ kind, message });
			setTimeout(() => setNotice(null), 2200);
		};
		const toggle = useCallback(async (next) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			setNotice(null);
			try {
				const body = await postJsonOrThrow(SETTINGS_PATH, { field: name, value: next });
				// 同上：不广播的话开关要等下一次轮询（默认 30 秒）才动
				broadcastSettingsSaved(body);
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);
		const on = value === true;
		const locked = busy === true || disabled === true;

		return h("div", { style: S.fieldGrid },
			h("div", null,
				h("div", { style: S.fieldLabel }, label),
				hint ? h("div", { style: S.fieldHint }, hint) : null
			),
			h("div", { style: S.fieldControl },
				h("div", { style: S.fieldActions },
					h("button", {
						type: "button",
						role: "switch",
						"aria-checked": on,
						"aria-label": label,
						disabled: locked,
						style: {
							...S.switchTrack,
							...(on ? S.switchTrackOn : S.switchTrackOff),
							...(focused ? S.switchTrackFocus : null),
							...(locked ? S.buttonDisabled : null)
						},
						onClick: () => toggle(!on),
						onFocus: () => setFocused(true),
						onBlur: () => setFocused(false)
					},
						h("span", {
							style: {
								...S.switchThumb,
								...(on ? S.switchThumbOn : S.switchThumbOff)
							}
						})
					),
					h("span", { style: on ? S.switchTextOn : S.switchTextOff },
						tt(on ? "switch.on" : "switch.off")),
					busy ? h("span", { style: S.saved }, tt("action.saving")) : null,
					notice ? h("span", { style: S.saved }, notice.message) : null
				),
				error ? h("div", { style: { ...S.error, marginTop: 6 }, role: "alert" }, error) : null
			)
		);
	}

	/**
	 * 危险操作区：清空 / 重置。
	 *
	 * 两步式——先点按钮展开确认面板，再逐字打出目录名才放行。
	 * 「确定 / 取消」两按钮弹窗挡不住手滑，输入框可以；而且它逼用户
	 * 确认自己清的是哪一个目录（目录名和父目录都是可配置的）。
	 * 真正动文件的在宿主侧，这里只负责收确认词、把结果说人话。
	 */
	function DangerZone({ data, readonly, tt, onDone }) {
		const [pending, setPending] = useState(null);
		const [typed, setTyped] = useState("");
		const [busy, setBusy] = useState(null);
		const [message, setMessage] = useState(null);
		const [error, setError] = useState(null);

		const cleanup = data && data.cleanup && typeof data.cleanup === "object" ? data.cleanup : null;
		const token = cleanup !== null && typeof cleanup.confirmToken === "string" ? cleanup.confirmToken : "";
		const survey = (cleanup === null ? {} : (pending === "reset" ? cleanup.reset : cleanup.clear)) || {};
		const matched = token !== "" && typed.trim() === token;
		const locked = readonly === true || busy !== null;

		const open = useCallback((action) => {
			setPending(action);
			setTyped("");
			setMessage(null);
			setError(null);
		}, []);
		const close = useCallback(() => {
			setPending(null);
			setTyped("");
		}, []);

		const run = useCallback(async () => {
			if (pending === null || locked || !matched) return;
			const action = pending;
			setBusy(action);
			setError(null);
			setMessage(null);
			try {
				const body = await postJsonOrThrow(action === "reset" ? RESET_PATH : CLEAR_PATH, {
					confirm: typed.trim()
				});
				const parts = [];
				const failed = Array.isArray(body.failed) ? body.failed : [];
				// 用 empty（宿主明确说「没东西可清」）而不是 movedCount === 0 来判断空操作：
				// 全都搬不动时 movedCount 也是 0，那时候说「没有可清理的内容」就是在撒谎。
				if (body.empty === true) {
					parts.push(tt("danger.nothingToDo"));
				} else if (body.movedCount > 0) {
					if (action === "reset") {
						const seedState = body.seed && body.seed.written === true
							? tt("danger.seedWritten")
							: tt("danger.seedSkipped");
						parts.push(tt("danger.resetDone")
							.replace("{count}", String(body.movedCount))
							.replace("{size}", sizeOf(body.bytes))
							.replace("{seed}", seedState));
					} else {
						parts.push(tt("danger.clearDone")
							.replace("{count}", String(body.movedCount))
							.replace("{size}", sizeOf(body.bytes))
							.replace("{trash}", typeof body.trashPath === "string" ? body.trashPath : ""));
					}
				}
				if (Array.isArray(body.pruned) && body.pruned.length > 0) {
					parts.push(tt("danger.pruned").replace("{count}", String(body.pruned.length)));
				}
				if (failed.length > 0) {
					parts.push(tt("danger.failed").replace("{names}", failed.join(", ")));
				}
				if (action === "reset" && typeof body.workspaceError === "string" && body.workspaceError !== "") {
					parts.push(tt("status.workspaceError").replace("{error}", body.workspaceError));
				}
				setMessage({
					bad: failed.length > 0,
					text: parts.length > 0 ? parts.join(" ") : tt("danger.nothingToDo")
				});
				close();
				if (typeof onDone === "function") await onDone();
			} catch (reason) {
				setError(tt("danger.error").replace(
					"{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(null);
			}
		}, [pending, locked, matched, typed, tt, onDone, close]);

		if (cleanup === null) {
			return h("div", { style: { ...S.noticeWarn, margin: "4px 0 0" } }, tt("danger.unavailable"));
		}

		const count = typeof survey.count === "number" ? survey.count : 0;
		const bytes = typeof survey.bytes === "number" ? survey.bytes : 0;
		const names = (Array.isArray(survey.entries) ? survey.entries : [])
			.map((entry) => (entry && typeof entry.name === "string" ? entry.name : ""))
			.filter((entry) => entry !== "");
		const shown = names.slice(0, 8);
		const hidden = names.length - shown.length;
		const trashCount = typeof cleanup.trashCount === "number" ? cleanup.trashCount : 0;
		const latest = Array.isArray(cleanup.trashBatches) && cleanup.trashBatches.length > 0
			? cleanup.trashBatches[0]
			: null;
		const label = (action) => tt(action === "reset" ? "danger.action.reset" : "danger.action.clear");
		const title = (action) => tt("danger.confirmTitle")
			.replace("{action}", label(action))
			.replace("{dir}", token);
		const contentValue = count === 0
			? tt("danger.contentEmpty")
			: (survey.truncated === true ? tt("danger.contentMore") : tt("danger.contentValue"))
				.replace("{count}", String(count))
				.replace("{size}", sizeOf(bytes));

		return h("div", null,
			h("div", { style: { ...S.noticeWarn, margin: "4px 0 14px" } }, tt("danger.intro")),

			h(StatusRow, { first: true, label: tt("danger.content"), value: contentValue }),
			h(StatusRow, {
				label: tt("danger.trash"),
				value: trashCount === 0
					? tt("danger.trashEmpty")
					: tt("danger.trashValue").replace("{count}", String(trashCount)) +
						(latest === null ? "" : " · " + tt("danger.trashLatest").replace("{name}", latest))
			}),
			h(Field, {
				name: "trashKeep",
				label: tt("danger.trashKeep"),
				hint: tt("danger.trashKeepHint"),
				value: typeof cleanup.trashKeep === "number" ? cleanup.trashKeep : 5,
				kind: "number",
				disabled: locked,
				emptyMeansDefault: true,
				tt
			}),

			h(ActionRow, { label: tt("danger.clear"), hint: tt("danger.clearHint") },
				h(Button, {
					variant: "danger",
					disabled: locked,
					onClick: () => (pending === "clear" ? close() : open("clear")),
					label: tt("danger.clear")
				}, tt("danger.clear"))
			),
			h(ActionRow, { label: tt("danger.reset"), hint: tt("danger.resetHint") },
				h(Button, {
					variant: "danger",
					disabled: locked,
					onClick: () => (pending === "reset" ? close() : open("reset")),
					label: tt("danger.reset")
				}, tt("danger.reset"))
			),

			pending === null ? null : h("div", {
				style: S.dangerBox,
				role: "alertdialog",
				"aria-label": title(pending)
			},
				h("div", { style: S.dangerTitle }, title(pending)),
				count === 0
					? h("div", { style: S.dangerNote }, tt("danger.confirmEmpty"))
					: h("div", null,
						h("div", { style: S.dangerNote }, tt("danger.confirmList")),
						h("ul", { style: S.dangerList },
							shown.map((entry) => h("li", { key: entry, style: S.dangerItem }, entry)),
							hidden > 0
								? h("li", { style: S.dangerItem },
									tt("danger.confirmMore").replace("{count}", String(hidden)))
								: null
						)
					),
				pending === "reset" ? h("div", { style: S.dangerNote }, tt("danger.confirmResetNote")) : null,
				h("div", { style: S.dangerNote }, tt("danger.confirmHint")),
				h("div", { style: { ...S.fieldActions, marginTop: 0 } },
					h("input", {
						style: matched ? { ...S.dangerInput, ...S.dangerInputOk } : S.dangerInput,
						type: "text",
						value: typed,
						placeholder: token,
						disabled: busy !== null,
						"aria-label": tt("danger.confirmHint") + " " + token,
						onChange: (event) => setTyped(event.target.value)
					}),
					h(Button, {
						variant: "danger",
						disabled: locked || !matched,
						onClick: () => run(),
						label: tt("danger.confirm").replace("{action}", label(pending))
					}, busy === pending
						? tt("danger.busy")
						: tt("danger.confirm").replace("{action}", label(pending))),
					h(Button, {
						variant: "ghost",
						disabled: busy !== null,
						onClick: close,
						label: tt("danger.cancel")
					}, tt("danger.cancel"))
				)
			),

			error ? h("div", { style: { ...S.error, marginTop: 10 }, role: "alert" }, error) : null,
			message ? h("div", { style: { ...(message.bad ? S.error : S.ok), marginTop: 10 } }, message.text) : null
		);
	}

	/* ------------------------------------------------------------------ */
	/* 面板主体                                                             */
	/* ------------------------------------------------------------------ */
	/**
	 * 配置卡。轮询 GET /state；字段编辑走 POST /settings。
	 * 面板没有关闭按钮：宿主插件页拥有导航。
	 */
	function PanelPage({ tt, localeSubscribe }) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({
			status: true,
			base: true,
			create: true,
			advanced: false,
			danger: false
		});
		const [cadenceMs, setCadenceMs] = useState(30_000);
		const [ensureBusy, setEnsureBusy] = useState(false);
		const [ensureMessage, setEnsureMessage] = useState(null);
		const generation = useRef(0);
		const inFlight = useRef(null);

		useEffect(() => {
			if (typeof localeSubscribe !== "function") return undefined;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);

		const load = useCallback(async () => {
			generation.current += 1;
			const mine = generation.current;
			const isCurrent = () => generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			try {
				const response = await fetch(STATE_PATH, {
					headers: { accept: "application/json" },
					cache: "no-store",
					signal: controller ? controller.signal : undefined
				});
				if (!isCurrent()) return;
				if (!response.ok) {
					setError("HTTP " + response.status);
					return;
				}
				const body = await response.json();
				if (!isCurrent()) return;
				if (!body || body.ok !== true) {
					setData(null);
					setError(typeof body?.error === "string" ? body.error : "unexpected payload");
					return;
				}
				setData(body);
				setError(null);
				setUpdatedAt(Date.now());
				const stated = body?.effective?.pollSeconds;
				if (typeof stated === "number" && Number.isFinite(stated)) {
					setCadenceMs(Math.min(CADENCE_MAX_MS, Math.max(CADENCE_MIN_MS, Math.floor(stated) * 1000)));
				}
			} catch (reason) {
				if (!isCurrent()) return;
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, []);

		/**
		 * 把 /settings 的响应并回面板状态。
		 *
		 * 这是「点了开关显示已保存、但开关不动」那个 bug 的修复核心：以前这里把响应丢掉了，
		 * 界面只能等下一次轮询才更新（默认 30 秒），用户合理地以为没生效、只能退出重进。
		 *
		 * 宿主回的是一份**完整状态快照**（不是只有 effective），所以整份覆盖就行 ——
		 * 派生字段（工作区标题、解析出的目录、回收站统计）也一并刷新。
		 * 浅合并只是为了万一将来某个字段没回，也不至于把它抹成 undefined。
		 *
		 * 同时作废在途的轮询：那个快照可能早于这次写入，如果它晚于保存返回，
		 * 就会把刚写进去的值又盖回旧的 —— 那就变成了「有时候灵有时候不灵」。
		 */
		const applySaved = useCallback((payload) => {
			generation.current += 1;
			inFlight.current?.abort?.();
			inFlight.current = null;
			setData((current) => {
				if (current === null) return current;
				if (payload === null || typeof payload !== "object") return current;
				return { ...current, ...payload };
			});
			setUpdatedAt(Date.now());
			// pollSeconds 也是普通设置项：改了它就得立刻换轮询节奏，
			// 否则要等下一次轮询才生效 —— 又一个「设了但看起来没反应」。
			const stated = payload?.effective?.pollSeconds;
			if (typeof stated === "number" && Number.isFinite(stated)) {
				setCadenceMs(Math.min(CADENCE_MAX_MS, Math.max(CADENCE_MIN_MS, Math.floor(stated) * 1000)));
			}
			// 依赖必须是空数组：函数体只用到 ref 与 setState（都稳定），
			// 写成 [applySaved] 会在自己的初始化里读自己 —— 那是 TDZ ReferenceError。
		}, []);

		// 订阅保存结果：任何字段保存成功后都会广播，这里立刻同步界面。
		// 卸载时只在自己仍是当前订阅者的情况下清空，免得把后来者的订阅误删。
		useEffect(() => {
			settingsSavedListener = applySaved;
			return () => {
				if (settingsSavedListener === applySaved) settingsSavedListener = null;
			};
		}, [applySaved]);

		useEffect(() => {
			let alive = true;
			let timer = null;
			const run = () => { if (alive) load(); };
			const start = () => { if (timer === null) timer = setInterval(run, cadenceMs); };
			const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
			run();
			start();
			const onVisibility = () => {
				if (!alive) return;
				if (document.visibilityState === "hidden") stop();
				else { run(); start(); }
			};
			document.addEventListener("visibilitychange", onVisibility);
			return () => {
				alive = false;
				stop();
				document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [cadenceMs, load]);

		const toggleSection = useCallback((key) => {
			setOpenSections((current) => ({ ...current, [key]: !current[key] }));
		}, []);

		const runEnsure = useCallback(async () => {
			if (ensureBusy) return;
			setEnsureBusy(true);
			setEnsureMessage(null);
			try {
				const body = await postJsonOrThrow(ENSURE_PATH, {});
				const seedState = body.seed && body.seed.written === true
					? tt("status.ensureSeedWritten")
					: tt("status.ensureSeedSkipped");
				setEnsureMessage(tt("status.ensureDone").replace("{state}", seedState));
				await load();
			} catch (reason) {
				setEnsureMessage(tt("status.ensureError").replace(
					"{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setEnsureBusy(false);
			}
		}, [ensureBusy, load, tt]);

		const effective = data && data.effective ? data.effective : {};
		const defaults = data && data.defaults ? data.defaults : {};
		const readonly = effective.enabled === false;

		if (loadedOnce === false) {
			return h("div", { style: S.page },
				h("div", { style: S.header }, h("span", { style: S.subtitle }, tt("panel.loading"))));
		}

		return h("div", { style: S.page },
			h("div", { style: S.header },
				h("div", { style: S.titleBlock },
					h("h2", { style: S.title },
						tt("panel.title"),
						// 版本号显示在这里是有用的：宿主把客户端 bundle 在激活时读进内存，
						// 改完 client.js 不重启 DSH 是看不到的。版本号一变就说明新构建生效了。
						data && data.plugin && data.plugin.version
							? h("span", { style: S.versionChip, title: tt("panel.versionHint") }, "v" + data.plugin.version)
							: null
					),
					h("p", { style: S.subtitle }, data ? data.defaultDirectory : tt("panel.subtitle"))
				),
				h("div", { style: S.cluster },
					updatedAt ? h("span", { style: S.updated }, tt("panel.updated").replace("{time}", clock(updatedAt))) : null,
					h(Button, {
						onClick: () => load(),
						label: tt("panel.refresh")
					}, tt("panel.refresh"))
				)
			),
			h("div", { style: S.scroll },
				h("div", { style: S.content },
					error ? h("div", { style: S.noticeBad, role: "alert" },
						tt("panel.error").replace("{error}", error)) : null,
					data && data.configError ? h("div", { style: S.noticeBad, role: "alert" },
						tt("panel.configError").replace("{error}", data.configError)) : null,
					readonly ? h("div", { style: S.notice }, tt("panel.disabled")) : null,

					data ? h(SectionCard, {
						title: tt("section.status"),
						open: openSections.status,
						onToggle: () => toggleSection("status"),
						tt
					},
						h(StatusRow, { label: tt("status.directory"), first: true, value: data.defaultDirectory }),
						h(StatusRow, {
							label: tt("status.parentSource"),
							value: tt("source." + (data.parentSource || "fallback")),
							muted: true
						}),
						data.documentsError ? h(StatusRow, { label: " ", value: tt("status.docsError").replace("{error}", data.documentsError), muted: true }) : null,
						h(StatusRow, { label: tt("status.exists"), value: data.directoryExists ? tt("status.exists") : tt("status.notExists") }),
						data.workspace
							? h("div", null,
								h(StatusRow, { label: tt("status.registered"), value: tt("status.registered") }),
								h(StatusRow, { label: tt("status.title"), value: data.workspace.title }),
								h(StatusRow, { label: tt("status.sessions"), value: String(data.workspace.sessionCount) })
							)
							: h(StatusRow, { label: tt("status.registered"), value: tt("status.notRegistered"), muted: data.workspaceError === null }),
						data.workspaceError ? h(StatusRow, { label: " ", value: tt("status.workspaceError").replace("{error}", data.workspaceError) }) : null,
						h(StatusRow, {
							label: tt("status.agentsMd"),
							value: data.seedExists ? tt("status.agentsMdYes").replace("{size}", sizeOf(data.seedSize)) : tt("status.agentsMdNo")
						}),
						h(StatusRow, {
							label: tt("status.tool"),
							value: data.toolRegistered ? tt("status.toolYes") : tt("status.toolNo")
						}),
						!readonly ? h("div", { style: { ...S.fieldActions, marginTop: 14 } },
							h(Button, {
								variant: "primary",
								disabled: ensureBusy,
								onClick: () => runEnsure(),
								label: tt("status.ensure")
							}, ensureBusy ? tt("status.ensureBusy") : tt("status.ensure")),
							ensureMessage ? h("span", { style: S.saved }, ensureMessage) : null
						) : null
					) : null,

					data ? h(SectionCard, {
						title: tt("section.base"),
						open: openSections.base,
						onToggle: () => toggleSection("base"),
						tt
					},
						h(BoolField, {
							name: "enabled",
							label: tt("field.enabled"),
							hint: tt("field.enabledHint"),
							value: effective.enabled,
							disabled: ensureBusy,
							tt
						}),
						h(Field, {
							name: "directoryName",
							label: tt("field.directoryName"),
							hint: tt("field.directoryNameHint"),
							value: effective.directoryName,
							kind: "text",
							placeholder: defaults.directoryName,
							disabled: readonly || ensureBusy,
							tt
						}),
						h(Field, {
							name: "parentDirectory",
							label: tt("field.parentDirectory"),
							hint: tt("field.parentDirectoryHint"),
							value: effective.parentDirectory,
							kind: "text",
							placeholder: data ? data.parentDirectory : "",
							disabled: readonly || ensureBusy,
							emptyMeansDefault: true,
							tt
						}),
						h(Field, {
							name: "documentsDirectory",
							label: tt("field.documentsDirectory"),
							hint: tt("field.documentsDirectoryHint"),
							value: effective.documentsDirectory,
							kind: "text",
							placeholder: data && data.parentSource === "documents" ? data.parentDirectory : "",
							disabled: readonly || ensureBusy,
							emptyMeansDefault: true,
							tt
						}),
						h(Field, {
							name: "title",
							label: tt("field.title"),
							hint: tt("field.titleHint"),
							value: effective.title,
							kind: "text",
							disabled: readonly || ensureBusy,
							emptyMeansDefault: true,
							tt
						})
					) : null,

					data ? h(SectionCard, {
						title: tt("section.create"),
						open: openSections.create,
						onToggle: () => toggleSection("create"),
						tt
					},
						h(BoolField, {
							name: "autoCreate",
							label: tt("field.autoCreate"),
							hint: tt("field.autoCreateHint"),
							value: effective.autoCreate,
							disabled: readonly || ensureBusy,
							tt
						}),
						h(BoolField, {
							name: "seedAgentsMd",
							label: tt("field.seedAgentsMd"),
							hint: tt("field.seedAgentsMdHint"),
							value: effective.seedAgentsMd,
							disabled: readonly || ensureBusy,
							tt
						}),
						!readonly && effective.seedAgentsMd === true ? h(BoolField, {
							name: "overwriteSeed",
							label: tt("field.overwriteSeed"),
							hint: tt("field.overwriteSeedHint"),
							value: effective.overwriteSeed,
							disabled: ensureBusy,
							tt
						}) : null,
						h(Field, {
							name: "description",
							label: tt("field.description"),
							hint: tt("field.descriptionHint"),
							value: effective.description,
							kind: "textarea",
							disabled: readonly || ensureBusy,
							emptyMeansDefault: true,
							tt
						}),
						h(Field, {
							name: "instructions",
							label: tt("field.instructions"),
							hint: tt("field.instructionsHint"),
							value: effective.instructions,
							kind: "textarea",
							disabled: readonly || ensureBusy,
							emptyMeansDefault: true,
							tt
						})
					) : null,

					data ? h(SectionCard, {
						title: tt("section.advanced"),
						open: openSections.advanced,
						onToggle: () => toggleSection("advanced"),
						tt
					},
						h(Field, {
							name: "pollSeconds",
							label: tt("field.pollSeconds"),
							hint: tt("field.pollSecondsHint"),
							value: effective.pollSeconds,
							kind: "number",
							disabled: ensureBusy,
							tt
						}),
						h(Field, {
							name: "allowedHosts",
							label: tt("field.allowedHosts"),
							hint: tt("field.allowedHostsHint"),
							value: Array.isArray(effective.allowedHosts) ? effective.allowedHosts.join(", ") : "",
							kind: "text",
							disabled: ensureBusy,
							tt
						})
					) : null,

					// 破坏性操作单独一块，默认收起：平时看不见，要找的时候找得到。
					data ? h(SectionCard, {
						title: tt("section.danger"),
						open: openSections.danger,
						onToggle: () => toggleSection("danger"),
						tt
					},
						h(DangerZone, {
							data,
							readonly,
							tt,
							onDone: load
						})
					) : null
				)
			)
		);
	}

	/* ------------------------------------------------------------------ */
	/* 挂载                                                                 */
	/* ------------------------------------------------------------------ */
	/**
	 * 注册字典与配置卡。
	 *
	 * 卡片由宿主的 renderSlot("plugins.bundle.config", …) 在插件页里渲染。
	 * 不传 onClose——导航归插件页所有，卡片没有关闭按钮。
	 */
	function apply(ctx) {
		ctx.effect(() => {
			try {
				return ctx.locale.register(NS, { zh, en });
			} catch {
				return () => {};
			}
		}, NS + ": dictionaries");

		let translate = (key) => key;
		try {
			translate = ctx.locale.bind(NS);
		} catch { /* locale 服务不可用时按原文渲染 */ }
		const tt = (key) => {
			try {
				return translate(key);
			} catch {
				return key;
			}
		};

		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: NS,
				locale: NS,
				inject: () => ({
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn("[" + NS + "] config card registration failed:", error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try { dispose(); } catch { /* 宿主可能已拆除 */ }
		}, NS + ": ui mounts");
	}

	const inject = ["slots", "locale"];

	/* ------------------------------------------------------------------ */
	/* 模块注册                                                            */
	/* ------------------------------------------------------------------ */
	function clientFactory(loaderRequire) {
		provideClientReact(loaderRequire("react"));
		return {
			inject,
			apply,
			/** Node 侧测试面：宿主只读 inject/apply，这里导出真实定义便于直接驱动。 */
			panel: Object.freeze({
				dictionaries: Object.freeze({ zh, en }),
				styles: S,
				paths: Object.freeze({ NS, STATE_PATH, SETTINGS_PATH, ENSURE_PATH, CLEAR_PATH, RESET_PATH }),
				helpers: Object.freeze({ clock, sizeOf }),
				components: Object.freeze({ PanelPage, SectionCard, StatusRow, ActionRow, Field, BoolField, DangerZone })
			})
		};
	}

	const REGISTRATION = {
		id: NS,
		factory: clientFactory
	};
	if (typeof window !== "undefined") {
		const loader = window.__ModuleLoader__;
		if (loader !== undefined) loader.load(REGISTRATION);
	}
	if (typeof module !== "undefined" && module !== null && module.exports !== undefined) {
		module.exports = REGISTRATION;
	}

	return REGISTRATION;
})();
