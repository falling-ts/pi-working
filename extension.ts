/**
 * pi-working — 把 pi 运行时的状态指示器翻译为中文(可切英文), 并细分三个阶段
 *
 * 状态机(与 pi 的实际运行阶段一一对应):
 *
 *   agent_start / 默认        ──► 工作中(Working)     —— 运行中但尚未归入具体阶段
 *   before_provider_request   ──► 请求中(Requesting)  —— 已发出模型请求, 尚未收到首个 token
 *   message_update(首个 token) ──► 响应中(Responding)  —— 已收到首个 token, 正在流式生成
 *   tool_execution_start      ──► 执行中(Executing)   —— 正在执行工具/命令等非模型工作
 *   (下一个)before_provider_request ──► 请求中          —— 工具结果回填后再次请求模型
 *   agent_settled / shutdown  ──► 清除指示器
 *
 * 语言由环境变量 PI_WORKING_LANG 控制: zh(默认) / en。
 *
 * 已知上游限制(见 README): pi 的「压缩/重试/分支摘要」指示器文案硬编码在
 * CompactionStatusIndicator / RetryStatusIndicator / BranchSummaryStatusIndicator 中,
 * 没有公开 API 可改。其中压缩可被扩展感知(session_before_compact), 此时用 footer 给出中文;
 * 「重试」「分支摘要」连事件都没有暴露给扩展, 完全无法监听。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 可归类的运行阶段。`working` 是兜底, 其余是细分出来的三阶段 + 压缩。 */
export type Phase = "working" | "request" | "respond" | "execute" | "compact";

export type Lang = "zh" | "en";

/** 每个阶段的中英文案。`label` 用于工作指示器, `status` 仅压缩阶段用于 footer。 */
export const MESSAGES: Record<Lang, Record<Phase, { label: string; status: string }>> = {
	zh: {
		working: { label: "工作中…", status: "工作中" },
		request: { label: "请求中…", status: "请求中" },
		respond: { label: "响应中…", status: "响应中" },
		execute: { label: "执行中…", status: "执行中" },
		compact: { label: "压缩上下文中…", status: "压缩中" },
	},
	en: {
		working: { label: "Working…", status: "Working" },
		request: { label: "Requesting…", status: "Requesting" },
		respond: { label: "Responding…", status: "Responding" },
		execute: { label: "Executing…", status: "Executing" },
		compact: { label: "Compacting context…", status: "Compacting" },
	},
};

/** 压缩原因 → 更细的状态文案(仅 footer status 用)。 */
const COMPACT_REASON: Record<Lang, Record<"manual" | "threshold" | "overflow", string>> = {
	zh: { manual: "手动压缩中", threshold: "自动压缩中", overflow: "上下文溢出压缩中" },
	en: { manual: "Compacting (manual)", threshold: "Compacting (auto)", overflow: "Compacting (overflow)" },
};

/** 判定 assistant 流式事件是否代表"已收到首个可见 token"。 */
export function isFirstToken(eventType: string): boolean {
	return eventType === "text_delta" || eventType === "thinking_delta" || eventType === "toolcall_start";
}

export function resolveLang(env: NodeJS.ProcessEnv): Lang {
	return (env.PI_WORKING_LANG ?? "").toLowerCase() === "en" ? "en" : "zh";
}

const STATUS_KEY = "pi-working";

