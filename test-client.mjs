// 客户端半侧验证：走真实的 window.__ModuleLoader__ 注册路径，
// 再驱动 factory / apply / 组件渲染。跑完可删。
import assert from "node:assert/strict";

// ---- 浏览器桩 ---------------------------------------------------------
const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (r) => registrations.push(r) } };
globalThis.document = {
	addEventListener() {},
	removeEventListener() {},
	visibilityState: "visible"
};
globalThis.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() {} };
globalThis.fetch = async () => { throw new Error("no network in test"); };

// ---- 加载模块 ---------------------------------------------------------
await import("./client.js");

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };

console.log("\n[A] 浏览器注册路径");
{
	assert.equal(registrations.length, 1, "应注册一次");
	assert.equal(registrations[0].id, "dsh-bundle-default-workspace");
	assert.equal(typeof registrations[0].factory, "function");
	ok(`window.__ModuleLoader__ 收到 id=${registrations[0].id}`);
}

// ---- 假的 React：可多次渲染的迷你实现 --------------------------------
// 必须真的按 hook 序号保存状态、真的跑 effect，否则 PanelPage 永远停在
// loadedOnce === false 的 loading 分支，折叠类回归根本测不到。
function makeReact() {
	let slots = [];        // 按 hook 序号存的 state/ref 值
	let marks = [];        // 按 hook 序号存的上一次依赖数组
	let pending = [];      // 本次渲染待跑的 effect
	let cleanups = [];     // 已注册的 effect 清理函数
	let cursor = 0;

	/** 依赖是否变化；undefined 依赖 = 每次都跑。 */
	const changed = (i, watch) => {
		const prev = marks[i];
		if (watch === undefined) return true;
		if (prev === undefined) return true;
		if (watch.length !== prev.length) return true;
		return watch.some((value, k) => value !== prev[k]);
	};

	const api = {
		createElement(type, props, ...children) {
			// 展开数组子节点，让 h("div", {}, someArray) 与逐个传参等价
			const flat = [];
			for (const child of children) {
				if (Array.isArray(child)) flat.push(...child);
				else flat.push(child);
			}
			// 函数组件要像真实 React 那样就地调用，否则树里只会留下
			// {type: SectionCard} 这样的占位节点，永远找不到里面的按钮。
			if (typeof type === "function") {
				const merged = { ...(props ?? {}) };
				// 只在真的有位置子节点时才覆盖 children —— 否则会把通过 props
				// 传进来的 children 抹成 undefined（真实 React 也是这个行为）。
				if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat;
				return type(merged);
			}
			return { type, props: props ?? null, children: flat };
		},
		useState(initial) {
			const i = cursor++;
			if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
			return [slots[i], (next) => {
				slots[i] = typeof next === "function" ? next(slots[i]) : next;
			}];
		},
		useEffect(fn, watch) {
			const i = cursor++;
			if (changed(i, watch)) {
				marks[i] = watch;
				pending.push(fn);
			}
		},
		useCallback(fn, watch) {
			const i = cursor++;
			if (changed(i, watch)) {
				marks[i] = watch;
				slots[i] = fn;
			}
			return slots[i];
		},
		useRef(initial) {
			const i = cursor++;
			if (!(i in slots)) slots[i] = { current: initial };
			return slots[i];
		},
		/** 开始一次渲染：重置 hook 游标与待跑 effect 队列。 */
		begin() { cursor = 0; pending = []; },
		/** 渲染结束后跑本轮 effect，收集清理函数。 */
		flush() {
			for (const fn of pending.splice(0)) {
				const off = fn();
				if (typeof off === "function") cleanups.push(off);
			}
		},
		/** 收尾：跑掉所有清理函数（清 interval / 事件监听）。 */
		teardown() { for (const off of cleanups.splice(0)) { try { off(); } catch { /* ignore */ } } }
	};
	return api;
}

/** 渲染一次 PanelPage 并跑掉它的 effect。 */
function renderPanel(reactApi, PanelPage, tt) {
	reactApi.begin();
	const tree = PanelPage({ tt, localeSubscribe: () => () => {} });
	reactApi.flush();
	return tree;
}

/** 深度优先收集树里所有 type === "button" 的节点。 */
function findButtons(node, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (node.type === "button") found.push(node);
	for (const child of node.children ?? []) findButtons(child, found);
	return found;
}

/**
 * 装一个全新的 React 实例并让组件用它。
 *
 * 我的迷你实现只有一条扁平 hook 数组，而真实 React 是每个组件一份。
 * 所以每测一个组件都要换新实例，否则前一个组件的 useState 会把后一个的
 * hook 槽位冲掉。
 */
function freshReact() {
	const instance = makeReact();
	REGISTRATION.factory(() => instance);
	return instance;
}

console.log("\n[B] clientFactory 与 apply()");
const react = makeReact();
const REGISTRATION = registrations[0];
const out = REGISTRATION.factory(() => react);
assert.deepEqual(out.inject, ["slots", "locale"]);
assert.equal(typeof out.apply, "function");
assert.ok(out.panel);
ok(`inject=${JSON.stringify(out.inject)}`);

