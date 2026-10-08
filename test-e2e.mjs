// 端到端验证：用假的宿主 context 驱动 apply()，再走 HTTP 路由与智能体工具。
// 跑完可删。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "dsh-dw-test-"));
process.env.DSH_HOME = ROOT;

const {
	apply,
	resolveSettings,
	displayTitle,
	seedText,
	writeSeed,
	resolveParent,
	FileStore,
	isAdmitted,
	bareHost,
	VERSION
} = await import("./lib/index.js");

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };

// ---- 假的宿主上下文 -------------------------------------------------
function makeHost(config) {
	const routes = [];
	const tools = [];
	const disposers = [];
	const registry = {
		workspaces: new Map(),
		async resolveByPath(path) {
			for (const w of this.workspaces.values()) if (w.path === path) return w;
			return undefined;
		},
		async create(path) {
			const id = `ws-${this.workspaces.size + 1}`;
			const w = {
				id,
				path,
				title: resolve(path).split(/[\\/]/).pop(),
				sessionIds: [],
				async setTitle(t) { this.title = t; }
			};
			this.workspaces.set(id, w);
			return w;
		}
	};
	const ctx = {
		logger: { warn() {}, info() {}, error() {} },
		get(name) {
			if (name === "webServer") return ctx.webServer;
			if (name === "tools") return ctx.tools;
			if (name === "workspaceRegistry") return registry;
			return undefined;
		},
		webServer: { register(def) { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1); }; } },
		tools: { register(def) { tools.push(def); return () => { const i = tools.indexOf(def); if (i >= 0) tools.splice(i, 1); }; } },
		effect(fn, _tag) { disposers.push(fn()); return () => {}; },
		once(event, handler) { if (event === "disposed") disposers.push(() => handler()); }
	};
	return { ctx, routes, tools, disposers, registry };
}

// ---- 假的 HTTP 请求/响应 -------------------------------------------
function makeRequest(method, headers = {}, body = undefined) {
	const request = { method, headers };
	if (body !== undefined) {
		const text = JSON.stringify(body);
		const chunk = Buffer.from(text, "utf8");
		request[Symbol.asyncIterator] = async function* () {
			yield chunk;
		};
	}
	return request;
}
function makeResponse() {
	const response = { status: 0, headers: {}, body: "" };
	response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
	response.end = (body) => { response.body = body; };
	return response;
}

const tick = () => new Promise((r) => setTimeout(r, 30));

