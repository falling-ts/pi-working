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
 * 设计约束(重要): 本扩展**只**使用 ctx.ui.setWorkingMessage() 这一个通道, 即只改
 * "工作指示器"那一行。**绝不**使用 ctx.ui.setStatus()/footer:
 *   - pi 内核自身不往 footer 写任何文字, 该通道专供扩展;
 *   - 一旦写入, 就会在屏幕最下方多出一行, 与工作指示器内容重复。
 *
 * 已知上游限制(见 README): pi 的「压缩/重试/分支摘要」指示器文案硬编码在
 * CompactionStatusIndicator / RetryStatusIndicator / BranchSummaryStatusIndicator 中,
 * 没有公开 API 可改, 本扩展无法把它们中文化, pi 显示英文原样。
 * 其中「重试」「分支摘要」连事件都没有暴露给扩展, 完全无法监听。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 可归类的运行阶段。`working` 是兜底, 其余是细分出来的三阶段。 */
export type Phase = "working" | "request" | "respond" | "execute";

export type Lang = "zh" | "en";

/** 各阶段中英文案。 */
export const MESSAGES: Record<Lang, Record<Phase, string>> = {
	zh: {
		working: "工作中…",
		request: "请求中…",
		respond: "响应中…",
		execute: "执行中…",
	},
	en: {
		working: "Working…",
		request: "Requesting…",
		respond: "Responding…",
		execute: "Executing…",
	},
};

/** 判定 assistant 流式事件是否代表"已收到首个可见 token"。 */
export function isFirstToken(eventType: string): boolean {
	return eventType === "text_delta" || eventType === "thinking_delta" || eventType === "toolcall_start";
}

export function resolveLang(env: NodeJS.ProcessEnv): Lang {
	return (env.PI_WORKING_LANG ?? "").toLowerCase() === "en" ? "en" : "zh";
}

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
		(ctx ?? lastCtx)?.ui.setWorkingMessage(table[p]);
	};

	const enter = (p: Phase, ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		phase = p;
		awaitingFirstToken = p === "request";
		apply(p, ctx);
	};

	const clear = (ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		phase = undefined;
		awaitingFirstToken = false;
		(ctx ?? lastCtx)?.ui.setWorkingMessage(undefined);
	};

	// ---- 基线: 让 pi 原生的 "Working" 一开始就是中文 ----
	// 不在 session_start 立刻上屏(此时并未运行), 只设定基线文案, 等进入运行阶段时由 enter() 显示。
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		ctx.ui.setWorkingMessage(table.working);
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

	// ---- 压缩: 不做任何事 ----
	// pi 会自行显示 CompactionStatusIndicator(英文, 硬编码, 无 API 可改)。本扩展刻意不介入:
	// 用 footer 补中文只会让屏幕最下方多出一行, 且替换不掉 pi 自己那一行。
	// 压缩结束后由后续事件(下一次请求 / agent_settled)自然接管状态。

	pi.on("agent_settled", async (_event, ctx) => {
		clear(ctx);
	});

	pi.on("session_shutdown", async () => {
		clear();
	});

	// ---- 便于验证与排错 ----
	pi.registerCommand("working", {
		description: "显示 pi-working 当前状态 / 试写指定状态(working|request|respond|execute|clear)",
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
				ctx.ui.notify("用法: /working [working|request|respond|execute|clear]", "error");
				return;
			}
			enter(wanted as Phase, ctx);
			ctx.ui.notify(`pi-working: 预览 ${table[wanted as Phase]}`, "info");
		},
	});
}
