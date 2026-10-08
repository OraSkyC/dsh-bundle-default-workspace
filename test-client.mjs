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
				merged.children = flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat;
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
	const { PanelPage, SectionCard, StatusRow, Field, BoolField } = out.panel.components;
	for (const [label, component] of [
		["PanelPage", PanelPage], ["SectionCard", SectionCard], ["StatusRow", StatusRow],
		["Field", Field], ["BoolField", BoolField]
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

	// Field：文本输入 + 保存按钮 + 空值可恢复默认
	const fieldReact = freshReact();
	fieldReact.begin();
	const field = Field({
		name: "title", label: "标题", value: "已生效", kind: "text",
		disabled: false, emptyMeansDefault: true, tt: (k) => k
	});
	const fieldJson = JSON.stringify(field);
	assert.match(fieldJson, /已生效/);
	assert.match(fieldJson, /action\.save/);
	assert.match(fieldJson, /action\.reset/);
	assert.equal(field.children[0].props.value, "已生效");
	fieldReact.teardown();
	ok("Field 渲染当前值与保存/恢复按钮");

	// BoolField：开关 + 标签
	const boolReact = freshReact();
	boolReact.begin();
	const bool = BoolField({
		name: "enabled", label: "启用", value: true, disabled: false, tt: (k) => k
	});
	const boolJson = JSON.stringify(bool);
	assert.match(boolJson, /启用/);
	assert.match(boolJson, /"aria-checked":true/);
	boolReact.teardown();
	ok("BoolField 渲染开关状态");
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
	const { PanelPage, SectionCard, StatusRow, Field, BoolField } = out.panel.components;
	const states = [
		PanelPage({ tt: (key) => key, localeSubscribe: () => () => {} }),
		SectionCard({ title: "S", open: true, onToggle: () => {}, tt: (key) => key }),
		StatusRow({ label: "L", value: "V" }),
		Field({ name: "n", label: "L", value: "V", kind: "text", tt: (key) => key }),
		Field({ name: "n", label: "L", value: "", kind: "textarea", emptyMeansDefault: true, tt: (key) => key }),
		BoolField({ name: "n", label: "L", value: false, tt: (key) => key })
	];
	for (const state of states) walk(state);
	for (const key of used) assert.ok(key in zh, `缺字典键: ${key}`);
	ok(`渲染树引用 ${used.size} 个键，全部在字典中`);
}

console.log("\n[F] 端点路径");
{
	const { NS, STATE_PATH, SETTINGS_PATH, ENSURE_PATH } = out.panel.paths;
	assert.equal(NS, "dsh-bundle-default-workspace");
	assert.equal(STATE_PATH, "/api/dsh-bundle-default-workspace/state");
	assert.equal(SETTINGS_PATH, "/api/dsh-bundle-default-workspace/settings");
	assert.equal(ENSURE_PATH, "/api/dsh-bundle-default-workspace/ensure");
	ok(`面板端点: ${STATE_PATH} / ${SETTINGS_PATH} / ${ENSURE_PATH}`);
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
		pollSeconds: 30, allowedHosts: []
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
		toolRegistered: true
	};
	globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });

	// 首渲染 → loading；effect 里的 load() 打 fetch；再渲染一次拿数据分支
	let tree = renderPanel(panelReact, PanelPage, tt);
	await new Promise((resolve) => setTimeout(resolve, 10));
	tree = renderPanel(panelReact, PanelPage, tt);
	assert.ok(!JSON.stringify(tree).includes("panel.loading"), "应已进入数据分支");
	assert.match(JSON.stringify(tree), /default-workspace/, "应渲染出目录路径");
	ok("加载完成 → 渲染数据分支");

	// 四个区块的标题按钮都应存在（aria-label 形如 "<expand>: <title>"）
	const headerFor = (sectionKey) => findButtons(tree).find((button) => {
		const label = button.props?.["aria-label"];
		return typeof label === "string" && label.endsWith(": " + sectionKey);
	});
	for (const key of ["section.status", "section.base", "section.create", "section.advanced"]) {
		assert.ok(headerFor(key) !== undefined, `缺少区块标题按钮: ${key}`);
	}
	// 初始：前三个展开，高级默认收起
	for (const key of ["section.status", "section.base", "section.create"]) {
		assert.equal(headerFor(key).props["aria-expanded"], true, `${key} 初始应展开`);
	}
	assert.equal(headerFor("section.advanced").props["aria-expanded"], false, "section.advanced 初始应收起");
	ok("四个区块标题按钮齐备，初始展开态正确");

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
	ok("默认收起的「高级」→ 点击可展开并渲染内容");

	// 全部收起后，四个标题按钮依然都在（没有一个会消失）
	for (const key of ["section.status", "section.base", "section.create", "section.advanced"]) {
		const header = headerFor(key);
		if (header.props["aria-expanded"] === true) header.props.onClick();
	}
	tree = renderPanel(panelReact, PanelPage, tt);
	for (const key of ["section.status", "section.base", "section.create", "section.advanced"]) {
		assert.ok(headerFor(key) !== undefined, `全收起后 ${key} 的标题按钮消失了`);
	}
	ok("全部收起 → 四个标题按钮依旧全在");

	// 版本号小标：面板头部要能看出当前跑的是哪个构建
	assert.match(JSON.stringify(tree), /"v0\.1\.1"/, "面板应显示宿主报的版本号");
	ok("面板标题显示版本号 v0.1.1");

	panelReact.teardown();
}

for (const dispose of disposers) try { dispose(); } catch { /* ignore */ }

console.log(`\n客户端全部通过（${passed} 项断言组）`);