const events = [];
const disposers = [];
const ctx = {
	logger: { warn() {}, info() {} },
	locale: {
		register(ns, dicts) { events.push(["register", ns, Object.keys(dicts).join("|")]); return () => {}; },
		bind() { return (key) => key; },
		subscribe() { return () => {}; }
	},
	slots: {
		inject(_slotName, fn) {
			const result = fn();
			disposers.push(result);
			return () => {};
		},
		register(meta, component) {
			events.push(["slot", meta.name, meta.key, meta.locale, typeof component]);
			return () => {};
		}
	},
	effect(fn) { disposers.push(fn()); return () => {}; }
};
out.apply(ctx);
assert.equal(events.length, 2);
const registered = events[0];
assert.equal(registered[0], "register");
assert.equal(registered[1], "dsh-bundle-default-workspace");
assert.deepEqual(registered[2].split("|").sort(), ["en", "zh"]);
const slot = events[1];
assert.equal(slot[0], "slot");
assert.equal(slot[1], "plugins.bundle.config");
assert.equal(slot[2], "dsh-bundle-default-workspace");
assert.equal(slot[3], "dsh-bundle-default-workspace");
assert.equal(slot[4], "function");
ok(`字典注册 → ${registered[1]}（${registered[2]}）`);
ok(`slot 注册 → ${slot[1]} / key=${slot[2]}`);

// locale 服务缺失时不应抛错
{
	out.apply({ effect: () => {}, slots: { inject() { return () => {}; } } });
	ok("locale 缺失 → 不抛错");
}
// slots 注册失败时不应抛错（client.js 会 warn，这里临时静音）
{
	const realWarn = console.warn;
	console.warn = () => {};
	try {
		out.apply({
			locale: { register() { return () => {}; }, bind() { return (k) => k; }, subscribe() { return () => {}; } },
			slots: { inject(_slot, fn) { const r = fn(); if (r) r(); throw new Error("boom"); } },
			effect() {}
		});
	} finally {
		console.warn = realWarn;
	}
	ok("slots 注册抛错 → 不向外抛");
}

