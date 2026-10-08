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
		"action.resetting": "恢复中…"
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
		"action.resetting": "Resetting…"
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
	const BUTTON = {
		height: 30,
		padding: "0 12px",
		borderRadius: 8,
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "var(--dsw-alias-bg-layer-2)",
		color: "var(--dsw-alias-label-primary)",
		fontSize: 13,
		cursor: "pointer"
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
		buttonPrimary: {
			...BUTTON,
			background: "var(--dsw-alias-bg-brand, var(--dsw-alias-bg-layer-2))",
			fontWeight: 600
		},
		buttonDisabled: {
			...BUTTON,
			opacity: 0.5,
			cursor: "default"
		},
		notice: {
			margin: "0 0 16px",
			padding: "10px 14px",
			borderRadius: 10,
			fontSize: 13,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-secondary)"
		},
		noticeBad: {
			margin: "0 0 16px",
			padding: "10px 14px",
			borderRadius: 10,
			fontSize: 13,
			border: "1px solid var(--dsw-alias-state-danger, var(--dsw-alias-border-l2))",
			color: "var(--dsw-alias-label-primary)"
		},
		sectionCard: {
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-layer-1)",
			overflow: "hidden",
			marginTop: 18
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
		row: {
			display: "grid",
			gridTemplateColumns: "minmax(150px, 240px) 1fr",
			gap: "10px 16px",
			alignItems: "start",
			padding: "12px 0",
			borderTop: "1px solid var(--dsw-alias-border-l1)"
		},
		rowFirst: {
			display: "grid",
			gridTemplateColumns: "minmax(150px, 240px) 1fr",
			gap: "10px 16px",
			alignItems: "start",
			padding: "12px 0"
		},
		label: {
			fontSize: 13,
			fontWeight: 600,
			lineHeight: "30px"
		},
		hint: {
			margin: "6px 0 0",
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary)",
			lineHeight: "18px"
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
			fontFamily: "var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
			fontSize: 12,
			padding: "1px 6px",
			borderRadius: 5,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		chip: {
			display: "inline-block",
			padding: "0 8px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			fontSize: 12,
			lineHeight: "20px",
			background: "var(--dsw-alias-bg-layer-2)"
		},
		input: {
			width: "100%",
			minWidth: 0,
			height: 34,
			padding: "0 10px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 13
		},
		textarea: {
			width: "100%",
			minWidth: 0,
			minHeight: 96,
			padding: "8px 10px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			resize: "vertical"
		},
		fieldRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
		dirty: {
			fontSize: 12,
			color: "var(--dsw-alias-state-warning, var(--dsw-alias-label-secondary))",
			whiteSpace: "nowrap"
		},
		saved: {
			fontSize: 12,
			color: "var(--dsw-alias-state-success, var(--dsw-alias-label-secondary))",
			whiteSpace: "nowrap"
		},
		error: {
			fontSize: 12,
			color: "var(--dsw-alias-state-danger, var(--dsw-alias-label-primary))",
			overflowWrap: "anywhere"
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

	/** 状态行：左标签、右取值。 */
	function StatusRow({ label, value, muted, first, children }) {
		return h("div", { style: first ? S.rowFirst : S.row },
			h("div", { style: S.label }, label),
			children !== undefined ? children : h("div", { style: muted ? S.valueMuted : S.value }, value)
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
				await postJsonOrThrow(SETTINGS_PATH, { field: name, value: payloadValue });
				if (payloadValue === null) setDraft("");
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);

		return h("div", { style: S.fieldRow },
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
					style: S.input,
					type: kind === "number" ? "number" : "text",
					value: draft,
					placeholder,
					disabled: disabled || busy,
					"aria-label": label,
					onChange: (event) => setDraft(event.target.value)
				}),
			h("button", {
				type: "button",
				style: busy ? S.buttonDisabled : S.buttonPrimary,
				disabled: busy || !dirty,
				onClick: () => commit(draft)
			}, busy ? tt("action.saving") : tt("action.save")),
			emptyMeansDefault
				? h("button", {
					type: "button",
					style: busy ? S.buttonDisabled : S.button,
					disabled: busy || draft === "",
					onClick: () => commit(null)
				}, busy ? tt("action.resetting") : tt("action.reset"))
				: null,
			dirty ? h("span", { style: S.dirty }, tt("action.dirty")) : null,
			notice && notice.kind === "ok" ? h("span", { style: S.saved }, notice.message) : null,
			error ? h("div", { style: { ...S.fieldRow, width: "100%" }, role: "alert" },
				h("span", { style: S.error }, error)) : null,
			hint ? h("div", { style: { ...S.hint, width: "100%" } }, hint) : null
		);
	}

	/** 一个开关字段：切换即提交。 */
	function BoolField({ name, label, hint, value, disabled, tt }) {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const [notice, setNotice] = useState(null);
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
				await postJsonOrThrow(SETTINGS_PATH, { field: name, value: next });
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);
		return h("div", { style: S.fieldRow },
			h("button", {
				type: "button",
				role: "switch",
				"aria-checked": value === true,
				"aria-label": label,
				style: {
					...BUTTON,
					display: "inline-flex",
					gap: 8,
					opacity: busy ? 0.6 : 1,
					cursor: busy || disabled ? "default" : "pointer"
				},
				disabled: busy || disabled,
				onClick: () => toggle(value !== true)
			},
				h("span", {
					style: {
						width: 34,
						height: 18,
						borderRadius: 999,
						background: value === true
							? "var(--dsw-alias-bg-brand, var(--dsw-alias-state-success))"
							: "var(--dsw-alias-bg-layer-2)",
						border: "1px solid var(--dsw-alias-border-l2)",
						transition: "background .15s ease"
					}
				},
					h("span", {
						style: {
							display: "block",
							width: 14,
							height: 14,
							borderRadius: 999,
							background: "#fff",
							marginTop: 1,
							marginLeft: value === true ? 17 : 1,
							transition: "margin-left .15s ease"
						}
					})
				),
				h("span", { style: { fontSize: 13 } }, label)
			),
			error ? h("div", { style: { ...S.fieldRow, width: "100%" }, role: "alert" },
				h("span", { style: S.error }, error)) : null,
			notice ? h("span", { style: S.saved }, notice.message) : null,
			hint ? h("div", { style: { ...S.hint, width: "100%" } }, hint) : null
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
			advanced: false
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
					h("button", {
						type: "button",
						style: S.button,
						onClick: () => load(),
						"aria-label": tt("panel.refresh")
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
						!readonly ? h("div", { style: { ...S.fieldRow, width: "100%", marginTop: 14 } },
							h("button", {
								type: "button",
								style: ensureBusy ? S.buttonDisabled : S.buttonPrimary,
								disabled: ensureBusy,
								onClick: () => runEnsure()
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
						h("div", { style: S.fieldRow },
							h(BoolField, {
								name: "enabled",
								label: tt("field.enabled"),
								hint: tt("field.enabledHint"),
								value: effective.enabled,
								disabled: ensureBusy,
								tt
							})),
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
						h("div", { style: S.fieldRow },
							h(BoolField, {
								name: "autoCreate",
								label: tt("field.autoCreate"),
								hint: tt("field.autoCreateHint"),
								value: effective.autoCreate,
								disabled: readonly || ensureBusy,
								tt
							})),
						h("div", { style: S.fieldRow },
							h(BoolField, {
								name: "seedAgentsMd",
								label: tt("field.seedAgentsMd"),
								hint: tt("field.seedAgentsMdHint"),
								value: effective.seedAgentsMd,
								disabled: readonly || ensureBusy,
								tt
							})),
						!readonly && effective.seedAgentsMd === true ? h("div", { style: S.fieldRow },
							h(BoolField, {
								name: "overwriteSeed",
								label: tt("field.overwriteSeed"),
								hint: tt("field.overwriteSeedHint"),
								value: effective.overwriteSeed,
								disabled: ensureBusy,
								tt
							})) : null,
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
				paths: Object.freeze({ NS, STATE_PATH, SETTINGS_PATH, ENSURE_PATH }),
				helpers: Object.freeze({ clock, sizeOf }),
				components: Object.freeze({ PanelPage, SectionCard, StatusRow, Field, BoolField })
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