// 等到 predicate 成立或超时；避免靠固定 sleep 与异步装配赛跑。
async function until(predicate, timeoutMs = 5000, stepMs = 25) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error("until() 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

// 测试用的固定文档目录：绕开 PowerShell 探测，保证时序确定。
const DOCS = join(ROOT, "home", "Documents");

// ---- 0. 回归：inject 声明与受限代理 ---------------------------------
console.log("\n[0] 回归：inject 声明与受限代理");
{
	const { inject, hostName, name, VERSION } = await import("./lib/index.js");
	// webServer 必须是硬依赖：否则 ctx 代理抛 `cannot get property "webServer"
	// without inject`，apply() 整体失败，三条路由全部 404。
	assert.ok(inject.includes("webServer"), `inject 应含 webServer，实际: ${JSON.stringify(inject)}`);
	ok(`inject 声明硬依赖: ${JSON.stringify(inject)}`);
	assert.equal(hostName, name);
	ok(`name === hostName === ${name}`);

	// 版本号必须来自 package.json：面板的版本小标就是靠它确认新构建有没有被加载，
	// 代码里写死一处、package.json 另一处，这个信号就废了。
	const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
	assert.equal(VERSION, manifest.version, `VERSION(${VERSION}) 应与 package.json(${manifest.version}) 一致`);
	assert.notEqual(VERSION, "0.0.0", "VERSION 不应是读取失败的回落值");
	ok(`VERSION 与 package.json 一致: ${VERSION}`);

	// 模拟 Cordis 的受限代理：未声明的属性访问会抛。
	// 即使 webServer 拿不到，apply() 也必须静默降级、绝不抛错。
	const ctx = {
		logger: { warn() {}, info() {}, error() {} },
		get() { return undefined; },
		effect(fn) { return fn(); },
		once() {}
	};
	Object.defineProperty(ctx, "webServer", {
		get() { throw new Error('cannot get property "webServer" without inject'); },
		configurable: true
	});
	let threw = null;
	try {
		apply(ctx, {});
	} catch (error) {
		threw = error;
	}
	assert.equal(threw, null, `apply() 不应抛错: ${threw?.message ?? threw}`);
	ok("ctx.webServer 抛受限代理错误 → apply() 静默降级");
}

// ---- 1. 配置归一化 --------------------------------------------------
console.log("\n[1] 配置归一化");
{
	const { settings, configError } = resolveSettings({});
	assert.equal(settings.directoryName, "default-workspace");
	assert.equal(settings.enabled, true);
	assert.equal(configError, null);
	ok("空配置 → 默认值");

	const bad = resolveSettings({ parentDirectory: "relative" });
	assert.equal(bad.settings.parentDirectory, "");
	assert.match(bad.configError, /绝对路径/);
	ok("非法父目录 → 回落 + configError");
}

// ---- 2. 目录解析 ----------------------------------------------------
console.log("\n[2] 目录解析");
{
	const parent = await resolveParent(resolveSettings({ parentDirectory: "D:\\dev\\misc", directoryName: "mine" }).settings);
	assert.equal(parent.parentSource, "config");
	assert.ok(parent.directory.endsWith("misc" + String.fromCharCode(92) + "mine"), parent.directory);
	ok("显式父目录 → config 来源");

	const fallback = await resolveParent(resolveSettings({}).settings);
	assert.ok(fallback.parentSource === "documents" || fallback.parentSource === "fallback", fallback.parentSource);
	ok(`自动探测父目录 → ${fallback.parentSource}: ${fallback.parent}`);
}

// ---- 3. AGENTS.md 种子 ---------------------------------------------
console.log("\n[3] AGENTS.md 种子");
{
	const settings = resolveSettings({}).settings;
	assert.equal(displayTitle(settings), "默认工作区");
	assert.equal(displayTitle(resolveSettings({ title: "我的" }).settings), "我的");
	assert.equal(displayTitle(resolveSettings({ directoryName: "misc" }).settings), "misc");
	ok("派生标题");

	const text = seedText(settings);
	assert.match(text, /^# 默认工作区/);
	assert.match(text, /这个工作区不是项目/);
	ok("内置种子正文");

	const target = join(ROOT, "seed-target");
	await mkdir(target, { recursive: true });
	const first = await writeSeed(settings, target);
	assert.equal(first.written, true);
	assert.ok(existsSync(join(target, "AGENTS.md")));
	ok("首次写入");

	// 用户改过后不应被覆盖
	await import("node:fs/promises").then(({ writeFile }) => writeFile(join(target, "AGENTS.md"), "# 我改过\n", "utf8"));
	const second = await writeSeed(settings, target);
	assert.equal(second.written, false);
	assert.equal(await readFile(join(target, "AGENTS.md"), "utf8"), "# 我改过\n");
	ok("已存在且不覆盖 → 保留用户修改");

	const third = await writeSeed({ ...settings, overwriteSeed: true }, target);
	assert.equal(third.written, true);
	assert.match(await readFile(join(target, "AGENTS.md"), "utf8"), /^# 默认工作区/);
	ok("overwriteSeed → 覆盖");
}

// ---- 4. 状态覆盖层 --------------------------------------------------
console.log("\n[4] 状态覆盖层");
{
	const dir = join(ROOT, "store");
	const store = new FileStore({ dir, file: "settings.json" });
	assert.deepEqual(await store.read(), {});
	const next = await store.mutate((c) => ({ ...c, title: "面板标题" }));
	assert.deepEqual(next, { title: "面板标题" });
	const merged = resolveSettings({ ...{ directoryName: "deployed" }, ...next }).settings;
	assert.equal(merged.title, "面板标题");
	assert.equal(merged.directoryName, "deployed");
	ok("覆盖层只存改过的字段，与部署配置合并");

	await store.mutate((c) => { const copy = { ...c }; delete copy.title; return copy; });
	assert.deepEqual(resolveSettings({ ...{ title: "patch标题" }, ...(await store.read()) }).settings.title, "patch标题");
	ok("删除覆盖 → 回落到部署配置");
}

// ---- 5. 信任围栏 ----------------------------------------------------
console.log("\n[5] 信任围栏");
{
	assert.equal(isAdmitted({ headers: { host: "localhost:8848" } }, []), true);
	assert.equal(isAdmitted({ headers: { host: "127.0.0.1" } }, []), true);
	assert.equal(isAdmitted({ headers: { host: "::1" } }, []), true);
	assert.equal(isAdmitted({ headers: { host: "[::1]" } }, []), true);
	assert.equal(isAdmitted({ headers: { host: "[::1]:8848" } }, []), true);
	assert.equal(isAdmitted({ headers: { host: "localhost, 127.0.0.1" } }, []), true);
	assert.equal(isAdmitted({ headers: { host: "evil.example" } }, []), false);
	assert.equal(isAdmitted({ headers: { host: "example.com:443" } }, []), false);
	assert.equal(isAdmitted({ headers: { host: "example.com" } }, ["example.com"]), true);
	assert.equal(isAdmitted({ headers: { host: "evil.example.com" } }, ["example.com"]), false);
	assert.equal(isAdmitted({ headers: { host: "" } }, []), false);
	assert.equal(isAdmitted({ headers: {} }, []), false);
	assert.equal(isAdmitted({}, []), false);
	assert.equal(bareHost("::1"), "::1");
	assert.equal(bareHost("[::1]:8848"), "::1");
	assert.equal(bareHost("localhost:8848"), "localhost");
	assert.equal(bareHost("127.0.0.1"), "127.0.0.1");
	assert.equal(bareHost("localhost, 127.0.0.1"), "localhost");
	assert.equal(bareHost(""), "");
	assert.equal(bareHost(undefined), "");
	ok("只放行回环与显式白名单；IPv6 不被误剥端口");
}

// ---- 6. apply() 装配 + 路由 -----------------------------------------
console.log("\n[6] apply() 装配与 HTTP 路由");
{
	const host = makeHost();
	apply(host.ctx, {
		documentsDirectory: DOCS,
		directoryName: "default-workspace",
		title: "默认工作区",
		pollSeconds: 600
	});
	await until(() => host.routes.length === 3 && host.tools.length === 1);
	await until(() => host.registry.workspaces.size === 1);

	assert.equal(host.routes.length, 3, "应注册 3 条路由");
	ok(`路由: ${host.routes.map((r) => r.path).join(" | ")}`);
	assert.equal(host.tools.length, 1, "应注册 1 个工具");
	assert.equal(host.tools[0].name, "default_workspace");
	ok(`工具: ${host.tools[0].name}`);

	// GET state —— 首轮 refresh 应已创建目录 + 登记 + 播种
	const stateRoute = host.routes.find((r) => r.path.endsWith("/state"));
	const stateResp = makeResponse();
	await stateRoute.handler(makeRequest("GET", { host: "localhost" }), stateResp);
	const state = JSON.parse(stateResp.body);
	assert.equal(state.ok, true);
	assert.equal(state.directoryExists, true);
	assert.ok(state.workspace !== null, JSON.stringify(state.workspace));
	assert.equal(state.workspace.title, "默认工作区");
	assert.equal(state.workspace.sessionCount, 0);
	assert.equal(state.workspace.path, state.defaultDirectory);
	assert.equal(state.workspaceError, null);
	assert.equal(state.seedExists, true);
	assert.equal(state.toolRegistered, true);
	assert.equal(state.plugin.version, VERSION);
	ok("GET state → 目录已建、已登记、已播种");
	ok(`路径: ${state.defaultDirectory}`);

	// GET state 无副作用：再调一次 workspace 数不变
	const wsCount = host.registry.workspaces.size;
	await stateRoute.handler(makeRequest("GET", { host: "localhost" }), makeResponse());
	assert.equal(host.registry.workspaces.size, wsCount);
	ok("GET state 幂等、无副作用");

	// 403
	const refused = makeResponse();
	await stateRoute.handler(makeRequest("GET", { host: "bad.example" }), refused);
	assert.equal(refused.status, 403);
	ok("非回环来源 → 403");

	// 405
	const badMethod = makeResponse();
	await stateRoute.handler(makeRequest("DELETE", { host: "localhost" }), badMethod);
	assert.equal(badMethod.status, 405);
	ok("非 GET/HEAD → 405");

	// POST settings：改标题
	const settingsRoute = host.routes.find((r) => r.path.endsWith("/settings"));
	const putResp = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "title", value: "临时区" }), putResp);
	assert.equal(putResp.status, 200);
	const putBody = JSON.parse(putResp.body);
	assert.equal(putBody.ok, true);
	assert.equal(putBody.effective.title, "临时区");
	ok("POST settings 改标题 → 生效");

	// 未知字段
	const unknown = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "nope", value: 1 }), unknown);
	assert.equal(unknown.status, 400);
	ok("未知字段 → 400");

	// 删除覆盖
	const delResp = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "title", value: null }), delResp);
	const delBody = JSON.parse(delResp.body);
	assert.equal(delBody.ok, true);
	assert.equal(delBody.effective.title, "默认工作区");
	ok("删除覆盖 → 回落到部署配置");

	// POST ensure
	const ensureRoute = host.routes.find((r) => r.path.endsWith("/ensure"));
	const ensureResp = makeResponse();
	await ensureRoute.handler(makeRequest("POST", { host: "localhost" }), ensureResp);
	const ensureBody = JSON.parse(ensureResp.body);
	assert.equal(ensureBody.ok, true);
	assert.ok(ensureBody.workspace !== null, JSON.stringify(ensureBody));
	assert.equal(ensureBody.workspace.title, "默认工作区");
	assert.equal(ensureBody.workspace.path, ensureBody.directory);
	assert.equal(ensureBody.seed.written, false);
	ok("POST ensure → 幂等复用，不重写 AGENTS.md");

	// ---- 7. 工具 execute ----------------------------------------------
	console.log("\n[7] 智能体工具");
	const tool = host.tools[0];
	const statusResult = await tool.execute({ action: "status" });
	assert.equal(statusResult.directoryExists, true);
	assert.equal(statusResult.registered, true);
	assert.equal(statusResult.title, "默认工作区");
	assert.equal(statusResult.workspace.title, "默认工作区");
	assert.equal(statusResult.workspace.path, statusResult.directory);
	assert.equal(statusResult.seedExists, true);
	assert.equal(statusResult.enabled, true);
	assert.equal(statusResult.configError, null);
	ok("execute(status) → 只读状态");

	const pathResult = await tool.execute({ action: "path" });
	assert.equal(typeof pathResult.directory, "string");
	assert.equal(pathResult.parentSource, "documents");
	ok("execute(path)");

	const describeResult = await tool.execute({ action: "describe" });
	assert.equal(describeResult.title, "默认工作区");
	assert.match(describeResult.description, /杂七杂八/);
	ok("execute(describe)");

	const ensureResult = await tool.execute({ action: "ensure" });
	assert.equal(ensureResult.ok, true);
	assert.equal(ensureResult.seed.written, false);
	ok("execute(ensure) → 幂等");

	// render
	const rendered = tool.output.render({}, { ok: true, title: "默认工作区" });
	assert.equal(rendered[0].type, "text");
	assert.match(rendered[0].text, /默认工作区/);
	ok("output.render");

	for (const dispose of host.disposers) dispose();
}