console.log("\n[C] 组件渲染");
{
	const { PanelPage, SectionCard, StatusRow, ActionRow, Field, BoolField, DangerZone } = out.panel.components;
	for (const [label, component] of [
		["PanelPage", PanelPage], ["SectionCard", SectionCard], ["StatusRow", StatusRow],
		["ActionRow", ActionRow], ["Field", Field], ["BoolField", BoolField], ["DangerZone", DangerZone]
	]) {
		assert.equal(typeof component, "function", `${label} 应为函数`);
	}
	ok("组件均为函数");

	// PanelPage 首次渲染（尚无数据、effect 未跑）→ loading 分支
	const renderReact = freshReact();
	const loadingTree = renderPanel(renderReact, PanelPage, (key) => key);
	assert.equal(loadingTree.type, "div");
	assert.match(JSON.stringify(loadingTree), /panel\.loading/);
	renderReact.teardown();
	ok("未加载 → loading 分支");

	// SectionCard 折叠
	const body = "正文";
	const open = SectionCard({ title: "T", open: true, onToggle: () => {}, tt: (k) => k, children: body });
	const closed = SectionCard({ title: "T", open: false, onToggle: () => {}, tt: (k) => k, children: body });
	assert.equal(open.children.length, 2);
	assert.equal(open.children[1].type, "div");
	assert.match(JSON.stringify(open.children[1]), /正文/);
	assert.equal(open.children[0].props["aria-expanded"], true);
	assert.equal(closed.children[1], null);
	assert.equal(closed.children[0].props["aria-expanded"], false);
	assert.ok(!JSON.stringify(closed).includes("正文"));
	ok("SectionCard 折叠/展开");

	// StatusRow 首行/非首行
	const first = StatusRow({ label: "L1", value: "V1", first: true });
	const rest = StatusRow({ label: "L2", value: "V2" });
	assert.equal(first.children.length, 2);
	assert.equal(rest.children.length, 2);
	assert.match(JSON.stringify(first), /L1/);
	assert.match(JSON.stringify(first), /V1/);
	assert.match(JSON.stringify(rest), /L2/);
	assert.match(JSON.stringify(rest), /V2/);
	ok("StatusRow 渲染标签与取值");

	// Field：左列标签 + 右列控件。这里曾经整个漏掉了标签渲染，
	// 界面上只剩「一个孤零零的输入框 + 一串说明」，所以标签必须显式断言。
	const fieldReact = freshReact();
	fieldReact.begin();
	const field = Field({
		name: "title", label: "字段标题", hint: "这是说明", value: "已生效", kind: "text",
		disabled: false, emptyMeansDefault: true, tt: (k) => k
	});
	const fieldJson = JSON.stringify(field);
	assert.match(fieldJson, /已生效/);
	assert.match(fieldJson, /action\.save/);
	assert.match(fieldJson, /action\.reset/);

	const labelCol = field.children[0];
	const controlCol = field.children[1];
	assert.match(JSON.stringify(labelCol), /字段标题/, "Field 必须渲染可见标签");
	assert.match(JSON.stringify(labelCol), /这是说明/, "Field 必须把 hint 放在标签列");
	assert.equal(controlCol.children[0].type, "input", "控件应在右列");
	assert.equal(controlCol.children[0].props.value, "已生效");
	// 标签不能只存在于 aria-label 里
	assert.ok(
		!JSON.stringify(labelCol).includes("aria-label"),
		"标签必须是可见文本，不能只靠 aria-label"
	);
	fieldReact.teardown();
	ok("Field 渲染可见标签 + 说明 + 当前值 + 保存/恢复按钮");

	// textarea 变体
	const taReact = freshReact();
	taReact.begin();
	const area = Field({ name: "n", label: "L", value: "多行", kind: "textarea", tt: (k) => k });
	assert.equal(area.children[1].children[0].type, "textarea");
	taReact.teardown();
	ok("Field textarea 变体");

	// BoolField：标签可见 + 开关状态双向都渲染
	for (const on of [true, false]) {
		const boolReact = freshReact();
		boolReact.begin();
		const bool = BoolField({
			name: "enabled", label: "启用插件", hint: "说明文字", value: on, disabled: false, tt: (k) => k
		});
		const json = JSON.stringify(bool);
		assert.match(json, /启用插件/, "BoolField 必须渲染可见标签");
		assert.match(json, /说明文字/, "BoolField 必须渲染 hint");
		assert.equal(bool.children[0].type, "div", "标签列");
		assert.match(
			JSON.stringify(bool.children[0]),
			/启用插件/,
			`value=${on} 时标签列必须含标签文本`
		);
		boolReact.teardown();
	}
	ok("BoolField 渲染可见标签 + 说明（开/关两态）");

	// 开关轨道在两种状态下都必须有背景色。
	// 这是那个「开关永远像空胶囊」bug 的直接回归：当时写成
	// var(--dsw-alias-bg-brand, var(--dsw-alias-state-success))，两个变量都不存在，
	// 整条 background 声明被判非法 → 轨道没有背景。
	{
		const boolReact = freshReact();
		boolReact.begin();
		const onSwitch = BoolField({ name: "n", label: "L", value: true, tt: (k) => k });
		const offSwitch = BoolField({ name: "n", label: "L", value: false, tt: (k) => k });
		const trackOf = (node) => {
			const found = [];
			const walk = (n) => {
				if (n === null || typeof n !== "object") return;
				if (n.props?.role === "switch") found.push(n);
				for (const c of n.children ?? []) walk(c);
			};
			walk(node);
			return found[0];
		};
		for (const [state, node] of [["开", onSwitch], ["关", offSwitch]]) {
			const track = trackOf(node);
			assert.ok(track !== undefined, `${state} 态应渲染 role=switch 的轨道`);
			const bg = track.props.style.background;
			assert.ok(
				typeof bg === "string" && bg.trim() !== "" && bg !== "none" && bg !== "transparent",
				`${state} 态轨道必须有背景色，实际: ${JSON.stringify(bg)}`
			);
		}
		// 与 DSH 原生开关（web-frontend 的 ._switch_1ik0f_5）保持一致的几何与配色。
		// ON 滑块用 label-primary-foreground，只有 OFF 滑块才用 switch-thumb —— 别搞反。
		const track = trackOf(onSwitch);
		const trackOff = trackOf(offSwitch);
		for (const [label, node] of [["开", track], ["关", trackOff]]) {
			assert.equal(node.props.style.width, 36, `${label}态轨道宽应为 36`);
			assert.equal(node.props.style.height, 20, `${label}态轨道高应为 20`);
			assert.equal(node.props.style.padding, 2, `${label}态轨道 padding 应为 2`);
		}
		const thumbOf = (node) => node.children.find((c) => c?.type === "span");
		assert.match(JSON.stringify(thumbOf(track).props.style), /label-primary-foreground/, "ON 滑块用 label-primary-foreground");
		assert.equal(thumbOf(track).props.style.transform, "translateX(16px)", "ON 滑块应位移 16px");
		assert.match(JSON.stringify(thumbOf(trackOff).props.style), /switch-thumb/, "OFF 滑块用 switch-thumb");
		assert.equal(thumbOf(trackOff).props.style.transform, undefined, "OFF 滑块不应位移");
		assert.match(JSON.stringify(onSwitch), /"aria-checked":true/);
		assert.match(JSON.stringify(offSwitch), /"aria-checked":false/);
		boolReact.teardown();
	}
	ok("开关轨道开/关两态都有背景色，几何与配色对齐 DSH 原生组件");
}

console.log("\n[D] 辅助函数");
{
	const { clock, sizeOf } = out.panel.helpers;
	assert.equal(clock(0), "");
	assert.equal(clock(-1), "");
	assert.equal(clock(Number.NaN), "");
	assert.match(clock(Date.UTC(2026, 8, 3, 1, 2, 3)), /^[0-2][0-9]:0[0-3]:03$/);
	assert.equal(sizeOf(0), "0 B");
	assert.equal(sizeOf(1023), "1023 B");
	assert.equal(sizeOf(2048), "2 KB");
	assert.equal(sizeOf(1024 * 1024), "1 MB");
	assert.equal(sizeOf(-5), "");
	assert.equal(sizeOf("x"), "");
	ok("clock / sizeOf");
}

