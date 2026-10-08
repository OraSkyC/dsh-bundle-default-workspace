// 端到端验证：用假的宿主 context 驱动 apply()，再走 HTTP 路由与智能体工具。
// 跑完可删。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

	// 顶层禁令：这是种子里最重要的一条，掉了就等于没写
	assert.match(text, /不要在顶层直接创建文件/, "种子必须明确禁止在顶层建文件");
	assert.match(text, /临时文件/, "种子必须点名临时文件");
	assert.match(text, /_scratch\//, "种子必须给出临时文件的去处");
	assert.match(text, /node_modules\/.*dist\//s, "种子必须点名依赖目录与构建产物");
	assert.match(text, /先停下来问一句/, "种子必须给出「拿不准就问」的兜底");
	// 顺序：禁令要排在「不是项目」之前，越靠前权重越高
	assert.ok(
		text.indexOf("不要在顶层直接创建文件") < text.indexOf("这个工作区不是项目"),
		"顶层禁令应排在「这个工作区不是项目」之前"
	);
	ok("顶层禁令：明确、点名临时文件、给出去处、含询问兜底");

	// instructions 非空时整篇替换，顶层禁令也随之让位给用户自己的写法
	const custom = seedText({ ...settings, instructions: "# 我自己写的\n" });
	assert.equal(custom, "# 我自己写的\n");
	ok("instructions 非空 → 整篇替换（用户可覆盖这条规则）");

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
	await until(() => host.routes.length === 5 && host.tools.length === 1);
	await until(() => host.registry.workspaces.size === 1);

	assert.equal(host.routes.length, 5, "应注册 5 条路由");
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
	await until(() => host.routes.length === 5);
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

// ---- 10. 回收站原语 -------------------------------------------------
console.log("\n[10] 回收站原语");
{
	const {
		listClearable, listTop, selectForAction, measureTree, moveToTrash, pruneTrash, trashBatches, trashStamp
	} = await import("./lib/index.js");

	assert.match(await trashStamp(join(ROOT, "no-such-trash")), /^\d{8}-\d{6}-\d{3}$/);
	ok("批次名格式固定：自动清理据此判定归属");

	const tree = join(ROOT, "measure");
	await mkdir(join(tree, "a", "b"), { recursive: true });
	await writeFile(join(tree, "a", "b", "x.txt"), "0123456789", "utf8");
	assert.equal((await measureTree(tree)).bytes, 10);
	assert.equal((await measureTree(tree)).truncated, false);
	ok("measureTree 递归统计子目录体积");

	assert.deepEqual(
		await listClearable(join(ROOT, "does-not-exist"), "clear"),
		{ exists: false, count: 0, bytes: 0, entries: [], truncated: false }
	);
	ok("目录不存在 → listClearable 返回空且绝不创建");

	// 自动清理的安全边界：只删自己创建的批次名，用户往 _trash 里放的东西一概不碰
	const sandbox = join(ROOT, "prune-sandbox");
	const trashRoot = join(sandbox, "_trash");
	await mkdir(join(trashRoot, "20260101-000000-000"), { recursive: true });
	await mkdir(join(trashRoot, "20260102-000000-000"), { recursive: true });
	await mkdir(join(trashRoot, "20260103-000000-000"), { recursive: true });
	await mkdir(join(trashRoot, "important-backup"), { recursive: true });
	await writeFile(join(trashRoot, "keep.txt"), "keep", "utf8");

	const pruned = await pruneTrash(sandbox, 1);
	assert.deepEqual(pruned.removed, ["20260101-000000-000", "20260102-000000-000"]);
	assert.equal(pruned.kept, 1);
	assert.equal(existsSync(join(trashRoot, "20260103-000000-000")), true);
	assert.equal(existsSync(join(trashRoot, "important-backup")), true, "用户自己的目录不能被自动清理碰");
	assert.equal(existsSync(join(trashRoot, "keep.txt")), true, "用户自己的文件不能被自动清理碰");
	ok("保留策略只删自己创建的批次，用户的东西一概不碰");

	assert.deepEqual(await pruneTrash(sandbox, 0), { kept: 0, removed: [] });
	assert.equal(existsSync(join(trashRoot, "20260103-000000-000")), true);
	ok("trashKeep = 0 → 不自动清理");

	assert.deepEqual(await trashBatches(sandbox), ["20260103-000000-000"]);
	ok("trashBatches 只列出插件自己的批次，最新在前");

	// clear 与 reset 的清单必须严格是「差一个 AGENTS.md」的关系，且由同一次扫描派生。
	// 曾经各扫一遍盘、各算一套，既白花一倍 I/O，也让两份清单有对不上的余地。
	// 链接安全：工作区里指向「外面」的符号链接/联接点，搬走时必须只搬链接本身。
	// 这是「清理不会删到工作区外面」这条主张的核心，值得在真实文件系统上验一遍
	// （递归删除的老毛病就是跟着链接走进 C:\ 或网络盘）。
	{
		const outside = join(ROOT, "OUTSIDE");
		const ws = join(ROOT, "junction-ws");
		await mkdir(join(outside, "precious"), { recursive: true });
		await writeFile(join(outside, "precious", "keepme.txt"), "do not lose me", "utf8");
		await mkdir(join(ws, "_scratch"), { recursive: true });
		await writeFile(join(ws, "_scratch", "junk.txt"), "junk", "utf8");
		await writeFile(join(ws, "AGENTS.md"), "seed", "utf8");

		// Windows 上 'junction' 不需要管理员权限（真 symlink 需要开发者模式）。
		const linkPath = join(ws, "link-out");
		let linked = true;
		try {
			await symlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
		} catch {
			linked = false;
		}
		if (!linked) {
			ok("符号链接不可用 → 跳过链接安全用例（环境限制）");
		} else {
			// 1) 链接必须被认成 link，而不是插进目标目录当普通目录
			const survey = await listTop(ws);
			const entry = survey.entries.find((e) => e.name === "link-out");
			assert.equal(entry.kind, "link", "指向外面的链接必须识别为 link");
			assert.equal(entry.size, 0, "链接自身的元数据大小不该算进待搬体积");
			assert.equal(survey.bytes, 4 + 4, `体积只能算工作区自己的内容，实际 ${survey.bytes}`);

			// 2) measureTree 的**根**是链接时也不能跟进去（readdir 会跟随根）
			const followed = await measureTree(linkPath);
			assert.equal(followed.bytes, 0, "measureTree 不能跟随作为根传入的链接");
			assert.equal(followed.entries, 0, "更不能走进目标目录数条目");

			// 3) 搬走的是链接本身，目标毫发无损
			const move = await moveToTrash(ws, "clear");
			assert.deepEqual(
				move.moved.map((m) => m.name).sort(),
				["_scratch", "link-out"]
			);
			assert.equal(existsSync(join(outside, "precious", "keepme.txt")), true, "工作区外面的文件必须完好");
			assert.equal(await readFile(join(outside, "precious", "keepme.txt"), "utf8"), "do not lose me");
			assert.equal(existsSync(join(move.trashPath, "link-out")), true, "链接本身进了回收站");
			assert.equal(existsSync(join(ws, "AGENTS.md")), true, "清空仍保留 AGENTS.md");
			ok("指向工作区外面的链接只被搬走本身，目标毫发无损");
		}
	}

	const derive = join(ROOT, "derive");
	await mkdir(join(derive, "sub"), { recursive: true });
	await mkdir(join(derive, "_trash"), { recursive: true });
	await writeFile(join(derive, "AGENTS.md"), "seed", "utf8");
	await writeFile(join(derive, "a.txt"), "aa", "utf8");
	await writeFile(join(derive, "sub", "b.txt"), "bbb", "utf8");

	const top = await listTop(derive);
	// 顺序走 localeCompare（大小写不敏感的语序），不是码点序：给人看的清单，
	// a.txt 排在 AGENTS.md 前面比按 ASCII 把大写都堆在前面更自然。
	assert.deepEqual(top.entries.map((e) => e.name), ["a.txt", "AGENTS.md", "sub"]);
	assert.equal(top.bytes, 4 + 2 + 3);
	const clearView = selectForAction(top, "clear");
	const resetView = selectForAction(top, "reset");
	assert.deepEqual(clearView.entries.map((e) => e.name), ["a.txt", "sub"]);
	assert.equal(clearView.count, 2);
	assert.equal(clearView.bytes, 2 + 3);
	assert.equal(resetView.count, 3);
	assert.equal(resetView.bytes, top.bytes);
	assert.equal(resetView.count - clearView.count, 1, "reset 只该比 clear 多 AGENTS.md");
	assert.deepEqual(
		await listClearable(derive, "clear"),
		clearView,
		"listClearable 必须是 listTop 的纯派生，不能自己再扫一遍"
	);
	ok("clear / reset 清单同源派生，严格差一个 AGENTS.md");
}

// ---- 11. 清空 / 重置端到端 ------------------------------------------
console.log("\n[11] 清空与重置");
{
	const host = makeHost();
	const directoryName = "cleanup-ws";
	apply(host.ctx, {
		documentsDirectory: DOCS,
		directoryName,
		title: "清理测试",
		pollSeconds: 600
	});
	await until(() => host.routes.length === 5);
	await until(() => host.registry.workspaces.size === 1);

	const route = (suffix) => host.routes.find((r) => r.path.endsWith(suffix));
	const stateRoute = route("/state");
	const settingsRoute = route("/settings");
	const clearRoute = route("/clear");
	const resetRoute = route("/reset");
	const getState = async () => {
		const resp = makeResponse();
		await stateRoute.handler(makeRequest("GET", { host: "localhost" }), resp);
		return JSON.parse(resp.body);
	};
	const post = async (target, body) => {
		const resp = makeResponse();
		await target.handler(makeRequest("POST", { host: "localhost" }, body), resp);
		return { status: resp.status, body: JSON.parse(resp.body) };
	};

	const state0 = await getState();
	const dir = state0.defaultDirectory;
	assert.equal(dir, join(DOCS, "deepseek-harness", directoryName));

	// 确认词就是目录名：面板用它做逐字确认，两边必须同源
	assert.equal(state0.cleanup.confirmToken, directoryName);
	ok(`确认词 = 工作区目录名（${directoryName}）`);

	// 刚初始化：只有 AGENTS.md。清空不动它；重置把它算进去。
	assert.equal(state0.cleanup.clear.count, 0, "清空不应把 AGENTS.md 算进去");
	assert.equal(state0.cleanup.reset.count, 1, "重置必须把 AGENTS.md 算进去");
	assert.equal(state0.cleanup.trashCount, 0);
	ok("清空保留 AGENTS.md、重置含 AGENTS.md，统计口径分开");

	// 造点乱七八糟的东西
	await mkdir(join(dir, "_scratch"), { recursive: true });
	await mkdir(join(dir, "notes"), { recursive: true });
	await writeFile(join(dir, "_scratch", "junk.bin"), "x".repeat(2048), "utf8");
	await writeFile(join(dir, "tmp.txt"), "tmp", "utf8");
	await writeFile(join(dir, "notes", "a.md"), "note", "utf8");

	const state1 = await getState();
	assert.equal(state1.cleanup.clear.count, 3, JSON.stringify(state1.cleanup.clear));
	assert.equal(state1.cleanup.clear.bytes, 2048 + 3 + 4);
	assert.deepEqual(state1.cleanup.clear.entries.map((e) => e.name), ["_scratch", "notes", "tmp.txt"]);
	assert.equal(state1.cleanup.clear.entries.find((e) => e.name === "_scratch").kind, "dir");
	ok("状态快照给出待清理条目名、类型与体积");

	// _trash 自己永远不算待清理内容
	await mkdir(join(dir, "_trash"), { recursive: true });
	assert.equal((await getState()).cleanup.clear.count, 3, "_trash 自身不该被算作待清理内容");
	ok("_trash 自身不计入待清理内容");

	// dryRun：只读预演，一个字节都不动
	const dry = await post(clearRoute, { dryRun: true });
	assert.equal(dry.status, 200);
	assert.equal(dry.body.dryRun, true);
	assert.equal(dry.body.count, 3);
	assert.equal(existsSync(join(dir, "tmp.txt")), true, "dryRun 不能动文件");
	ok("dryRun 只预演、不动文件");

	// 校验顺序：来源 → 方法 → body → 确认词
	const bad = await post(clearRoute, { confirm: "wrong" });
	assert.equal(bad.status, 400);
	assert.match(bad.body.error, /确认文字不匹配/);
	ok("确认词不符 → 400，且报出该输入什么");

	const missing = await post(clearRoute, {});
	assert.equal(missing.status, 400);
	ok("缺少确认词 → 400");

	const noBody = makeResponse();
	await clearRoute.handler(makeRequest("POST", { host: "localhost" }), noBody);
	assert.equal(noBody.status, 400);
	ok("空请求体 → 400");

	const wrongMethod = makeResponse();
	await clearRoute.handler(makeRequest("GET", { host: "localhost" }), wrongMethod);
	assert.equal(wrongMethod.status, 405);
	ok("非 POST → 405");

	const badOrigin = makeResponse();
	await clearRoute.handler(makeRequest("POST", { host: "evil.example" }, { confirm: directoryName }), badOrigin);
	assert.equal(badOrigin.status, 403);
	ok("非回环来源 → 403");

	// 真的清空
	const cleared = await post(clearRoute, { confirm: directoryName });
	assert.equal(cleared.status, 200);
	assert.equal(cleared.body.ok, true);
	assert.equal(cleared.body.movedCount, 3);
	assert.equal(cleared.body.attempted, 3);
	assert.deepEqual(cleared.body.failed, []);
	// movedCount 只数真正搬成功的条目；失败的留在 moved 里带 error。
	// 否则面板会说「已清空 3 项」同时列出一条失败，两个数字自相矛盾。
	assert.equal(
		cleared.body.movedCount,
		cleared.body.moved.filter((entry) => entry.error === undefined).length
	);
	assert.equal(existsSync(join(dir, "tmp.txt")), false);
	assert.equal(existsSync(join(dir, "_scratch")), false);
	assert.equal(existsSync(join(dir, "notes")), false);
	assert.equal(existsSync(join(dir, "AGENTS.md")), true, "清空必须保留 AGENTS.md");
	assert.equal(existsSync(join(dir, "_trash")), true);
	ok("清空 → 内容搬空，AGENTS.md 与回收站留下");

	// 内容确实在回收站里，可以捞回来
	const stamp = cleared.body.trashPath.split(/[\\/]/).pop();
	assert.match(stamp, /^\d{8}-\d{6}-\d{3}$/);
	assert.equal(await readFile(join(cleared.body.trashPath, "tmp.txt"), "utf8"), "tmp");
	assert.equal(await readFile(join(cleared.body.trashPath, "notes", "a.md"), "utf8"), "note");
	ok(`内容进了回收站且可读回: _trash/${stamp}/`);

	// 用 rename 搬走，不进入子目录：内容是整棵搬过去的
	assert.equal(
		(await stat(join(cleared.body.trashPath, "_scratch", "junk.bin"))).size,
		2048
	);
	ok("子目录整棵搬走，未逐文件复制");

	const clearedAgain = await post(clearRoute, { confirm: directoryName });
	assert.equal(clearedAgain.body.movedCount, 0);
	assert.equal(clearedAgain.body.empty, true);
	assert.equal(clearedAgain.body.trashPath, null);
	ok("已清空的工作区再次清空 → 什么都不做");

	const state2 = await getState();
	assert.equal(state2.cleanup.clear.count, 0);
	assert.equal(state2.cleanup.trashCount, 1, JSON.stringify(state2.cleanup.trashBatches));
	ok("面板能看到回收站里有 1 批");

	// 重置：AGENTS.md 一起搬走，然后按当前设置重新生成
	const resetted = await post(resetRoute, { confirm: directoryName });
	assert.equal(resetted.body.ok, true);
	assert.equal(resetted.body.movedCount, 1,
		"重置只该搬 AGENTS.md: " + JSON.stringify(resetted.body.moved));
	assert.deepEqual(resetted.body.moved.map((m) => m.name), ["AGENTS.md"]);
	// 回归：_trash 绝不能被 reset 搬走——那等于让它把自己搬进自己里面
	assert.equal(existsSync(join(dir, "_trash", stamp)), true, "reset 不能动 _trash");
	assert.equal(resetted.body.seed.written, true, "重置后必须重新落盘 AGENTS.md");
	assert.equal(existsSync(join(dir, "AGENTS.md")), true);
	assert.match(await readFile(join(dir, "AGENTS.md"), "utf8"), /^# 清理测试/);
	assert.equal(resetted.body.workspaceError, null, "重置后登记应仍然有效");
	ok("重置 → 连 AGENTS.md 一起搬走，随后按当前设置重新生成");

	const state3 = await getState();
	assert.equal(state3.cleanup.trashCount, 2);
	assert.equal(state3.cleanup.clear.count, 0);
	assert.ok(state3.cleanup.trashBatches[0] > state3.cleanup.trashBatches[1], "批次应最新在前");
	ok("两次操作 → 回收站里 2 批，最新在前");

	// 保留份数：调成 1，下一次清理会删掉最旧的那批
	const setKeep = await post(settingsRoute, { field: "trashKeep", value: 1 });
	assert.equal(setKeep.body.effective.trashKeep, 1);
	await writeFile(join(dir, "again.txt"), "again", "utf8");
	const prunedRun = await post(clearRoute, { confirm: directoryName });
	assert.equal(prunedRun.body.pruned.length, 2, JSON.stringify(prunedRun.body.pruned));
	const state4 = await getState();
	assert.equal(state4.cleanup.trashCount, 1);
	ok("trashKeep 生效：最旧批次被真正删除，只留 1 批");

	// trashKeep 越界回落
	const clamped = await post(settingsRoute, { field: "trashKeep", value: 9999 });
	assert.equal(clamped.body.effective.trashKeep, 100);
	const clampedLow = await post(settingsRoute, { field: "trashKeep", value: -5 });
	assert.equal(clampedLow.body.effective.trashKeep, 0);
	ok("trashKeep 夹取到 0..100");

	// 插件停用时拒绝清空：面板只读，接口也不能被绕过
	const disabledHost = makeHost();
	apply(disabledHost.ctx, {
		documentsDirectory: DOCS,
		directoryName: "disabled-ws",
		enabled: false,
		seedAgentsMd: false,
		pollSeconds: 600
	});
	await until(() => disabledHost.routes.length === 5);
	const disabledClear = disabledHost.routes.find((r) => r.path.endsWith("/clear"));
	const disabledResp = makeResponse();
	await disabledClear.handler(makeRequest("POST", { host: "localhost" }, { confirm: "disabled-ws" }), disabledResp);
	assert.equal(disabledResp.status, 400);
	assert.match(JSON.parse(disabledResp.body).error, /已禁用/);
	ok("插件停用 → 拒绝清空或重置（面板只读，接口也不放行）");
	for (const dispose of disabledHost.disposers) dispose();

	for (const dispose of host.disposers) dispose();
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n全部通过（${passed} 项断言组）`);
