/**
 * dsh-bundle-default-workspace —— Host 半侧。
 *
 * 提供一个「默认工作区」：杂七杂八的小事不必区分项目时就用它。
 *
 *   - 部署默认值来自本 bundle 的 cordis.patch.yml（config 行）；
 *   - 面板里改的值落到本插件自己的状态文件，作为稀疏覆盖层，立即生效、无需重启；
 *   - 面板走 /api/<name>/state 读状态、/settings 改设置、/ensure 确保工作区；
 *   - 智能体走 default_workspace 工具查询与创建；
 *   - 首次使用时在目标目录写入 AGENTS.md，让智能体明白这个工作区是干什么的。
 *
 * 刻意不静态 import 任何 @deepseek-ai/* 同伴包：宿主服务一律 ctx.get() 惰性读取，
 * 因此本 bundle 在没有 tools / webServer / workspaceRegistry 的精简宿主上也能加载，
 * 只是拿不到对应能力（拿不到就不注册，绝不在挂载时抛错）。
 *
 * @module dsh-bundle-default-workspace
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 包名：面板路由、状态文件、设置命名空间都以它为根。 */
const name = "dsh-bundle-default-workspace";
/** 宿主侧 entry 名。 */
const hostName = name;
/**
 * 宿主硬依赖声明。
 *
 * 关键：Cordis 的 ctx 是受限代理——访问**未列在 inject 里**的属性会直接抛
 * `cannot get property "webServer" without inject`，而不是返回 undefined。
 * 所以必须把 webServer 声明进来，否则 registerRoutes 第一行就炸，
 * 整个 apply() 失败，插件在面板里显示「异常」且三条路由全部 404。
 *
 * tools / workspaceRegistry 是**可选**服务：不声明，改用 ctx.get() 带 try 读取
 * （见 resolveService）。
 */
const inject = ["webServer"];

/* ------------------------------------------------------------------ */
/* 配置契约                                                             */
/* ------------------------------------------------------------------ */

/**
 * 每个字段的部署默认值。面板写入的覆盖层缺省的字段回落到这里。
 * @type {Readonly<{[key: string]: unknown}>}
 */
const DEFAULTS = {
	/** 启用插件；关闭时不创建工具、不自动建目录，面板只读。 */
	enabled: true,
	/** 叶子目录名；与 DSH 内核首用工作区同名，默认配置下包装内核的默认工作区。 */
	directoryName: "default-workspace",
	/** 父目录覆盖。留空 = <系统文档目录>/deepseek-harness。 */
	parentDirectory: "",
	/** 系统文档目录覆盖。仅在 parentDirectory 为空时生效；留空 = 自动探测。 */
	documentsDirectory: "",
	/** 展示标题。留空 = 由目录名派生。 */
	title: "",
	/** 用途说明，展示在面板与 AGENTS.md；留空使用内置文案。 */
	description: "",
	/** 首次使用时自动创建目录并登记为工作区。 */
	autoCreate: true,
	/** 创建后写入 AGENTS.md。 */
	seedAgentsMd: true,
	/** 种子正文。留空 = 内置文案；非空则整篇替换。 */
	instructions: "",
	/** 即使 AGENTS.md 已存在也重写。 */
	overwriteSeed: false,
	/** 面板刷新间隔（秒）。 */
	pollSeconds: 30,
	/** 回收站保留份数。超出数量的最旧批次会被真正删除；0 = 不自动清理。 */
	trashKeep: 5,
	/** 允许访问面板的额外主机名（叠加，不替换回环默认值）。 */
	allowedHosts: []
};

/** 与 DSH 内核首用工作区使用的同名父目录。 */
const DEFAULT_BASE = "deepseek-harness";
/**
 * 版本号。从 package.json 读，**不要在代码里再写一遍**：
 * 面板的版本小标就是靠它确认「新构建到底有没有被宿主加载」的
 * （宿主把客户端 bundle 在激活时读进内存，改完不重启看不到），
 * 写死就会和 package.json 漂移，那个信号也就废了。
 * 读不到时回落 "0.0.0"，绝不因此让模块加载失败。
 */