console.log("\n[E] 文案键对齐");
{
	const { zh, en } = out.panel.dictionaries;
	assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
	assert.ok(Object.keys(zh).length >= 50);
	ok(`中英各 ${Object.keys(zh).length} 个键，键集一致`);

	// 面板渲染的是纯文本，不走 Markdown。文案里出现 Markdown 标记就会原样显示成
	// 一堆星号（真实事故：设置页里写着「本插件**没有**…」，界面上就是四个星号）。
	for (const [lang, dict] of [["zh", zh], ["en", en]]) {
		for (const [key, value] of Object.entries(dict)) {
			assert.ok(
				!value.includes("**") && !value.includes("__"),
				`${lang}.${key} 含 Markdown 标记，面板会原样显示: ${value}`
			);
		}
	}
	ok("文案不含 Markdown 标记（面板按纯文本渲染）");

	// 面板与组件里用到的键必须都在字典里；键形如 a.b，用正则过滤掉拼接串
	const KEY_RE = /^[a-z][a-z0-9]*([.][a-z][a-z0-9]*)+$/i;
	const used = new Set();
	const walk = (node) => {
		if (node === null || typeof node !== "object") return;
		for (const value of Object.values(node)) {
			if (typeof value === "string" && KEY_RE.test(value)) used.add(value);
			else walk(value);
		}
	};
	const { PanelPage, SectionCard, StatusRow, ActionRow, Field, BoolField, DangerZone } = out.panel.components;
	const CLEANUP = {
		confirmToken: "default-workspace",
		trashDir: "C:\\tmp\\deepseek-harness\\default-workspace\\_trash",
		trashKeep: 5,
		trashCount: 2,
		trashBatches: ["20261008-231500-123", "20261008-120000-000"],
		clear: { count: 3, bytes: 4096, exists: true, entries: [{ name: "tmp.txt", kind: "file", size: 3 }], truncated: false },
		reset: { count: 4, bytes: 100000, exists: true, entries: [{ name: "AGENTS.md", kind: "file", size: 1864 }], truncated: false }
	};
	const states = [
		PanelPage({ tt: (key) => key, localeSubscribe: () => () => {} }),
		SectionCard({ title: "S", open: true, onToggle: () => {}, tt: (key) => key }),
		StatusRow({ label: "L", value: "V" }),
		ActionRow({ label: "L", hint: "H" }),
		Field({ name: "n", label: "L", value: "V", kind: "text", tt: (key) => key }),
		Field({ name: "n", label: "L", value: "", kind: "textarea", emptyMeansDefault: true, tt: (key) => key }),
		BoolField({ name: "n", label: "L", value: false, tt: (key) => key }),
		DangerZone({ data: { cleanup: CLEANUP }, readonly: false, tt: (key) => key })
	];
	for (const state of states) walk(state);
	for (const key of used) assert.ok(key in zh, `缺字典键: ${key}`);
	ok(`渲染树引用 ${used.size} 个键，全部在字典中`);
}

console.log("\n[F] 端点路径");
{
	const { NS, STATE_PATH, SETTINGS_PATH, ENSURE_PATH, CLEAR_PATH, RESET_PATH } = out.panel.paths;
	assert.equal(NS, "dsh-bundle-default-workspace");
	assert.equal(STATE_PATH, "/api/dsh-bundle-default-workspace/state");
	assert.equal(SETTINGS_PATH, "/api/dsh-bundle-default-workspace/settings");
	assert.equal(ENSURE_PATH, "/api/dsh-bundle-default-workspace/ensure");
	assert.equal(CLEAR_PATH, "/api/dsh-bundle-default-workspace/clear");
	assert.equal(RESET_PATH, "/api/dsh-bundle-default-workspace/reset");
	ok(`面板端点: ${STATE_PATH} / ${SETTINGS_PATH} / ${ENSURE_PATH} / ${CLEAR_PATH} / ${RESET_PATH}`);
}