export default function piWorking(pi: ExtensionAPI): void {
	const lang = resolveLang(process.env);
	const table = MESSAGES[lang];

	/** 当前阶段; undefined 表示没有进行中的运行。 */
	let phase: Phase | undefined;
	/** 是否需要等待首个 token(用于 request → respond 只切一次)。 */
	let awaitingFirstToken = false;
	/** 最近一次拿到的 ctx(部分事件不带 ctx, 用它刷新)。 */
	let lastCtx: ExtensionContext | undefined;

	const apply = (p: Phase, ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		const c = ctx ?? lastCtx;
		if (!c) return;
		c.ui.setWorkingMessage(table[p].label);
	};

	const enter = (p: Phase, ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		phase = p;
		awaitingFirstToken = p === "request";
		apply(p, ctx);
		// 常规阶段**不**写 footer: 工作指示器已显示同样文案, 再写 footer 会让屏幕最下方
		// 多出一行重复文本。footer 只在压缩阶段作为兼底(见 setCompactStatus)。
		(ctx ?? lastCtx)?.ui.setStatus(STATUS_KEY, undefined);
	};

	const setCompactStatus = (reason: "manual" | "threshold" | "overflow", ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		phase = "compact";
		// 压缩时 pi 自己的 CompactionStatusIndicator 是硬编码英文且 kind 不为 "working",
		// setWorkingMessage 也影响不到它; footer 是唯一能显示中文的地方, 故此处保留。
		(ctx ?? lastCtx)?.ui.setStatus(STATUS_KEY, COMPACT_REASON[lang][reason]);
	};

	const clear = (ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		phase = undefined;
		awaitingFirstToken = false;
		const c = ctx ?? lastCtx;
		c?.ui.setWorkingMessage(undefined);
		c?.ui.setStatus(STATUS_KEY, undefined);
	};

	// ---- 基线: 让 pi 原生的 "Working" 一开始就是中文 ----
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// 不在 session_start 立刻显示(此时并未运行), 只记住 ctx 并设定基线文案,
		// 等真正进入运行阶段时由 enter() 上屏。
		ctx.ui.setWorkingMessage(table.working.label);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("agent_start", async (_event, ctx) => {
		enter("working", ctx);
	});

	// ---- 请求中: 模型请求已发出, 等待首个 token ----
	pi.on("before_provider_request", async (_event, ctx) => {
		enter("request", ctx);
	});

	// ---- 响应中: 收到首个 token ----
	pi.on("message_update", async (event) => {
		if (phase !== "request" || !awaitingFirstToken) return;
		const t = (event.assistantMessageEvent as { type?: string } | undefined)?.type ?? "";
		if (isFirstToken(t)) {
			awaitingFirstToken = false;
			enter("respond");
		}
	});

	// ---- 执行中: 工具/命令等非模型工作 ----
	pi.on("tool_execution_start", async (_event, ctx) => {
		enter("execute", ctx);
	});

	// 用户 shell 转义(!cmd)同样是非模型工作。
	pi.on("user_bash", async (_event, ctx) => {
		enter("execute", ctx);
	});

	// 工具结束后不切换: 紧接着的 before_provider_request 会把状态置为「请求中」。

	// ---- 压缩: 用事件 session_before_compact / session_compact(_failed) ----
	pi.on("session_before_compact", async (event, ctx) => {
		setCompactStatus(event.reason, ctx);
	});
	pi.on("session_compact", async (_event, ctx) => {
		// 压缩成功; 若随后会重试本轮, 下一次 before_provider_request 会接管为「请求中」。
		if (phase === "compact") {
			phase = "working";
			(ctx ?? lastCtx)?.ui.setStatus(STATUS_KEY, undefined);
		}
	});
	pi.on("session_compact_failed", async (_event, ctx) => {
		if (phase === "compact") {
			phase = "working";
			(ctx ?? lastCtx)?.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		clear(ctx);
	});

	pi.on("session_shutdown", async () => {
		clear();
	});

	// ---- 便于验证与排错 ----
	pi.registerCommand("working", {
		description: "显示 pi-working 当前状态 / 试写指定状态(working|request|respond|execute|compact|clear)",
		handler: async (args, ctx) => {
			const wanted = args.trim().toLowerCase();
			if (!wanted) {
				ctx.ui.notify(`pi-working: 语言=${lang}, 当前阶段=${phase ?? "(空闲)"}`, "info");
				return;
			}
			if (wanted === "clear") {
				clear(ctx);
				ctx.ui.notify("pi-working: 已清除", "info");
				return;
			}
			if (!(wanted in table)) {
				ctx.ui.notify("用法: /working [working|request|respond|execute|compact|clear]", "error");
				return;
			}
			if (wanted === "compact") {
				setCompactStatus("manual", ctx);
			} else {
				enter(wanted as Phase, ctx);
			}
			ctx.ui.notify(`pi-working: 预览 ${table[wanted as Phase].label}`, "info");
		},
	});
}
