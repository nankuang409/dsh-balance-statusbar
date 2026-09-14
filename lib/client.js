// dsh-balance-statusbar — browser half.
//
// 一条固定在页面底部的浅色状态栏（挂在框架级 `shell.overlay` 槽位，纯叠加、
// 不遮挡交互），分段展示：会话统计（轮数/步数 · LLM/工具时长 · 首 token ·
// 解码吞吐 · 缓存命中 · 输入/输出 token）＋ 费用（总余额 · 今日消费 ·
// 当前对话费用）· 更新时间，风格对齐会话统计条。轮询宿主聚合路由
// `/api/balance-statusbar`（见 lib/index.js），余额每 60 秒、费用与统计每
// 5 秒刷新，也可手动刷新。仅使用既有 `--dsw-*` 主题 token，跟随浅色/深色模式。
window.__ModuleLoader__.load({
	id: "dsh-balance-statusbar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// The bar is a 28px absolute strip at bottom:0 on the frame-wide
		// `shell.overlay` layer, which sits outside the columns' scroll
		// containers — so it paints over whatever the layout puts last,
		// namely ui-conversation's StatsLine. Reserve the strip's height so
		// both lines are visible instead of stacked.
		if (typeof document !== "undefined" && !document.getElementById("dsh-balance-statusbar-space")) {
			var spacer = document.createElement("style");
			spacer.id = "dsh-balance-statusbar-space";
			// Target the frame itself, not body: `.frame` is height:100% with
			// its own overflow, so body padding moves nothing. Padding the
			// frame shrinks the grid's content box while the bar — absolutely
			// positioned against the *padding* box — stays flush at bottom:0.
			spacer.textContent = ":has(> [data-shell-overlay]){padding-bottom:28px!important;box-sizing:border-box}";
			document.head.appendChild(spacer);
		}
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		// ---- constants -------------------------------------------------
		const BALANCE_POLL_MS = 60 * 1000;
		const COST_POLL_MS = 5 * 1000;
		const ROUTE = "/api/balance-statusbar";

		// ---- small helpers ---------------------------------------------
		function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}

		function formatCost(value, currency) {
			const symbol = currencySymbol(currency);
			if (!Number.isFinite(value) || value <= 0) return `${symbol}0`;
			if (value >= 100) return `${symbol}${value.toFixed(0)}`;
			if (value >= 1) return `${symbol}${value.toFixed(2)}`;
			if (value >= 0.01) return `${symbol}${value.toFixed(3)}`;
			return `${symbol}${value.toPrecision(2)}`;
		}

		// 紧凑 token 数：517 / 12.2K / 517K / 1.2M（与内置统计条同款格式）。
		function formatTokens(n) {
			const scaled = (v) => v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
			if (n < 1e3) return String(n);
			if (n < 1e6) return `${scaled(n / 1e3)}K`;
			return `${scaled(n / 1e6)}M`;
		}

		// 紧凑时长：45.2s / 2m42s（与内置统计条同款格式）。
		function formatDuration(ms) {
			const s = ms / 1e3;
			if (s < 60) return `${Math.round(s * 10) / 10}s`;
			const whole = Math.round(s);
			return `${Math.floor(whole / 60)}m${whole % 60}s`;
		}

		// tok/s：一位小数。
		function formatTokensPerSecond(tps) {
			return String(Math.round(tps * 10) / 10);
		}

		// 缓存命中率：round(cacheRead / billedInput * 100)。
		function cacheHitPercent(usage) {
			if (!usage) return null;
			const denominator = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
			return denominator === 0 ? null : Math.round(usage.cacheReadTokens / denominator * 100);
		}

		function formatTime(date) {
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			const ss = String(date.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
		}

		async function fetchStatus(sessionId) {
			const suffix = sessionId !== void 0 && sessionId !== "" ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
			const res = await fetch(`${ROUTE}${suffix}`, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok) {
				const message =
					body && typeof body.message === "string"
						? body.message
						: `请求失败（HTTP ${res.status}）`;
				const error = new Error(message);
				error.code = body && typeof body.error === "string" ? body.error : `http-${res.status}`;
				throw error;
			}
			return body;
		}

		// ---- inline styles ---------------------------------------------
		const bar = {
			position: "absolute",
			left: 0,
			right: 0,
			bottom: 0,
			zIndex: 30,
			pointerEvents: "auto",
			boxSizing: "border-box",
			display: "flex",
			alignItems: "center",
			gap: 0,
			height: 28,
			padding: "0 12px",
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-bg-overlay)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 11,
			lineHeight: "16px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			userSelect: "none",
			overflow: "hidden"
		};

		const segment = {
			display: "flex",
			alignItems: "center",
			gap: 4,
			minWidth: 0
		};

		// fixed 而非 absolute：状态栏高 28px，absolute 往上弹会被裁掉。
		// left/bottom 由 hover 时实测的 boundingRect 填入。
		const popover = {
			position: "fixed",
			zIndex: 2147483000,
			padding: "6px 10px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-bg-overlay)",
			color: "var(--dsw-alias-label-primary)",
			boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
			fontSize: 11,
			lineHeight: "18px",
			whiteSpace: "pre",
			pointerEvents: "none"
		};

		const divider = {
			flex: "none",
			width: 1,
			height: 14,
			margin: "0 8px",
			background: "var(--dsw-alias-border-l1)"
		};

		const label = {
			color: "var(--dsw-alias-label-tertiary)"
		};

		const value = {
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600
		};

		const updated = {
			marginLeft: "auto",
			paddingLeft: 12,
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 10
		};

		const errorText = {
			color: "var(--dsw-alias-state-error-primary)",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		// ---- the widget -------------------------------------------------
		function BalanceStatusBar(props) {
			const useSessions = props.useSessions;
			// 自绘浮层而不是原生 title：状态栏挂在 shell.overlay 叠加槽位，原生
			// tooltip 在这里不出现。用 fixed + 实测坐标而不是 absolute：状态栏
			// 只有 28px 高，absolute 往上弹会被叠加槽位裁掉。
			const [convAnchor, setConvAnchor] = useState(null);
			const convRef = useRef(null);
			const [data, setData] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [message, setMessage] = useState("");
			const [updatedAt, setUpdatedAt] = useState(null);
			const mounted = useRef(true);

			const currentSessionId = typeof useSessions === "function" ? useSessions((s) => s.current) : void 0;

			const load = useCallback(async () => {
				try {
					const body = await fetchStatus(currentSessionId);
					if (!mounted.current) return;
					setData(body);
					setPhase("ready");
					setMessage("");
					setUpdatedAt(new Date());
				} catch (error) {
					if (!mounted.current) return;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
				}
			}, [currentSessionId]);

			// balance: 60s; conversation cost: 5s (same route, cheap local call).
			useEffect(() => {
				mounted.current = true;
				load();
				const balanceTimer = setInterval(load, BALANCE_POLL_MS);
				const costTimer = setInterval(load, COST_POLL_MS);
				return () => {
					mounted.current = false;
					clearInterval(balanceTimer);
					clearInterval(costTimer);
				};
			}, [load]);

			const payload = data && data.ok ? data.balance : null;
			const balance = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos[0] : null;
			const currency = balance ? balance.currency : "CNY";
			const todayConsumed = data && data.ok ? data.todayConsumed : null;
			const todayLabel = data && data.ok && data.todayConsumedSource === "official" ? "今日已消费" : "今日约消费";
			const sessionCost = data && data.ok ? data.sessionCost : null;
			const convCost = sessionCost && typeof sessionCost.cost === "number" ? sessionCost.cost : null;
			// 费用是含子 agent 的总额，token 只显示本会话——否则跟上方 StatsLine 的
			// token 数对不上。子 agent 的 token 在 hover 明细里逐条给出。
			const convTokens = sessionCost
				? (typeof sessionCost.ownTokens === "number"
					? sessionCost.ownTokens
					: sessionCost.inputTokens + sessionCost.cacheReadTokens + sessionCost.outputTokens)
				: 0;
			// 状态栏只放得下一个总数（已含子 agent），明细挂 hover。
			const convChildren = sessionCost && Array.isArray(sessionCost.children) ? sessionCost.children : [];
			const convLines = (() => {
				if (sessionCost === null) return [];
				const lines = [];
				if (convChildren.length > 0 && typeof sessionCost.ownCost === "number") {
					lines.push(`本会话　${formatCost(sessionCost.ownCost, currency)} · ${(sessionCost.ownTokens ?? 0).toLocaleString()} tok`);
					for (const child of convChildren) {
						lines.push(`　↳ ${child.label}　${formatCost(child.cost, currency)} · ${child.calls} 次 · ${child.tokens.toLocaleString()} tok`);
					}
					lines.push(`合计　　${formatCost(convCost, currency)}（含 ${convChildren.length} 个子 agent）`);
				}
				// breakdown 是 [{label, tokens, rate, subtotal}]，不是字符串——直接
				// 塞进模板会渲染成 [object Object]。
				if (Array.isArray(sessionCost.breakdown)) {
					for (const part of sessionCost.breakdown) {
						if (part === null || typeof part !== "object") continue;
						lines.push(`${part.label}　${(part.tokens ?? 0).toLocaleString()} tok × ${part.rate} = ${formatCost(part.subtotal ?? 0, currency)}`);
					}
				}
				return lines;
			})();
			const stats = data && data.ok ? data.sessionStats : null;
			const usage = data && data.ok ? data.tokenUsage : null;

			// 统计段（与内置 StatsLine 同数据源、同格式）。
			const statGroups = [];
			if (stats && stats.steps > 0) {
				const counts = `${stats.turns} 轮 · ${stats.steps} 步`;
				const durations = [];
				if (stats.llmMs > 0) durations.push(`LLM ${formatDuration(stats.llmMs)}`);
				if (stats.toolMs > 0) durations.push(`工具调用 ${formatDuration(stats.toolMs)}`);
				const speeds = [];
				if (stats.ttftSteps > 0) speeds.push(`首 token 平均 ${formatDuration(stats.ttftMs / stats.ttftSteps)}`);
				if (stats.decodeMs > 0 && stats.decodeTokens > 0) speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3))} tok/s`);
				statGroups.push(counts);
				if (durations.length > 0) statGroups.push(durations.join(" · "));
				if (speeds.length > 0) statGroups.push(speeds.join(" · "));
			}
			if (usage && (usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0 || usage.outputTokens > 0)) {
				const cacheHit = cacheHitPercent(usage);
				const parts = [];
				if (cacheHit !== null) parts.push(`缓存命中 ${cacheHit}%`);
				parts.push(`输入 ${formatTokens(usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} · 输出 ${formatTokens(usage.outputTokens)}`);
				statGroups.push(parts.join(" · "));
			}
			const statsLine = statGroups.length > 0 ? statGroups.join(" | ") : null;

			if (phase === "error") {
				return jsx("div", {
					role: "status",
					"aria-live": "polite",
					"data-plugin": "dsh-balance-statusbar",
					style: bar,
					children: jsx("span", { style: errorText, title: message, children: `余额状态栏：${message}` })
				});
			}

			return jsx("div", {
				role: "status",
				"aria-live": "polite",
				"data-plugin": "dsh-balance-statusbar",
				title: "会话统计 + DeepSeek API 余额与消费（点击手动刷新）",
				style: bar,
				onClick: () => { load(); },
				children: jsxs(Fragment, {
					children: [
						statsLine
							? jsxs(Fragment, {
								children: [
									jsx("span", {
										style: {
											...value,
											overflow: "hidden",
											textOverflow: "ellipsis"
										},
										children: statsLine
									}),
									jsx("span", { style: divider })
								]
							})
							: null,
						jsxs("div", {
							style: segment,
							children: [
								jsx("span", { style: label, children: "余额" }),
								jsx("span", { style: value, children: balance ? formatCost(Number(balance.total_balance), currency) : "—" })
							]
						}),
						jsx("span", { style: divider }),
						jsxs("div", {
							style: segment,
							children: [
								jsx("span", { style: label, children: todayLabel }),
								jsx("span", { style: value, children: todayConsumed !== null ? formatCost(todayConsumed, currency) : "—" })
							]
						}),
						jsx("span", { style: divider }),
						jsxs("div", {
							style: segment,
							ref: convRef,
							onMouseEnter: () => {
								const rect = convRef.current?.getBoundingClientRect();
								if (rect) setConvAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
							},
							onMouseLeave: () => setConvAnchor(null),
							children: [
								jsx("span", { style: label, children: "当前对话费用" }),
								jsx("span", {
									style: value,
									children: convCost !== null ? `${formatCost(convCost, currency)}${convTokens > 0 ? ` · ${String(convTokens).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} tok` : ""}` : "—"
								})
							]
						}),
						convAnchor !== null && convLines.length > 0
							? jsx("div", {
								style: { ...popover, left: convAnchor.left, bottom: convAnchor.bottom },
								children: convLines.map((line, index) => jsx("div", {
									style: { whiteSpace: "pre", opacity: line.startsWith("　↳") ? 0.85 : 1 },
									children: line
								}, index))
							})
							: null,
						updatedAt
							? jsx("span", { style: updated, children: `更新于 ${formatTime(updatedAt)}` })
							: null
					]
				})
			});
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "balance-statusbar",
				order: 90,
				label: "余额状态栏"
			}, BalanceStatusBar));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