console.log("\n[G] 收起后仍能展开（回归）");
{
	// 回归点：折叠状态曾经被写成 `data && openSections.x ? <Card/> : null`，
	// 收起时把整张卡片（含标题按钮）一起移出树，于是再也点不回来了。
	// 现在卡片只以 data 为条件渲染，折叠交给 Card 内部，标题按钮恒在。
	const { PanelPage } = out.panel.components;
	const panelReact = freshReact();
	const tt = (key) => key;

	const effective = {
		enabled: true, directoryName: "default-workspace", parentDirectory: "",
		documentsDirectory: "", title: "", description: "", autoCreate: true,
		seedAgentsMd: true, instructions: "", overwriteSeed: false,
		pollSeconds: 30, trashKeep: 5, allowedHosts: []
	};
	const cleanup = {
		confirmToken: "default-workspace",
		trashDir: "C:\\tmp\\deepseek-harness\\default-workspace\\_trash",
		trashKeep: 5,
		trashCount: 1,
		trashBatches: ["20261008-231500-123"],
		clear: {
			count: 2, bytes: 2051, exists: true, truncated: false,
			entries: [{ name: "tmp.txt", kind: "file", size: 3 }, { name: "_scratch", kind: "dir", size: 2048 }]
		},
		reset: {
			count: 3, bytes: 3915, exists: true, truncated: false,
			entries: [{ name: "AGENTS.md", kind: "file", size: 1864 }]
		}
	};
	const payload = {
		ok: true,
		plugin: { name: "dsh-bundle-default-workspace", version: "0.1.1" },
		enabled: true,
		effective,
		defaults: { ...effective },
		configError: null,
		defaultDirectory: "C:\\tmp\\deepseek-harness\\default-workspace",
		parentDirectory: "C:\\tmp\\deepseek-harness",
		parentSource: "documents",
		documentsError: null,
		directoryExists: true,
		workspace: {
			id: "ws-1", title: "默认工作区",
			path: "C:\\tmp\\deepseek-harness\\default-workspace", sessionCount: 3
		},
		workspaceError: null,
		seedExists: true,
		seedPath: "C:\\tmp\\deepseek-harness\\default-workspace\\AGENTS.md",
		seedSize: 2048,
		toolRegistered: true,
		cleanup
	};
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });

	// 首渲染 → loading；effect 里的 load() 打 fetch；再渲染一次拿数据分支
	let tree = renderPanel(panelReact, PanelPage, tt);
	await new Promise((resolve) => setTimeout(resolve, 10));
	tree = renderPanel(panelReact, PanelPage, tt);
	assert.ok(!JSON.stringify(tree).includes("panel.loading"), "应已进入数据分支");
	assert.match(JSON.stringify(tree), /default-workspace/, "应渲染出目录路径");
	ok("加载完成 → 渲染数据分支");

	// 端到端：真实数据下的面板必须把每个字段的可见标签都渲染出来。
	// （标签曾经整个漏渲染，界面上只有输入框和说明，用户不知道哪个框是什么。）
	{
		const panelJson = JSON.stringify(tree);
		// 「高级」默认收起，所以这两个字段此时不该出现，单独在展开后再查
		const expectedLabels = [
			"field.directoryName", "field.parentDirectory", "field.documentsDirectory",
			"field.title", "field.description", "field.instructions"
		];
		const missing = expectedLabels.filter((key) => !panelJson.includes(key));
		assert.deepEqual(missing, [], "面板缺少这些字段的可见标签: " + missing.join(", "));
		for (const key of ["field.autoCreate", "field.seedAgentsMd"]) {
			assert.ok(panelJson.includes(key), `面板缺少开关字段标签: ${key}`);
		}
		assert.ok(!panelJson.includes("field.pollSeconds"), "收起的「高级」不该渲染其字段");
		ok(`默认展开的区块渲染出全部字段标签（${expectedLabels.length + 2} 个）`);

		// 开关必须在「开」态显示为已开启：默认配置里 enabled/autoCreate/seedAgentsMd 都是 true
		assert.match(panelJson, /switch\.on/, "默认配置下应有开关处于开启态");
		const switchCount = (panelJson.match(/"aria-checked"/g) ?? []).length;
		assert.ok(switchCount >= 3, `应至少有 3 个开关，实际 ${switchCount}`);
		ok(`开关状态渲染正确（${switchCount} 个 aria-checked）`);
	}

	// 四个区块的标题按钮都应存在（aria-label 形如 "<expand>: <title>"）
	const headerFor = (sectionKey) => findButtons(tree).find((button) => {
		const label = button.props?.["aria-label"];
		return typeof label === "string" && label.endsWith(": " + sectionKey);
	});
	const SECTIONS = ["section.status", "section.base", "section.create", "section.advanced", "section.danger"];
	for (const key of SECTIONS) {
		assert.ok(headerFor(key) !== undefined, `缺少区块标题按钮: ${key}`);
	}
	// 初始：前三个展开，高级与危险操作默认收起
	for (const key of ["section.status", "section.base", "section.create"]) {
		assert.equal(headerFor(key).props["aria-expanded"], true, `${key} 初始应展开`);
	}
	assert.equal(headerFor("section.advanced").props["aria-expanded"], false, "section.advanced 初始应收起");
	assert.equal(
		headerFor("section.danger").props["aria-expanded"], false,
		"section.danger 初始应收起（破坏性操作不该在默认视野里）"
	);
	assert.ok(
		!JSON.stringify(tree).includes("danger.clear"),
		"收起的危险操作区不该渲染清空按钮"
	);
	ok("五个区块标题按钮齐备，初始展开态正确");

	// 收起「基础设置」，再渲染：标题按钮必须还在，只是 aria-expanded 变 false
	const baseHeader = headerFor("section.base");
	baseHeader.props.onClick();
	tree = renderPanel(panelReact, PanelPage, tt);
	const afterCollapse = headerFor("section.base");
	assert.ok(afterCollapse !== undefined, "收起后标题按钮消失了 —— 无法再展开（回归）");
	assert.equal(afterCollapse.props["aria-expanded"], false, "收起后应为折叠态");
	ok("收起「基础设置」→ 标题按钮仍在，可再次点击");

	// 其他区块不受影响
	assert.equal(headerFor("section.status").props["aria-expanded"], true);
	assert.equal(headerFor("section.create").props["aria-expanded"], true);
	ok("其他区块折叠状态不受影响");

	// 再点一次：必须能展开回来
	afterCollapse.props.onClick();
	tree = renderPanel(panelReact, PanelPage, tt);
	const afterExpand = headerFor("section.base");
	assert.ok(afterExpand !== undefined, "展开后标题按钮应仍在");
	assert.equal(afterExpand.props["aria-expanded"], true, "应重新展开");
	ok("再次点击 → 成功展开回来");

	// 默认收起的「高级」必须能展开（用户报的就是这个场景）
	const advanced = headerFor("section.advanced");
	assert.equal(advanced.props["aria-expanded"], false);
	advanced.props.onClick();
	tree = renderPanel(panelReact, PanelPage, tt);
	const advancedOpen = headerFor("section.advanced");
	assert.ok(advancedOpen !== undefined, "「高级」展开后标题按钮应仍在");
	assert.equal(advancedOpen.props["aria-expanded"], true, "「高级」应能展开");
	assert.match(JSON.stringify(tree), /field\.pollSeconds/, "展开后应渲染出内容");
	assert.match(JSON.stringify(tree), /field\.allowedHosts/, "展开后应渲染出内容");
	assert.match(JSON.stringify(tree), /field\.pollSecondsHint/, "展开后应渲染出说明文字");
	ok("默认收起的「高级」→ 点击可展开并渲染内容（含字段标签）");

	// 全部收起后，五个标题按钮依然都在（没有一个会消失）
	for (const key of SECTIONS) {
		const header = headerFor(key);
		if (header.props["aria-expanded"] === true) header.props.onClick();
	}
	tree = renderPanel(panelReact, PanelPage, tt);
	for (const key of SECTIONS) {
		assert.ok(headerFor(key) !== undefined, `全收起后 ${key} 的标题按钮消失了`);
	}
	ok("全部收起 → 五个标题按钮依旧全在");

	// 版本号小标：面板头部要能看出当前跑的是哪个构建
	assert.match(JSON.stringify(tree), /"v0\.1\.1"/, "面板应显示宿主报的版本号");
	ok("面板标题显示版本号 v0.1.1");

	panelReact.teardown();
}