// ---- 8. autoCreate 关闭时不创建 -------------------------------------
console.log("\n[8] autoCreate: false 时不创建");
{
	const host = makeHost();
	const directoryName = "never-created";
	apply(host.ctx, {
		documentsDirectory: DOCS,
		directoryName,
		autoCreate: false,
		seedAgentsMd: false,
		pollSeconds: 600
	});
	await until(() => host.routes.length === 3);
	const stateRoute = host.routes.find((r) => r.path.endsWith("/state"));
	const resp = makeResponse();
	await stateRoute.handler(makeRequest("GET", { host: "localhost" }), resp);
	// refreshFromSettings 在 autoCreate=false 时提前返回，不会创建目录
	const state = JSON.parse(resp.body);
	assert.equal(state.directoryExists, false);
	assert.equal(state.workspace, null);
	assert.equal(state.seedExists, false);
	assert.ok(state.defaultDirectory.endsWith(`deepseek-harness${String.fromCharCode(92)}${directoryName}`), state.defaultDirectory);
	ok("autoCreate 关闭 → 不建目录、不登记、不播种");
	for (const dispose of host.disposers) dispose();
}

// ---- 9. 工具不可用时降级 -------------------------------------------
console.log("\n[9] 拿不到 tools / webServer 时静默降级");
{
	const ctx = {
		logger: { warn() {} },
		get() { return undefined; },
		effect(fn) { return fn; },
		once() {}
	};
	// 不应抛错
	apply(ctx, {});
	await tick();
	ok("无 webServer / tools / workspaceRegistry → apply() 不抛错");
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n全部通过（${passed} 项断言组）`);