const VERSION = (() => {
	try {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		return typeof manifest.version === "string" && manifest.version !== "" ? manifest.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
})();
/** 目录名允许的字符集：字母、数字、点、下划线、连字符；禁止空、`.`、`..`。 */
const DIR_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** 探测系统文档目录的截止时间。 */
const LOOKUP_TIMEOUT_MS = 10_000;
/** 面板轮询间隔的上下界（秒）。 */
const POLL_MIN_S = 5;
const POLL_MAX_S = 600;
/** 回收站保留份数的上下界。 */
const TRASH_KEEP_MIN = 0;
const TRASH_KEEP_MAX = 100;

/** 字符串读取：折叠空白，非字符串返回回落值。 */
const str = (value, fallback = "") => {
	const text = typeof value === "string" ? value.trim() : fallback;
	return text === "" ? text : text.replace(/\s+/g, " ");
};

/** 数值读取：非有限数返回回落值。 */
const num = (value, fallback) => {
	const parsed = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * 归一化配置：默认值 → 部署配置 → 面板覆盖层，逐字段校验。
 * 无效值就地回落为默认值，不抛错——面板能继续读，宿主不会因一次误写崩掉。
 * 硬错误（父目录不是绝对路径）记在 configError，由面板呈现。
 * @param {object} raw - 合并后的原始配置。
 * @returns {{settings: object, configError: string|null}}
 */
function resolveSettings(raw = {}) {
	const source = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
	const out = {};
	let configError = null;

	out.enabled = typeof source.enabled === "boolean" ? source.enabled : true;
	out.directoryName = str(source.directoryName) || "default-workspace";
	out.title = str(source.title);
	out.description = typeof source.description === "string" ? source.description.trim() : "";
	out.instructions = typeof source.instructions === "string" ? source.instructions.trim() : "";
	out.autoCreate = typeof source.autoCreate === "boolean" ? source.autoCreate : true;
	out.seedAgentsMd = typeof source.seedAgentsMd === "boolean" ? source.seedAgentsMd : true;
	out.overwriteSeed = typeof source.overwriteSeed === "boolean" ? source.overwriteSeed : false;
	out.parentDirectory = (() => {
		const text = str(source.parentDirectory);
		return text === "" ? "" : normalize(text);
	})();
	out.documentsDirectory = (() => {
		const text = str(source.documentsDirectory);
		return text === "" ? "" : normalize(text);
	})();

	if (out.parentDirectory !== "" && !isAbsolute(out.parentDirectory)) {
		configError = `parentDirectory 必须是绝对路径，收到 '${out.parentDirectory}'`;
		out.parentDirectory = "";
	}
	if (out.documentsDirectory !== "" && !isAbsolute(out.documentsDirectory)) {
		configError = configError ?? `documentsDirectory 必须是绝对路径，收到 '${out.documentsDirectory}'`;
		out.documentsDirectory = "";
	}
	if (!DIR_NAME_RE.test(out.directoryName)) {
		configError = configError ?? `directoryName '${out.directoryName}' 只允许字母、数字、点、下划线、连字符（1-128 位）`;
		out.directoryName = "default-workspace";
	}
	out.pollSeconds = Math.min(Math.max(Math.round(num(source.pollSeconds, 30)), POLL_MIN_S), POLL_MAX_S);
	out.trashKeep = Math.min(Math.max(Math.round(num(source.trashKeep, 5)), TRASH_KEEP_MIN), TRASH_KEEP_MAX);
	out.allowedHosts = Array.isArray(source.allowedHosts)
		? source.allowedHosts.map((entry) => str(entry)).filter((entry) => entry !== "")
		: [];

	return { settings: out, configError };
}

/* ------------------------------------------------------------------ */
/* 目录解析                                                             */
/* ------------------------------------------------------------------ */

/**
 * 探测系统文档目录，分支与 DSH 内核一致：Windows 走 GetFolderPath、
 * macOS 走 osascript、Linux 走 xdg-user-dir。探测失败返回 undefined。
 * @param {string} configured - 配置覆盖值（绝对路径），非空时直接返回。
 * @returns {Promise<string|undefined>}
 */
async function documentsDirectoryOf(configured) {
	if (configured !== "") return configured;
	const platform = process.platform;
	const run = (file, args) =>
		execFileAsync(file, args, { timeout: LOOKUP_TIMEOUT_MS, maxBuffer: 1 << 20 });
	let stdout;
	try {
		switch (platform) {
			case "win32":
				({ stdout } = await run("powershell.exe", [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments, [Environment+SpecialFolderOption]::DoNotVerify)"
				]));
				break;
			case "darwin":
				({ stdout } = await run("osascript", [
					"-e",
					"POSIX path of (path to documents folder from user domain without folder creation)"
				]));
				break;
			case "linux":
				({ stdout } = await run("xdg-user-dir", ["DOCUMENTS"]));
				break;
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
	const directory = typeof stdout === "string" ? stdout.replace(/[\r\n]+$/, "").trim() : "";
	if (directory === "") return undefined;
	if (platform === "win32" && !/^[A-Za-z]:[\\\/]/.test(directory)) return undefined;
	if (platform !== "win32" && !directory.startsWith("/")) return undefined;
	return normalize(directory);
}

/** 兜底根：文档目录探测失败时使用。 */
function fallbackWorkspaceRoot() {
	return join(homedir(), ".dsh", "workspaces");
}

/**
 * 解析工作区父目录，区分三种来源。
 *   - config：显式 parentDirectory
 *   - documents：系统文档目录（配置覆盖或探测得到）
 *   - fallback：探测失败后回落到 ~/.dsh/workspaces
 * @param {object} settings - 已归一化的配置。
 * @returns {Promise<{directory: string, parent: string, parentSource: "config"|"documents"|"fallback", documentsError: string|null}>}
 */
async function resolveParent(settings) {
	const dirName = settings.directoryName || "default-workspace";
	if (settings.parentDirectory !== "") {
		const parent = settings.parentDirectory;
		return { directory: resolve(parent, dirName), parent, parentSource: "config", documentsError: null };
	}
	if (settings.documentsDirectory !== "") {
		const parent = resolve(settings.documentsDirectory, DEFAULT_BASE);
		return { directory: resolve(parent, dirName), parent, parentSource: "documents", documentsError: null };
	}
	const documents = await documentsDirectoryOf("").catch(() => undefined);
	if (documents !== undefined) {
		const parent = resolve(documents, DEFAULT_BASE);
		return { directory: resolve(parent, dirName), parent, parentSource: "documents", documentsError: null };
	}
	const parent = resolve(fallbackWorkspaceRoot(), DEFAULT_BASE);
	return {
		directory: resolve(parent, dirName),
		parent,
		parentSource: "fallback",
		documentsError: "无法探测系统文档目录，已回落到 ~/.dsh/workspaces"
	};
}

/* ------------------------------------------------------------------ */
/* 状态存储                                                             */
/* ------------------------------------------------------------------ */

/**
 * 稀疏覆盖层：只存用户显式改过的字段，缺省字段回落到部署配置。
 * 状态文件在 $DSH_HOME/state/<bundle-name>/settings.json，与其他插件同级。
 * 读-改-写在同一个 promise 链上串行执行，两个并发改动不会互相覆盖。
 */
class FileStore {
	/** @param {{dir: string, file: string}} location */
	constructor(location) {
		this.location = location;
		this.pending = Promise.resolve();
		this.latest = null;
	}
	get file() {
		return join(this.location.dir, this.location.file);
	}
	/** 读当前覆盖层；任何异常都回落为空对象，绝不抛。 */
	read() {
		const run = this.pending.then(async () => {
			if (this.latest !== null) return this.latest;
			const value = await this.readRaw();
			this.latest = value;
			return value;
		});
		this.pending = run.then(() => undefined, () => undefined);
		return run;
	}
	/** 绕开缓存直接读盘。 */
	async readRaw() {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8"));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	/** 串行写入一次覆盖层。 */
	mutate(mutator) {
		const run = this.pending.then(async () => {
			const current = this.latest ?? (await this.readRaw());
			const next = mutator(current) ?? current;
			await mkdir(this.location.dir, { recursive: true });
			await writeFile(this.file, JSON.stringify(next, null, 2) + "\n", "utf8");
			this.latest = next;
			return next;
		});
		this.pending = run.then(() => undefined, () => undefined);
		return run;
	}
}

/* ------------------------------------------------------------------ */
/* 惰性服务读取                                                          */
/* ------------------------------------------------------------------ */

const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 250;

/**
 * 读一个可选宿主服务，带次数上限的退避重试。
 * 只重试「读取」本身：返回值由调用方只用一次，重试一个会改动的调用
 * （例如注册工具）反而会把同一个工具注册两遍。
 * @param {object} ctx - 宿主根 context。
 * @param {string} service - 服务名。
 * @returns {Promise<unknown|null>}
 */
async function resolveService(ctx, service) {
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
		try {
			const value = ctx.get?.(service) ?? ctx[service] ?? null;
			if (value !== null && value !== undefined) return value;
		} catch {
			/* 服务可能还没挂载 */
		}
		if (attempt < RETRY_ATTEMPTS - 1) await wait(RETRY_DELAY_MS * (attempt + 1));
	}
	return null;
}

/* ------------------------------------------------------------------ */
/* AGENTS.md 种子                                                       */
/* ------------------------------------------------------------------ */

/** 派生展示标题：中文优先，回落到目录名本身。 */
function displayTitle(settings) {
	if (settings.title !== "") return settings.title;
	return settings.directoryName === "default-workspace" ? "默认工作区" : settings.directoryName;
}

/** 内置用途说明（description 为空时）。 */
const BUILTIN_DESCRIPTION =
	"放杂七杂八的小事情：一次性的小脚本、临时调研、随手笔记、不想归类到任何项目的草稿。";

/**
 * 生成 AGENTS.md 正文。
 * @param {object} settings - 已归一化的配置。
 * @returns {string} UTF-8 正文。
 */
function seedText(settings) {
	if (settings.instructions !== "") {
		return `${settings.instructions.replace(/\s+$/, "")}\n`;
	}
	const title = displayTitle(settings);
	const description = settings.description !== "" ? settings.description.trim() : BUILTIN_DESCRIPTION;
	return [
		`# ${title}`,
		"",
		"这是「默认工作区」。",
		"",
		description,
		"",
		"## ⚠️ 顶层目录不要直接放文件",
		"",
		"**不要在顶层直接创建文件。** 不要以「就一个文件」「只是临时的」为理由破例。",
		"",
		"要放东西，先按类型进子目录：",
		"",
		"| 内容 | 放哪 |",
		"| --- | --- |",
		"| 临时文件、草稿、跑完就删的验证脚本 | `_scratch/` |",
		"| 值得留一会儿的笔记、调研结果 | `notes/` |",
		"| 想重复用的小脚本 | `scripts/` |",
		"| 其它 | 自己起一个说得清的子目录 |",
		"",
		"具体来说，**不要**让这些东西出现在顶层：",
		"",
		"- 临时文件与中间产物：`tmp.txt`、`out.json`、`test.py`、`a.png`、`log.txt`、`debug.mjs` 之类",
		"- 下载或导出的数据、截图",
		"- 一次性的调试、验证脚本",
		"- 依赖目录与构建产物：`node_modules/`、`dist/`、`venv/`、`__pycache__/`、`build/`",
		"- 第二个说明性质的 `.md` 文件",
		"",
		"顶层正常情况下**只应该有两样东西**：本文件 `AGENTS.md`，以及用户明确要求放在顶层的成果。",
		"如果你觉得必须往顶层写一个新文件，先停下来问一句。",
		"",
		"## `_trash/` 不要动",
		"",
		"`_trash/` 是插件自己的回收站：用户「清空」或「重置」工作区时，东西先被搬到这里，",
		"所以它是**可以恢复的**。不要动它，不要整理它，也不要把它当成该清掉的垃圾。",
		"",
		"## 这个工作区不是项目",
		"",
		"- 不要在这里搭建正式项目的目录结构（src/、tests/、package.json 那套）。",
		"- 需要长期维护、要发给别人、要跟版本库走的东西，请另外开一个工作区。",
		"- 这里适合「做完就走」：一个小计算、一段调试、一份草稿、一次提问。",
		"",
		"## 命名与收尾",
		"",
		"- 文件名说人话，带上日期或主题，方便回头找。",
		"- 不要 `git init`，不要把这里当成代码仓库。",
		"- 有价值的成果值得迁走；没价值的草稿可以直接删。",
		"",
		"---",
		`本文件由 ${name} 生成。配置见 DSH 设置 → 插件 → ${title}。`,
		""
	].join("\n");
}

/**
 * 写 AGENTS.md。已存在且不覆盖时不写、返回 written:false，绝不覆盖用户自己的修改。
 * @returns {Promise<{written: boolean, path: string, size: number}>}
 */
async function writeSeed(settings, directory) {
	const path = join(directory, "AGENTS.md");
	const existing = await stat(path).catch(() => undefined);
	if (existing !== undefined && !settings.overwriteSeed) {
		return { written: false, path, size: existing.size };
	}
	await mkdir(directory, { recursive: true });
	const text = seedText(settings);
	await writeFile(path, text, "utf8");
	return { written: true, path, size: Buffer.byteLength(text, "utf8") };
}

/* ------------------------------------------------------------------ */
/* 工作区登记                                                            */
/* ------------------------------------------------------------------ */

/**
 * 只读探查：目录是否已登记为工作区。绝不创建任何东西。
 * @returns {Promise<{workspace: object|null, error: string|null}>}
 */
async function describeWorkspace(settings, registry, directory) {
	if (registry === null || typeof registry.resolveByPath !== "function") {
		return { workspace: null, error: null };
	}
	try {
		const workspace = await registry.resolveByPath(directory);
		if (workspace === null || workspace === undefined) return { workspace: null, error: null };
		return {
			workspace: {
				id: String(workspace.id ?? ""),
				title: workspace.title ?? displayTitle(settings),
				path: workspace.path ?? directory,
				sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0
			},
			error: null
		};
	} catch (error) {
		return { workspace: null, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 把目录登记为工作区并套用标题。resolveByPath 命中时复用，否则 create。
 * @returns {Promise<{workspace: object|null, error: string|null}>}
 */
async function ensureRegistered(settings, registry, directory) {
	if (registry === null || typeof registry.create !== "function") {
		return { workspace: null, error: "宿主未提供 workspaceRegistry" };
	}
	try {
		let workspace = null;
		if (typeof registry.resolveByPath === "function") {
			try {
				workspace = await registry.resolveByPath(directory);
			} catch {
				workspace = null;
			}
		}
		if (workspace === null || workspace === undefined) {
			await mkdir(directory, { recursive: true });
			workspace = await registry.create(directory);
		}
		const title = displayTitle(settings);
		if (typeof workspace.setTitle === "function" && workspace.title !== title) {
			try {
				await workspace.setTitle(title);
			} catch {
				/* 标题冲突或被占用时保留原标题 */
			}
		}
		return {
			workspace: {
				id: String(workspace.id ?? ""),
				title: workspace.title ?? title,
				path: workspace.path ?? directory,
				sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0
			},
			error: null
		};
	} catch (error) {
		return { workspace: null, error: error instanceof Error ? error.message : String(error) };
	}
}

/* ------------------------------------------------------------------ */
/* 清理与重置                                                            */
/* ------------------------------------------------------------------ */

/**
 * 回收站目录名。位于工作区**内部**，插件独占。
 *
 * 清空/重置都不直接删任何东西，一律先 rename 进 _trash/<时间戳>/。
 * 这样「清空」是可撤销的：用户反悔了就去 _trash 里捞回来。
 */
const TRASH_DIR = "_trash";
/**
 * 回收站批次目录名的格式：本地时间 YYYYMMDD-HHmmss-SSS。
 *
 * 这个正则是**自动清理唯一的边界**：只有严格匹配它的目录才可能被 pruneTrash 删掉。
 * 用户自己往 _trash 里放的东西（哪怕叫 trash、backup 或 2026）永远不会被碰。
 */
const TRASH_STAMP_RE = /^\d{8}-\d{6}-\d{3}$/;
/**
 * 只有 clear 保留的顶层名字。
 *
 * 注意 `_trash` **不在这里**：它是插件自己的回收站，两个动作都绝不能碰它。
 * （曾经把 _trash 也交给 reset 去搬，结果它试图把 _trash 搬进 _trash/<批次>/_trash，
 * 自己搬自己，Windows 直接 EPERM。测试逮住了这个。）
 */
const KEEP_ON_CLEAR = new Set(["AGENTS.md"]);
/** 递归统计体积时最多走多少个条目：防止一个塞满文件的目录把面板拖住。 */
const SURVEY_MAX_ENTRIES = 2_000;
/** 递归统计体积的最大深度，再深就停止。 */
const SURVEY_MAX_DEPTH = 8;
/** 顶层条目数上限。超过就拒绝清理，绝不「只搬一部分然后假装清干净了」。 */
const SURVEY_MAX_TOP = 5_000;
/** state 快照里最多带回多少个顶层条目名（面板只展示前几个）。 */
const SURVEY_LIST_MAX = 50;

/** 取错误消息，非 Error 也能用。 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 分配一个没被占用的回收站批次名。
 * 同一毫秒内连做两次清理时顺延 1ms，直到名字空出来——顺延后仍然匹配
 * TRASH_STAMP_RE，所以它照样落在自动清理的管辖范围内。
 * @param {string} trashRoot - 回收站根目录（可能还不存在）。
 * @param {number} base - 起始时间戳（毫秒）。
 * @returns {Promise<string>} 形如 20261008-231500-123。
 */
async function trashStamp(trashRoot, base = Date.now()) {
	const pad = (value, width) => String(value).padStart(width, "0");
	for (let bump = 0; bump < 1_000; bump += 1) {
		const date = new Date(base + bump);
		const stamp =
			`${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}` +
			`-${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}` +
			`-${pad(date.getMilliseconds(), 3)}`;
		if (!TRASH_STAMP_RE.test(stamp)) continue;
		if (await stat(join(trashRoot, stamp)).catch(() => undefined) === undefined) return stamp;
	}
	throw new Error("无法分配回收站批次名");
}

/**
 * 统计一棵子树的体积。
 *
 * 用 lstat 而不是 stat：**不跟随符号链接与 Windows 联接点**，否则一个指向
 * C:\ 或网络盘的链接就能让这里走进无底洞。深度与条目数都有硬上限。
 * @param {string} root - 子树根。
 * @returns {Promise<{bytes: number, entries: number, truncated: boolean}>}
 */
async function measureTree(root) {
	// 根自己就是符号链接/联接点时，一个字节都不统计。
	//
	// 这是实测发现的：walk() 只对**子**条目查 isSymbolicLink，readdir 却会跟随作为根
	// 传进来的链接，于是统计会走进目标目录 —— 那个目标可能是 C:\ 或网络盘。
	// 生产路径（listTop）本来就会先判 kind === "dir" 才调用，这里再兜一层。
	const own = await lstat(root).catch(() => undefined);
	if (own === undefined || own.isSymbolicLink()) return { bytes: 0, entries: 0, truncated: false };
	let bytes = 0;
	let entries = 0;
	let truncated = false;
	const walk = async (dir, depth) => {
		if (truncated) return;
		if (depth > SURVEY_MAX_DEPTH) {
			truncated = true;
			return;
		}
		const children = await readdir(dir, { withFileTypes: true }).catch(() => null);
		if (children === null) return;
		for (const child of children) {
			if (entries >= SURVEY_MAX_ENTRIES) {
				truncated = true;
				return;
			}
			entries += 1;
			const path = join(dir, child.name);
			const info = await lstat(path).catch(() => undefined);
			if (info === undefined || info.isSymbolicLink()) continue;
			if (info.isDirectory()) {
				await walk(path, depth + 1);
				continue;
			}
			if (info.isFile()) bytes += info.size;
		}
	};
	await walk(root, 0);
	return { bytes, entries, truncated };
}

/**
 * 列出工作区顶层的条目（**不含 `_trash` 自身**）。只读，绝不创建任何东西。
 *
 * 顶层列表的上限是 SURVEY_MAX_TOP（5000）：真的撞到就置 truncated，
 * 由 moveToTrash 拒绝执行——把「搬了一部分就报成功」这种事挡在门外。
 * @param {string} directory - 工作区目录。
 * @returns {Promise<{exists: boolean, count: number, bytes: number, entries: object[], truncated: boolean}>}
 */
async function listTop(directory) {
	const exists = await stat(directory).catch(() => undefined) !== undefined;
	if (!exists) return { exists: false, count: 0, bytes: 0, entries: [], truncated: false };
	const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const entries = [];
	let bytes = 0;
	let truncated = children.length > SURVEY_MAX_TOP;
	for (const child of children) {
		if (entries.length >= SURVEY_MAX_TOP) break;
		// 回收站是插件自己的东西，clear 和 reset 都不动它：
		// 既不该被清掉（那就没法找回了），也不能被 reset 搬进它自己里面去。
		if (child.name === TRASH_DIR) continue;
		const path = join(directory, child.name);
		const info = await lstat(path).catch(() => undefined);
		const kind = info === undefined
			? "unknown"
			: info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file";
		let size = info === undefined ? 0 : info.size;
		// 链接（含 Windows 联接点）本身的元数据大小不是「用户要搬走的内容」，
		// 报 0 更贴近面板上「会搬走多大」的含义。
		if (kind === "link") size = 0;
		if (kind === "dir") {
			const measured = await measureTree(path);
			size = measured.bytes;
			if (measured.truncated) truncated = true;
		}
		bytes += size;
		entries.push({ name: child.name, kind, size });
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return { exists: true, count: entries.length, bytes, entries, truncated };
}

/**
 * 从顶层清单里挑出某个动作真正会搬走的条目。
 *
 * 两个动作的关系是死的：`reset` 就是 `clear` 再加上 `AGENTS.md`。
 * 所以调用方只需要扫一次盘（listTop），两个视图都从同一份清单派生 ——
 * 既省一半 I/O，也从根上避免了「面板显示的」和「实际会搬的」两份清单对不上。
 * @param {object} survey - listTop 的结果。
 * @param {"clear"|"reset"} action
 * @returns {object} 同构的清单。
 */
function selectForAction(survey, action) {
	if (action !== "clear" || survey.exists !== true) return survey;
	const entries = survey.entries.filter((entry) => !KEEP_ON_CLEAR.has(entry.name));
	let bytes = 0;
	for (const entry of entries) bytes += entry.size;
	return {
		exists: survey.exists,
		count: entries.length,
		bytes,
		entries,
		truncated: survey.truncated
	};
}

/**
 * 列出一次清空/重置会搬走的顶层条目。
 * @param {string} directory - 工作区目录。
 * @param {"clear"|"reset"} action - clear 额外保留 KEEP_ON_CLEAR，reset 全都搬走。
 * @returns {Promise<object>}
 */
async function listClearable(directory, action) {
	return selectForAction(await listTop(directory), action);
}

/**
 * 把工作区顶层要清理的条目搬进 _trash/<时间戳>/。
 *
 * 关键在于用 **rename 而不是递归删除**：一个系统调用搬走一个顶层条目，
 * 完全不进入子目录。所以既快，也不可能顺着符号链接删到工作区外面去。
 * 单个条目搬不动（被占用、权限不足）时继续搬其余的，最后如实汇报失败项。
 * @returns {Promise<{stamp: string|null, trashPath: string|null, moved: object[], bytes: number, empty: boolean}>}
 */
async function moveToTrash(directory, action) {
	const survey = await listClearable(directory, action);
	if (!survey.exists) return { stamp: null, trashPath: null, moved: [], bytes: 0, empty: true };
	if (survey.truncated) {
		throw new Error(`顶层条目数超过 ${SURVEY_MAX_TOP} 个，为避免只清掉一部分，请先手动整理`);
	}
	if (survey.count === 0) return { stamp: null, trashPath: null, moved: [], bytes: 0, empty: true };
	const trashRoot = join(directory, TRASH_DIR);
	await mkdir(trashRoot, { recursive: true });
	const stamp = await trashStamp(trashRoot);
	const trashPath = join(trashRoot, stamp);
	await mkdir(trashPath, { recursive: true });
	const moved = [];
	let bytes = 0;
	for (const entry of survey.entries) {
		try {
			await rename(join(directory, entry.name), join(trashPath, entry.name));
			moved.push({ name: entry.name, kind: entry.kind, size: entry.size });
			bytes += entry.size;
		} catch (error) {
			moved.push({ name: entry.name, kind: entry.kind, size: entry.size, error: messageOf(error) });
		}
	}
	return { stamp, trashPath, moved, bytes, empty: false };
}

/**
 * 回收站保留策略：超出 keep 的最旧批次被**真正删除**。
 *
 * 只认 TRASH_STAMP_RE 命中的目录名，也就是只删插件自己创建的批次；
 * 名字既然受这个正则约束，就不含路径分隔符，join 出来的路径不可能逃出 _trash。
 * @param {string} directory - 工作区目录。
 * @param {number} keep - 保留份数；<= 0 表示不自动清理。
 * @returns {Promise<{kept: number, removed: string[]}>}
 */
async function pruneTrash(directory, keep) {
	if (!(typeof keep === "number" && Number.isFinite(keep) && keep > 0)) return { kept: 0, removed: [] };
	const trashRoot = join(directory, TRASH_DIR);
	const children = await readdir(trashRoot, { withFileTypes: true }).catch(() => []);
	const stamps = children
		.filter((child) => child.isDirectory() && TRASH_STAMP_RE.test(child.name))
		.map((child) => child.name)
		.sort();
	const doomed = stamps.slice(0, Math.max(0, stamps.length - keep));
	const removed = [];
	for (const stamp of doomed) {
		try {
			await rm(join(trashRoot, stamp), { recursive: true, force: true, maxRetries: 2 });
			removed.push(stamp);
		} catch {
			/* 被占用就留着，下次清理再说 */
		}
	}
	return { kept: stamps.length - removed.length, removed };
}

/** 回收站里的批次名，最新在前；只认插件自己的命名。 */
async function trashBatches(directory) {
	const children = await readdir(join(directory, TRASH_DIR), { withFileTypes: true }).catch(() => []);
	return children
		.filter((child) => child.isDirectory() && TRASH_STAMP_RE.test(child.name))
		.map((child) => child.name)
		.sort()
		.reverse();
}

/**
 * 危险操作的确认词 = 工作区目录名。
 * 逼用户逐字打出自己要清的是哪一个目录，而不是闭着眼点一下「确认」。
 * directoryName 受 DIR_NAME_RE 约束，一定是纯 ASCII，好打。
 */
function confirmToken(settings) {
	return settings.directoryName || "default-workspace";
}

/**
 * 执行一次清空或重置。
 *   - clear：搬走顶层内容，保留 AGENTS.md 与 _trash；
 *   - reset：连 AGENTS.md 一起搬走，然后按当前设置重新生成，并确认登记还在。
 * @param {object} wiring - 装配的依赖集合。
 * @param {"clear"|"reset"} action
 * @returns {Promise<object>}
 */
async function runCleanup(wiring, action) {
	const parent = await resolveParent(wiring.settings);
	const directory = parent.directory;
	const move = await moveToTrash(directory, action);
	const pruned = move.empty ? { kept: 0, removed: [] } : await pruneTrash(directory, wiring.settings.trashKeep);
	// 逐条搬走，个别条目可能失败（被占用、权限）。失败的条目留在 moved 里并带 error，
	// 所以 movedCount 只数真正搬成功的 —— 否则面板会说「已清空 3 项」同时列出一条失败，
	// 两个数字自相矛盾。bytes 同理，只在 rename 成功后才累加。
	const failed = move.moved.filter((entry) => entry.error !== undefined).map((entry) => entry.name);
	const result = {
		action,
		directory,
		empty: move.empty === true,
		movedCount: move.moved.length - failed.length,
		attempted: move.moved.length,
		moved: move.moved,
		failed,
		bytes: move.bytes,
		trashPath: move.trashPath,
		pruned: pruned.removed,
		seed: null,
		workspace: null,
		workspaceError: null
	};
	if (action === "reset") {
		// 目录本身还在（只是被腾空），登记通常依然有效；ensureRegistered 幂等，顺手确认一遍。
		const { workspace, error } = await ensureRegistered(
			wiring.settings,
			await wiring.resolveRegistry(),
			directory
		);
		result.workspace = workspace;
		result.workspaceError = error;
		if (wiring.settings.seedAgentsMd) {
			// AGENTS.md 刚被搬走，这里必然重新落盘，不受 overwriteSeed 影响。
			result.seed = await writeSeed(wiring.settings, directory);
		}
	}
	return result;
}

/* ------------------------------------------------------------------ */
/* 信任围栏                                                             */
/* ------------------------------------------------------------------ */

/** 默认允许的回环主机名。 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * 去掉端口与 IPv6 方括号，得到可比对的主机名。
 * 裸 IPv6（两个及以上冒号）不当作「host:port」，否则会误把 ::1 的尾段当端口剥掉。
 * @param {unknown} host - Host 头原值。
 * @returns {string} 小写、去端口的主机名；空输入返回空串。
 */
function bareHost(host) {
	const text = String(host ?? "").split(",")[0]?.trim() ?? "";
	if (text === "") return "";
	const lower = text.toLowerCase();
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
	if (bracketed) return bracketed[1];
	if (/^[0-9a-f:]+$/.test(lower) && (lower.match(/:/g) ?? []).length >= 2) return lower;
	return lower.replace(/:\d+$/, "");
}

/**
 * 判断面板请求是否来自可信任来源。只校验 Host 头：面板运行在宿主自己的回环
 * webserver 上，跨源请求到不了这里，Host 是这条链上唯一可信的入口。
 * @param {object} request - Node IncomingMessage。
 * @param {string[]} allowedHosts - 配置里的额外主机名。
 * @returns {boolean}
 */
function isAdmitted(request, allowedHosts) {
	const host = bareHost(request?.headers?.host);
	if (host === "") return false;
	return LOOPBACK_HOSTS.some((entry) => host === entry.toLowerCase()) ||
		(allowedHosts ?? []).some((entry) => host === entry.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* HTTP 路由                                                            */
/* ------------------------------------------------------------------ */

/** 状态响应路径。 */
const STATE_PATH = `/api/${name}/state`;
/** 设置写入路径。 */
const SETTINGS_PATH = `/api/${name}/settings`;
/** 确保工作区路径。 */
const ENSURE_PATH = `/api/${name}/ensure`;
/** 清空工作区路径（只搬内容，保留 AGENTS.md）。 */
const CLEAR_PATH = `/api/${name}/clear`;
/** 重置工作区路径（内容与 AGENTS.md 一起搬走，随后重新播种）。 */
const RESET_PATH = `/api/${name}/reset`;
/** 缓存策略：面板总是想看到最新值。 */
const NO_CACHE = { "cache-control": "no-store" };
/** 请求体上限：面板提交的字段很少，超大 body 是恶意或错误的信号。 */
const MAX_BODY_BYTES = 8_192;

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		...NO_CACHE
	});
	res.end(JSON.stringify(body));
}

/** 403：来源不匹配。措辞只有一个版本。 */
function refuseOrigin(response) {
	writeJson(response, 403, { ok: false, error: "禁止：来源不匹配" });
}

/** 405：方法不允许。 */
function refuseMethod(response) {
	writeJson(response, 405, { ok: false, error: "方法不允许" });
}

/** 读一个小 JSON body；越界或非对象返回 ok:false。 */
async function readJsonBody(request, limit = MAX_BODY_BYTES) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			received += buffer.byteLength;
			if (received > limit) return { ok: false, error: "请求体过大" };
			chunks.push(buffer);
		}
	} catch {
		return { ok: false, error: "无法读取请求体" };
	}
	if (chunks.length === 0) return { ok: false, error: "需要一个 JSON 请求体" };
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? { ok: true, value: parsed }
			: { ok: false, error: "请求体必须是 JSON 对象" };
	} catch {
		return { ok: false, error: "请求体不是合法 JSON" };
	}
}

/**
 * 清空或重置。两条路由共用同一套校验顺序：
 *   来源 → 方法 → JSON body → 插件是否启用 → dryRun → 确认词。
 *
 * dryRun:true 只做只读预演，返回「会搬走什么」，一个字节都不动。
 * 真正执行要求 body.confirm 与工作区目录名逐字相同——面板上是个输入框，
 * 不是「确定/取消」弹窗，闭着眼按回车过不去。
 * @param {object} wiring - 装配的依赖集合。
 * @param {"clear"|"reset"} action
 * @returns {Function} Node 请求处理器。
 */
function cleanupHandler(wiring, action) {
	return async (request, response) => {
		if (!isAdmitted(request, wiring.settings.allowedHosts)) return refuseOrigin(response);
		if (request.method !== undefined && request.method !== "POST") return refuseMethod(response);
		const body = await readJsonBody(request);
		if (!body.ok) return writeJson(response, 400, { ok: false, error: body.error });
		try {
			if (wiring.settings.enabled !== true) {
				return writeJson(response, 400, { ok: false, error: "插件已禁用，拒绝清空或重置" });
			}
			const parent = await resolveParent(wiring.settings);
			const expected = confirmToken(wiring.settings);
			if (body.value.dryRun === true) {
				const survey = await listClearable(parent.directory, action);
				return writeJson(response, 200, {
					ok: true,
					dryRun: true,
					action,
					directory: parent.directory,
					confirmToken: expected,
					exists: survey.exists,
					count: survey.count,
					bytes: survey.bytes,
					entries: survey.entries.slice(0, SURVEY_LIST_MAX),
					truncated: survey.truncated || survey.count > SURVEY_LIST_MAX
				});
			}
			const typed = typeof body.value.confirm === "string" ? body.value.confirm.trim() : "";
			if (typed !== expected) {
				return writeJson(response, 400, {
					ok: false,
					error: `确认文字不匹配，请输入 '${expected}'`
				});
			}
			const result = await runCleanup(wiring, action);
			// 清空/重置改变了磁盘，轮询兜底之外再主动刷新一次，让状态与设置层同步。
			void refreshFromSettings(wiring);
			writeJson(response, 200, { ok: true, ...result });
		} catch (error) {
			writeJson(response, 200, { ok: false, error: messageOf(error) });
		}
	};
}

/**
 * 组装只读状态快照。面板与智能体工具都读它，保证两边口径一致。
 * 只探查、不创建：需要创建走 ensure。
 * @param {object} wiring - apply() 装配的依赖集合。
 * @returns {Promise<object>}
 */
async function buildState(wiring) {
	const parent = await resolveParent(wiring.settings);
	const directory = parent.directory;
	const directoryExists = await stat(directory).catch(() => undefined) !== undefined;
	const registry = await wiring.resolveRegistry();
	const { workspace, error: workspaceError } = await describeWorkspace(wiring.settings, registry, directory);
	const seedPath = join(directory, "AGENTS.md");
	const seed = await stat(seedPath).catch(() => undefined);
	// 清理预览：面板要显示「会搬走几项、多大」，以及回收站里已有几批。
	// 扫一次盘，clear / reset 两个视图都从同一份清单派生 —— 见 selectForAction。
	const top = await listTop(directory);
	const batches = await trashBatches(directory);
	const trim = (survey) => ({
		count: survey.count,
		bytes: survey.bytes,
		exists: survey.exists,
		entries: survey.entries.slice(0, SURVEY_LIST_MAX),
		truncated: survey.truncated || survey.count > SURVEY_LIST_MAX
	});
	return {
		ok: true,
		now: Date.now(),
		plugin: { name, version: VERSION },
		enabled: wiring.settings.enabled,
		effective: { ...wiring.settings },
		defaults: { ...DEFAULTS },
		configError: wiring.configError,
		defaultDirectory: directory,
		parentDirectory: parent.parent,
		parentSource: parent.parentSource,
		documentsError: parent.documentsError,
		directoryExists,
		workspace,
		workspaceError,
		seedExists: seed !== undefined,
		seedPath,
		seedSize: seed === undefined ? null : seed.size,
		toolRegistered: wiring.toolRegistered === true,
		cleanup: {
			confirmToken: confirmToken(wiring.settings),
			trashDir: join(directory, TRASH_DIR),
			trashKeep: wiring.settings.trashKeep,
			trashCount: batches.length,
			trashBatches: batches.slice(0, 20),
			clear: trim(selectForAction(top, "clear")),
			reset: trim(selectForAction(top, "reset"))
		}
	};
}

/**
 * 挂三条路由：读状态、改设置、确保工作区。每条都以 isAdmitted 开头。
 * @param {object} ctx - 宿主根 context。
 * @param {object} wiring - 装配的依赖集合。
 * @returns {Function|null} 反注册回调；宿主没有 webServer 时返回 null。
 */
function registerRoutes(ctx, wiring) {
	// ctx 是受限代理：webServer 已声明在 inject 里，正常情况下直接可读。
	// 但兜底一层 try——万一某个精简宿主（例如 headless profile）没提供它，
	// 访问会抛 `cannot get property "webServer" without inject`，
	// 这里必须接住，否则 apply() 整体失败。
	let webServer = null;
	try {
		webServer = ctx.webServer ?? ctx.get?.("webServer") ?? null;
	} catch {
		webServer = null;
	}
	if (webServer === null || typeof webServer.register !== "function") return null;

	const register = (path, handler) => {
		try {
			return webServer.register({ kind: "exact", path, handler });
		} catch (error) {
			wiring.logger?.warn?.(`${name}: 路由注册失败 ${path}: ${error instanceof Error ? error.message : String(error)}`);
			return null;
		}
	};

	const onState = register(STATE_PATH, async (request, response) => {
		if (!isAdmitted(request, wiring.settings.allowedHosts)) return refuseOrigin(response);
		const method = request.method === undefined ? "GET" : request.method;
		if (method !== "GET" && method !== "HEAD") return refuseMethod(response);
		try {
			writeJson(response, 200, await buildState(wiring));
		} catch (error) {
			writeJson(response, 200, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	});

	const onSettings = register(SETTINGS_PATH, async (request, response) => {
		if (!isAdmitted(request, wiring.settings.allowedHosts)) return refuseOrigin(response);
		if (request.method !== undefined && request.method !== "POST") return refuseMethod(response);
		const body = await readJsonBody(request);
		if (!body.ok) return writeJson(response, 400, { ok: false, error: body.error });
		const { field, value } = body.value;
		if (typeof field !== "string" || field === "") {
			return writeJson(response, 400, { ok: false, error: "缺少 field" });
		}
		if (!(field in DEFAULTS)) {
			return writeJson(response, 400, { ok: false, error: `未知字段 '${field}'` });
		}
		try {
			const next = await wiring.store.mutate((current) => {
				const copy = { ...current };
				if (value === null) delete copy[field];
				else copy[field] = value;
				return copy;
			});
			const { settings, configError } = resolveSettings({ ...wiring.patchConfig, ...next });
			wiring.settings = settings;
			wiring.configError = configError;
			wiring.lastChange = Date.now();
			void refreshFromSettings(wiring);
			writeJson(response, 200, {
				ok: true,
				effective: { ...settings },
				defaults: { ...DEFAULTS },
				configError
			});
		} catch (error) {
			writeJson(response, 500, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	});

	const onEnsure = register(ENSURE_PATH, async (request, response) => {
		if (!isAdmitted(request, wiring.settings.allowedHosts)) return refuseOrigin(response);
		if (request.method !== undefined && request.method !== "POST") return refuseMethod(response);
		try {
			const parent = await resolveParent(wiring.settings);
			await mkdir(parent.directory, { recursive: true });
			const { workspace, error } = await ensureRegistered(
				wiring.settings,
				await wiring.resolveRegistry(),
				parent.directory
			);
			let seed = null;
			if (wiring.settings.seedAgentsMd) {
				seed = await writeSeed(wiring.settings, parent.directory);
			}
			writeJson(response, 200, {
				ok: error === null,
				error,
				directory: parent.directory,
				parentSource: parent.parentSource,
				workspace,
				seed
			});
		} catch (error) {
			writeJson(response, 200, {
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	});

	const onClear = register(CLEAR_PATH, cleanupHandler(wiring, "clear"));
	const onReset = register(RESET_PATH, cleanupHandler(wiring, "reset"));

	return () => {
		for (const off of [onState, onSettings, onEnsure, onClear, onReset]) {
			if (typeof off === "function") try { off(); } catch { /* 宿主可能已拆除 */ }
		}
	};
}

/* ------------------------------------------------------------------ */
/* 智能体工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 注册 default_workspace 工具。拿不到 tools 服务就不注册，绝不抛错。
 * @param {object} wiring - 装配的依赖集合。
 * @returns {Promise<Function|null>} 反注册回调，或 null。
 */
async function registerTool(wiring) {
	const tools = await resolveService(wiring.ctx, "tools");
	if (tools === null || typeof tools.register !== "function") return null;
	try {
		return tools.register({
			name: "default_workspace",
			description:
				"查看或创建「默认工作区」——放杂七杂八的小事、不必区分项目时使用。\n\n" +
				"action:\n" +
				"- status（默认）：目录、是否已存在、是否已登记为工作区、标题与会话数、AGENTS.md 是否已写入。只读，无副作用。\n" +
				"- ensure：创建目录、登记为工作区、写入 AGENTS.md（幂等；已存在则复用）。\n" +
				"- path：只返回目录路径。\n" +
				"- describe：返回这个工作区的用途说明（面板里配置的文字）。\n\n" +
				"要改用别的目录，请让用户去 DSH 设置 → 插件 → 默认工作区 改 parentDirectory，不要在工具里改。\n" +
				"清空工作区与重置工作区也在这个面板里，且只有用户能操作：这两个动作会搬空整个工作区，" +
				"出于安全考虑刻意不提供工具入口。用户要清理时，请告诉他去面板的「清理与重置」区块，" +
				"并说明删除是可恢复的（文件会先搬进工作区里的 _trash/）。",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["status", "ensure", "path", "describe"],
						description: "要执行的动作。省略时用 status。"
					}
				},
				additionalProperties: false
			},
			output: {
				schema: { type: "object" },
				render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }]
			},
			presentCall: (args) => ({
				card: "generic",
				kind: "act",
				title: `默认工作区：${args?.action ?? "status"}`
			}),
			timeoutMs: 15_000,
			async execute(args) {
				const action = args?.action === "ensure" || args?.action === "path" || args?.action === "describe"
					? args.action
					: "status";
				if (action === "path") {
					const parent = await resolveParent(wiring.settings);
					return {
						directory: parent.directory,
						parentDirectory: parent.parent,
						parentSource: parent.parentSource
					};
				}
				if (action === "describe") {
					return {
						title: displayTitle(wiring.settings),
						description: wiring.settings.description !== ""
							? wiring.settings.description
							: BUILTIN_DESCRIPTION,
						instructions: wiring.settings.instructions
					};
				}
				if (action === "status") {
					const state = await buildState(wiring);
					return {
						title: displayTitle(wiring.settings),
						directory: state.defaultDirectory,
						parentDirectory: state.parentDirectory,
						parentSource: state.parentSource,
						directoryExists: state.directoryExists,
						registered: state.workspace !== null,
						workspace: state.workspace,
						workspaceError: state.workspaceError,
						seedExists: state.seedExists,
						seedPath: state.seedPath,
						enabled: state.enabled,
						configError: state.configError
					};
				}
				// ensure
				const parent = await resolveParent(wiring.settings);
				await mkdir(parent.directory, { recursive: true });
				const { workspace, error } = await ensureRegistered(
					wiring.settings,
					await wiring.resolveRegistry(),
					parent.directory
				);
				let seed = null;
				if (wiring.settings.seedAgentsMd) {
					seed = await writeSeed(wiring.settings, parent.directory);
				}
				return {
					ok: error === null,
					error,
					title: displayTitle(wiring.settings),
					directory: parent.directory,
					parentSource: parent.parentSource,
					workspace,
					seed
				};
			}
		});
	} catch (error) {
		wiring.logger?.warn?.(`${name}: 工具注册失败：${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 装配                                                                  */
/* ------------------------------------------------------------------ */

/** 状态目录：$DSH_HOME/state/<bundle-name>，与其他插件同级。 */
function stateDirectory() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
		? process.env.DSH_HOME.trim()
		: join(homedir(), ".dsh");
	return join(home, "state", name);
}

/**
 * 按「当前覆盖层 → 部署配置 → 默认值」重算生效配置，
 * 并在 autoCreate 开启时确保目录、登记与 AGENTS.md 都在位。
 * 幂等；轮询与面板写入都走它。
 * @param {object} wiring - 装配的依赖集合。
 * @returns {Promise<object|null>} 本轮的生效配置，未执行时 null。
 */
async function refreshFromSettings(wiring) {
	if (wiring.disposed) return null;
	if (wiring.refreshing) return null;
	wiring.refreshing = true;
	try {
		const layer = await wiring.store.read();
		const { settings, configError } = resolveSettings({ ...wiring.patchConfig, ...layer });
		wiring.settings = settings;
		wiring.configError = configError;
		if (!settings.enabled || !settings.autoCreate) return settings;
		const parent = await resolveParent(settings);
		if (!(await stat(parent.directory).catch(() => undefined))) {
			await mkdir(parent.directory, { recursive: true });
		}
		const { workspace, error } = await ensureRegistered(settings, await wiring.resolveRegistry(), parent.directory);
		if (error !== null) {
			wiring.logger?.warn?.(`${name}: 登记失败 ${error}`);
		} else if (workspace === null) {
			wiring.logger?.warn?.(`${name}: 宿主没有 workspaceRegistry，目录已创建但未登记`);
		}
		if (settings.seedAgentsMd) {
			const seed = await writeSeed(settings, parent.directory);
			wiring.lastSeed = seed;
		}
		return settings;
	} catch (error) {
		wiring.logger?.warn?.(`${name}: 刷新失败`, error instanceof Error ? error.message : String(error));
		return null;
	} finally {
		wiring.refreshing = false;
	}
}

/**
 * 挂载：装配依赖、注册路由、注册工具、启动轮询，并挂上卸载 effect。
 * 路由与工具是唯一的挂载缝——任何一处拿不到服务都静默降级，绝不在挂载时抛错。
 * @param {object} ctx - 宿主根 context。
 * @param {object} config - 本 entry 的补丁配置（部署默认值）。
 */
function apply(ctx, config = {}) {
	const logger = ctx.logger ?? null;
	const store = new FileStore({ dir: stateDirectory(), file: "settings.json" });
	const patchConfig = { ...DEFAULTS, ...(config && typeof config === "object" ? config : {}) };
	const wiring = {
		ctx,
		logger,
		store,
		patchConfig,
		// 初始配置先按「部署配置 + 空覆盖层」算好，refreshFromSettings 会用状态文件覆盖它。
		...(() => {
			const { settings, configError } = resolveSettings(patchConfig);
			return { settings, configError };
		})(),
		toolRegistered: false,
		disposed: false,
		refreshing: false,
		/** 惰性解析 workspaceRegistry（可能挂载后才注册）。 */
		resolveRegistry: () => resolveService(ctx, "workspaceRegistry")
	};

	const offRoutes = registerRoutes(ctx, wiring);

	registerTool(wiring).then((off) => {
		if (wiring.disposed) return;
		wiring.toolOff = off;
		wiring.toolRegistered = off !== null;
	}).catch((error) => logger?.warn?.(`${name}: 工具装配失败`, error));

	// 首轮：用状态覆盖层重算，并（若开启）创建目录、登记、播种。
	void refreshFromSettings(wiring);

	// 周期刷新：面板写入后也会立即触发一次，轮询只是兜底（例如手工改状态文件）。
	const intervalMs = Math.min(Math.max(wiring.settings.pollSeconds, POLL_MIN_S), POLL_MAX_S) * 1_000;
	const timer = setInterval(() => void refreshFromSettings(wiring), intervalMs);
	if (typeof timer.unref === "function") timer.unref();

	const stop = () => {
		wiring.disposed = true;
		clearInterval(timer);
		if (typeof offRoutes === "function") { try { offRoutes(); } catch { /* ignore */ } }
		if (typeof wiring.toolOff === "function") { try { wiring.toolOff(); } catch { /* ignore */ } }
	};
	if (typeof ctx.effect === "function") {
		ctx.effect(() => () => stop(), `${name}: mount`);
	} else {
		ctx.once?.("disposed", stop);
	}
}

export { DEFAULTS as CONFIG_DEFAULTS, VERSION, apply, hostName, inject, name, resolveSettings };
// 导出供 Node 侧测试直接驱动真实逻辑；宿主只读 apply/name/inject。
export {
	BUILTIN_DESCRIPTION,
	FileStore,
	buildState,
	cleanupHandler,
	confirmToken,
	describeWorkspace,
	displayTitle,
	ensureRegistered,
	isAdmitted,
	bareHost,
	listClearable,
	listTop,
	measureTree,
	moveToTrash,
	pruneTrash,
	readJsonBody,
	refreshFromSettings,
	runCleanup,
	seedText,
	selectForAction,
	trashBatches,
	trashStamp,
	writeSeed,
	resolveParent,
	documentsDirectoryOf,
	registerRoutes,
	registerTool
};