console.log("\n[H] 危险操作：清空/重置的确认闸门");
{
	const { DangerZone, CLEAR_PATH, RESET_PATH } = { ...out.panel.components, ...out.panel.paths };
	// 这一段故意用**真实中文文案**而不是 (key) => key：确认闸门的文案里有
	// {count}/{size}/{action} 这类占位符，用 key 当翻译的话 replace 无处可施，
	// 「宿主拒绝的措辞有没有透出来」这种断言就永远测不到（我一开始就栽在这里）。
	const zhDict = out.panel.dictionaries.zh;
	const tt = (key) => zhDict[key] ?? key;
	const cleanup = {
		confirmToken: "default-workspace",
		trashDir: "C:\\ws\\_trash",
		trashKeep: 5,
		trashCount: 1,
		trashBatches: ["20261008-231500-123"],
		clear: {
			count: 12, bytes: 4096, exists: true, truncated: false,
			entries: Array.from({ length: 12 }, (_, i) => ({ name: `item-${i}.txt`, kind: "file", size: 10 }))
		},
		reset: {
			count: 13, bytes: 5960, exists: true, truncated: false,
			entries: [{ name: "AGENTS.md", kind: "file", size: 1864 }]
		}
	};

	/** 找一个 type==="button" 且可见文字等于 text 的节点。 */
	const textOf = (node) => (node.children ?? []).filter((c) => typeof c === "string").join("");
	const button = (tree, text) => findButtons(tree).find((b) => textOf(b) === text);
	const byProp = (tree, predicate) => {
		let found;
		const walk = (node) => {
			if (found !== undefined || node === null || typeof node !== "object") return;
			if (predicate(node)) { found = node; return; }
			for (const child of node.children ?? []) walk(child);
		};
		walk(tree);
		return found;
	};
	const dialog = (tree) => byProp(tree, (n) => n.props?.role === "alertdialog");
	// 必须从确认面板内部找输入框：面板里还有个 trashKeep 数字框排在前面，
	// 全树搜第一个 input 会拿到它，输进去的是「保留份数」而不是确认词。
	const confirmInput = (tree) => byProp(dialog(tree), (n) => n.type === "input");

	let doneCount = 0;
	let reactApi;

	// 宿主没给 cleanup 字段（旧构建）时要说清楚，而不是渲染一堆 undefined。
	// 注意：这段必须跑在主流程之前，并且自己独占一个 React 实例 ——
	// freshReact() 会改掉模块级的 api，主流程的 begin() 与组件用的实例必须是同一个，
	// 否则 hook 游标错位，状态永远对不上（这个坑我自己踩过一次）。
	{
		const bareReact = freshReact();
		for (const data of [{}, null]) {
			bareReact.begin();
			const bare = DangerZone({ data, readonly: false, tt });
			bareReact.flush();
			assert.match(JSON.stringify(bare), /宿主没有提供清理接口/, `data=${JSON.stringify(data)} 应提示宿主缺接口`);
			assert.equal(findButtons(bare).length, 0, "缺接口时不该渲染任何按钮");
		}
		bareReact.teardown();
		ok("宿主缺 cleanup 接口 → 明确提示，不渲染按钮");
	}

	reactApi = freshReact();
	const make = (overrides = {}) => {
		reactApi.begin();
		const tree = DangerZone({
			data: { cleanup },
			readonly: false,
			tt,
			onDone: async () => { doneCount += 1; },
			...overrides
		});
		reactApi.flush();
		return tree;
	};

	let tree = make();
	assert.ok(button(tree, "清空工作区") !== undefined, "应有清空按钮");
	assert.ok(button(tree, "重置工作区") !== undefined, "应有重置按钮");
	assert.equal(dialog(tree), undefined, "初始不该有确认面板");
	assert.match(JSON.stringify(tree), /当前内容/, "应显示当前内容");
	assert.match(JSON.stringify(tree), /12 项 · 4 KB/, "应把待清理项数与体积写成人话");
	assert.match(JSON.stringify(tree), /回收站/, "应显示回收站状态");
	assert.match(JSON.stringify(tree), /1 批 · 最新：20261008-231500-123/, "应显示回收站批次数与最新批次");
	assert.match(JSON.stringify(tree), /回收站保留份数/, "trashKeep 要有可见标签");
	ok("初始：两个危险按钮 + 状态行，无确认面板");

	// 逐字确认：未输入 / 输错时确认按钮必须禁用
	button(tree, "清空工作区").props.onClick();
	tree = make();
	assert.ok(dialog(tree) !== undefined, "点「清空」后应展开确认面板");
	assert.match(JSON.stringify(dialog(tree)), /确认清空「default-workspace」/, "要写明清的是哪个目录");
	assert.equal(button(tree, "确认清空").props.disabled, true, "一个字都没输入时不能放行");
	assert.match(JSON.stringify(dialog(tree)), /item-0\.txt/, "确认面板要列出将被搬走的条目");
	assert.match(JSON.stringify(dialog(tree)), /还有 4 项/, "12 条只列前 8 条，其余折叠计数");

	confirmInput(tree).props.onChange({ target: { value: "default-workspac" } });
	tree = make();
	assert.equal(button(tree, "确认清空").props.disabled, true, "确认词不符时不能放行");

	confirmInput(tree).props.onChange({ target: { value: "default-workspace" } });
	tree = make();
	assert.equal(button(tree, "确认清空").props.disabled, false, "逐字打对后才放行");
	ok("确认闸门：未输入/输错都禁用，逐字打对才可点");

	// 确认按钮真的把确认词发给宿主
	const calls = [];
	globalThis.fetch = async (path, init) => {
		calls.push({ path, body: JSON.parse(init.body) });
		return {
			ok: true,
			status: 200,
			json: async () => ({
				ok: true, action: "clear", movedCount: 12, bytes: 4096,
				trashPath: "C:\\ws\\_trash\\20261008-231500-123",
				pruned: [], failed: [], empty: false
			})
		};
	};
	await button(tree, "确认清空").props.onClick();
	assert.equal(calls.length, 1, "应发出一次请求");
	assert.equal(calls[0].path, CLEAR_PATH);
	assert.deepEqual(calls[0].body, { confirm: "default-workspace" });
	assert.equal(doneCount, 1, "执行成功后应回调 onDone 让面板重新拉状态");
	tree = make();
	assert.equal(dialog(tree), undefined, "执行后应收起确认面板");
	assert.match(JSON.stringify(tree), /已清空 12 项（4 KB）/, "应报出结果");
	assert.match(JSON.stringify(tree), /20261008-231500-123/, "应告诉用户去哪找回");
	ok("确认 → POST /clear 带上确认词，随后收起并报结果");

	// 重置走另一条路径，并额外提示 AGENTS.md 也会被搬走
	button(tree, "重置工作区").props.onClick();
	tree = make();
	const resetDialog = JSON.stringify(dialog(tree));
	assert.match(resetDialog, /AGENTS\.md 也会被搬走/, "重置要提示 AGENTS.md 也会被搬走");
	assert.match(resetDialog, /确认重置「default-workspace」/);
	assert.match(resetDialog, /AGENTS\.md/, "重置的清单里应有 AGENTS.md");
	confirmInput(tree).props.onChange({ target: { value: "default-workspace" } });
	tree = make();
	globalThis.fetch = async (path, init) => {
		calls.push({ path, body: JSON.parse(init.body) });
		return {
			ok: true,
			status: 200,
			json: async () => ({
				ok: true, action: "reset", movedCount: 13, bytes: 5960,
				trashPath: "C:\\ws\\_trash\\20261008-231600-000",
				pruned: [], failed: [],
				seed: { written: true }, workspaceError: null, empty: false
			})
		};
	};
	await button(tree, "确认重置").props.onClick();
	assert.equal(calls[1].path, RESET_PATH);
	assert.equal(calls[1].body.confirm, "default-workspace");
	tree = make();
	assert.match(JSON.stringify(tree), /已重置：搬走 13 项（5\.8 KB），AGENTS\.md 已重新生成/,
		"重置结果要说清 AGENTS.md 的去向");
	ok("重置 → POST /reset，文案点明 AGENTS.md 去向");

	// 宿主拒绝（例如插件已停用）时，错误要原样呈现而不是静默
	globalThis.fetch = async () => ({
		ok: false,
		status: 400,
		json: async () => ({ ok: false, error: "插件已禁用，拒绝清空或重置" })
	});
	button(tree, "清空工作区").props.onClick();
	tree = make();
	confirmInput(tree).props.onChange({ target: { value: "default-workspace" } });
	tree = make();
	await button(tree, "确认清空").props.onClick();
	tree = make();
	assert.match(JSON.stringify(tree), /插件已禁用，拒绝清空或重置/, "宿主拒绝的措辞要透出来");
	assert.match(JSON.stringify(tree), /失败：/, "并标记为失败");
	ok("宿主拒绝 → 原样显示宿主措辞，且不静默");

	// 空操作 vs 全部搬不动：两者 movedCount 都是 0，文案必须分得开。
	// 「什么都没动」和「想动但一个都没搬走」是两件事，混为一谈就是在骗用户。
	{
		const cases = [
			{
				name: "empty",
				reply: { ok: true, empty: true, movedCount: 0, bytes: 0, failed: [], trashPath: null, pruned: [] },
				expect: /没有可清理的内容/,
				reject: /已清空/
			},
			{
				name: "all-failed",
				reply: {
					ok: true, empty: false, movedCount: 0, attempted: 1, bytes: 0,
					failed: ["locked.txt"], trashPath: "C:\\ws\\_trash\\20261008-240000-000", pruned: []
				},
				expect: /没能搬走：locked\.txt/,
				reject: /没有可清理的内容|已清空/
			}
		];
		for (const item of cases) {
			globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => item.reply });
			// 上一次失败后确认面板是**留着**的（方便直接重试），成功后才收起；
			// 而按钮是开/关切换的，所以这里要先看状态再点，别把它关掉。
			if (dialog(tree) === undefined) button(tree, "清空工作区").props.onClick();
			tree = make();
			assert.ok(dialog(tree) !== undefined, `${item.name}: 确认面板应处于展开状态`);
			confirmInput(tree).props.onChange({ target: { value: "default-workspace" } });
			tree = make();
			await button(tree, "确认清空").props.onClick();
			tree = make();
			const shown = JSON.stringify(tree);
			assert.match(shown, item.expect, `${item.name} 应出现正确措辞`);
			assert.doesNotMatch(shown, item.reject, `${item.name} 不该出现误导性措辞`);
		}
		ok("空操作与全部搬不动分得清，不谎报「已清空」");
	}

	// 插件停用：面板只读，两个按钮都不给按
	const roTree = make({ readonly: true });
	assert.equal(button(roTree, "清空工作区").props.disabled, true, "只读时清空应禁用");
	assert.equal(button(roTree, "重置工作区").props.disabled, true, "只读时重置应禁用");
	ok("插件停用 → 两个危险按钮都禁用");
	reactApi.teardown();
}

console.log("\n[I] CSS 变量必须真实存在（回归）");
{
	// 这是一类会静默毁掉样式的 bug：写一个不存在的 CSS 变量，整条声明被判非法、
	// 浏览器直接忽略它，界面上什么都不会报错。
	//
	// 真实事故：开关轨道写成
	//   background: var(--dsw-alias-bg-brand, var(--dsw-alias-state-success))
	// 两个变量都不存在 → background 整条失效 → 开关不管开还是关都是个空心胶囊。
	//
	// 下面的清单是从 DSH 的 @deepseek-ai/dsh-client-ui-theme 实际定义里抄出来的。
	// DSH 新增 token 时这份清单可能偏旧，但「我用了清单外的名字」一律视为错误 ——
	// 宁可让人去核对一次，也不要再出现整条样式静默失效。
	const DSH_TOKENS = new Set([
		"--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2",
		"--dsw-alias-bg-layer-3", "--dsw-alias-bg-layer-4", "--dsw-alias-bg-mask-1",
		"--dsw-alias-bg-module-platform", "--dsw-alias-border-l1", "--dsw-alias-border-l2",
		"--dsw-alias-border-l3", "--dsw-alias-border-l4", "--dsw-alias-brand-primary",
		"--dsw-alias-button-primary-fill", "--dsw-alias-button-primary-hover",
		"--dsw-alias-button-ghost-active-border", "--dsw-alias-button-ghost-active-fill",
		"--dsw-alias-interactive-bg-active", "--dsw-alias-interactive-bg-hover",
		"--dsw-alias-interactive-bg-hover-danger", "--dsw-alias-label-caption",
		"--dsw-alias-label-dimmed", "--dsw-alias-label-error", "--dsw-alias-label-primary",
		"--dsw-alias-label-primary-foreground", "--dsw-alias-label-secondary",
		"--dsw-alias-label-shimmer", "--dsw-alias-label-tertiary", "--dsw-alias-link",
		"--dsw-alias-markdown-code-block", "--dsw-alias-markdown-inline-code",
		"--dsw-alias-markdown-tag", "--dsw-alias-state-business-primary",
		"--dsw-alias-state-error-primary", "--dsw-alias-state-idle-primary",
		"--dsw-alias-state-success-primary", "--dsw-alias-state-success-tertiary",
		"--dsw-alias-state-warn-label", "--dsw-alias-state-warn-primary",
		"--dsw-alias-state-warn-tertiary", "--dsw-alias-switch-thumb",
		"--dsw-alias-toast-bg", "--dsw-alias-toast-label", "--dsw-alias-tooltip-bg",
		"--dsw-alias-tooltip-key-bg", "--dsw-alias-scrollbar-bg-l2",
		"--dsw-alias-menu-group-header-fill", "--dsw-alias-menu-icon",
		"--dsw-elevation-panel", "--dsw-elevation-prominent", "--dsw-elevation-soft",
		"--dsw-elevation-stroke-color", "--dsw-focus-ring-color", "--dsw-focus-ring-width",
		"--dsw-font-family", "--dsw-font-markdown-code-font-family",
		"--dsw-font-markdown-base", "--dsw-font-markdown-base-strong",
		"--dsw-font-markdown-code", "--dsw-font-markdown-code-block",
		"--dsw-radius-xs", "--dsw-radius-sm", "--dsw-radius-md", "--dsw-radius-lg",
		"--dsw-radius-panel", "--dsw-shadow-lv3", "--dsw-static-neutral-bluish-00"
	]);

	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("./client.js", import.meta.url), "utf8");
	const used = new Set();
	for (const match of source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) used.add(match[1]);
	assert.ok(used.size >= 15, `应提取到足够多的 token，实际 ${used.size} 个`);

	const unknown = [...used].filter((token) => !DSH_TOKENS.has(token)).sort();
	assert.deepEqual(
		unknown,
		[],
		"以下 CSS 变量在 DSH 主题里不存在，会导致整条样式静默失效:\n    " + unknown.join("\n    ")
	);
	ok(`用到的 ${used.size} 个 --dsw-* 变量都真实存在`);
}

for (const dispose of disposers) try { dispose(); } catch { /* ignore */ }

console.log(`\n客户端全部通过（${passed} 项断言组）`);
