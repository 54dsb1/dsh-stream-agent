window.__ModuleLoader__.load({
	id: "@hugesb/dsh-stream-agent-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const { useCallback, useEffect, useMemo, useState } = React;

		/**
		 * Browser half of the desktop control page.
		 *
		 * The page is a dsh web-client plugin: it registers one main panel and one
		 * sidebar rail icon through ctx.slots, then talks to its own Host half over
		 * the same-origin route /stream-agent/control. No Electron API, no preload
		 * bridge, no duplicated state: channel/tier/lang still live in control.json
		 * and the loop's in-memory control object is the one writer.
		 *
		 * 0.5.0 two blocks (计划书 §3.3)：
		 *   区块 A「执行通道」standard/code——用户选择的是模型看到什么；"依赖 PTC"是
		 *   探测结果不是选项（页面不出现"PTC 模式"字样，来源行如实显示探测结果）。
		 *   区块 B「上下文档位」light/standard/deep——只改数值，每档展示实际数值
		 *   （maxSteps/maxInputTokens/压缩强度），不做定性宣传。
		 *   两个区块都可回退：A→standard 即 0.4.0 balanced 行为面；B→standard 即 0.4.0 数值面。
		 */

		const ROUTE = "/stream-agent/control";
		const NS = "stream-agent-ui";

		const TEXT = {
			zh: {
				title: "控制栏",
				subtitle: "执行通道与上下文档位。改完立即对新会话生效，已有会话在下一个任务边界生效；通道切换会重建上下文缓存（换基一次）。",
				refresh: "刷新",
				refreshing: "刷新中…",
				loading: "正在读取控制状态…",
				loadFailed: "读不到控制状态",
				retry: "重试",
				hostUnreachable: "宿主没有响应控制路由。确认插件已装入当前 profile，并重启客户端。",
				active: "接管生效",
				inactive: "未接管",
				inactiveHint: "loop 没有注册 agent factory。通道/档位仍可写入状态文件，但修复装载并重启后才会生效。",
				statusTitle: "当前状态",
				channelTitle: "① 执行通道",
				channelHint: "选模型看到什么：标准 = tf-* 命令；代码 = 单一 run_code 入口。",
				tierTitle: "② 上下文档位",
				tierHint: "只改数值：步数上限、单请求上下文上限、压缩强度。不改工具面与执行器。",
				tierValuesTitle: "实际数值",
				advancedTitle: "高级",
				advancedHint: "取回预算 / 前缀策略 / 重复抑制（peekBudgetChars / prefixPolicy / spanLedger）",
				sourceTitle: "代码通道来源",
				sourcePreset: "preset 完整兼容",
				sourceBridge: "内置窄桥（受限）",
				sourceNone: "不可用：未检测到 PTC 预设或 ptcRuntime",
				sourceStandard: "不适用（标准通道）",
				runtimeTitle: "运行状态",
				taskN: "本任务 N",
				rebases: "换基",
				redundant: "重复取回",
				summaries: "摘要",
				segments: "段",
				executor: "执行器",
				surface: "工具面",
				langTitle: "控制栏语言",
				langHint: "只影响控制栏文案与页面，不改模型输出语言。",
				cacheHit: "缓存命中",
				version: "版本",
				channel: "通道",
				tier: "档位",
				source: "来源",
				language: "语言",
				stateFile: "状态文件",
				updatedAt: "更新时间",
				never: "尚未写入",
				locked: "已锁定",
				lockedConfig: "装配配置写死了这个值，界面不能改；改 profile patch 后重启。",
				lockedEnv: "环境变量写死了这个值，界面不能改；改环境变量后重启。",
				sourceConfig: "装配配置",
				sourceEnv: "环境变量",
				sourceFile: "状态文件",
				sourceDefault: "默认值",
				sourceRuntime: "本次运行（未落盘）",
				selected: "当前",
				apply: "切换",
				applying: "应用中…",
				useWhen: "什么时候选",
				tradeoff: "代价",
				legacy: "0.4.0 行为对照",
				saved: "已保存。通道对新会话立即生效，会话内在下一个任务边界生效。",
				noticeConflict: "状态已被其他窗口或 CLI 修改，已刷新为最新值。",
				writeFailed: "写入失败",
				params: {
					maxSteps: "步数上限",
					maxInputTokens: "上下文上限",
					compactAggressiveness: "压缩强度",
					peekBudgetChars: "取回预算",
					keepRecent: "保留条数",
					maxSummaryChars: "摘要上限",
					surfacePolicy: "工具面策略",
				},
				cli: "命令行等价操作",
				cliHint: "dsh-stream-agent channel <standard|code> · tier <light|standard|deep> · lang <zh|en> · bar",
				docs: "说明文档：README.md#桌面客户端控制页",
			},
			en: {
				title: "Control bar",
				subtitle: "Execution channel and context tier. Changes apply to new sessions immediately; running sessions pick them up at the next task boundary; channel switches rebuild the prompt cache once (planned rebase).",
				refresh: "Refresh",
				refreshing: "Refreshing…",
				loading: "Reading control state…",
				loadFailed: "Cannot read control state",
				retry: "Retry",
				hostUnreachable: "The Host did not answer the control route. Confirm the plugin is installed in this profile, then restart the client.",
				active: "Takeover active",
				inactive: "Not taking over",
				inactiveHint: "The loop did not register an agent factory. Channel/tier changes still write the state file, but they only apply after the load failure is fixed and the client restarts.",
				statusTitle: "Current state",
				channelTitle: "(1) Execution channel",
				channelHint: "Pick what the model sees: Standard = tf-* commands; Code = single run_code entry.",
				tierTitle: "(2) Context tier",
				tierHint: "Numbers only: step cap, per-request context cap, compaction strength. Never touches tool surface or executor.",
				tierValuesTitle: "Actual values",
				advancedTitle: "Advanced",
				advancedHint: "peek budget / prefix policy / dup suppression (peekBudgetChars / prefixPolicy / spanLedger)",
				sourceTitle: "Code channel source",
				sourcePreset: "preset: full compatibility",
				sourceBridge: "built-in narrow bridge (limited)",
				sourceNone: "unavailable: no PTC preset or ptcRuntime detected",
				sourceStandard: "n/a (standard channel)",
				runtimeTitle: "Runtime status",
				taskN: "task N",
				rebases: "rebases",
				redundant: "redundant peeks",
				summaries: "summaries",
				segments: "blocks",
				executor: "executor",
				surface: "surface",
				langTitle: "Control bar language",
				langHint: "Only the control bar and this page; it does not change the model's output language.",
				cacheHit: "Cache hit",
				version: "Version",
				channel: "Channel",
				tier: "Tier",
				source: "Source",
				language: "Language",
				stateFile: "State file",
				updatedAt: "Updated",
				never: "not written yet",
				locked: "Locked",
				lockedConfig: "The composition config pins this value; edit the profile patch and restart.",
				lockedEnv: "An environment variable pins this value; change it and restart.",
				sourceConfig: "composition config",
				sourceEnv: "environment",
				sourceFile: "state file",
				sourceDefault: "default",
				sourceRuntime: "this run (not persisted)",
				selected: "Current",
				apply: "Switch",
				applying: "Applying…",
				useWhen: "When to choose",
				tradeoff: "Trade-off",
				legacy: "0.4.0 behavior",
				saved: "Saved. Applies to new sessions immediately; running sessions switch at the next task boundary.",
				noticeConflict: "Another window or the CLI changed the state; refreshed to the latest value.",
				writeFailed: "Write failed",
				params: {
					maxSteps: "Step cap",
					maxInputTokens: "Context cap",
					compactAggressiveness: "Compaction",
					peekBudgetChars: "Peek budget",
					keepRecent: "Keep recent",
					maxSummaryChars: "Summary cap",
					surfacePolicy: "Surface policy",
				},
				cli: "CLI equivalents",
				cliHint: "dsh-stream-agent channel <standard|code> · tier <light|standard|deep> · lang <zh|en> · bar",
				docs: "Docs: README.en.md#desktop-control-page",
			},
		};

		function copyFor(lang) {
			return TEXT[lang === "en" ? "en" : "zh"];
		}

		function sourceLabel(t, source) {
			switch (source) {
				case "config": return t.sourceConfig;
				case "env": return t.sourceEnv;
				case "file": return t.sourceFile;
				case "runtime": return t.sourceRuntime;
				default: return t.sourceDefault;
			}
		}

		function codeSourceLabel(t, codeSource) {
			if (codeSource === "preset") return t.sourcePreset;
			if (codeSource === "bridge") return t.sourceBridge;
			if (codeSource === "none") return t.sourceNone;
			return t.sourceStandard;
		}

		async function call(method, body) {
			const response = await fetch(ROUTE, {
				method,
				credentials: "same-origin",
				headers: body === undefined ? {} : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok) {
				const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
				error.status = response.status;
				error.payload = payload;
				throw error;
			}
			return payload;
		}

		function useControl() {
			const [phase, setPhase] = useState("loading");
			const [status, setStatus] = useState(null);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [busy, setBusy] = useState(false);

			const load = useCallback(async () => {
				setPhase((current) => (current === "ready" ? current : "loading"));
				try {
					const payload = await call("GET");
					setStatus(payload.status);
					setError(null);
					setPhase("ready");
				} catch (cause) {
					setError(cause);
					setPhase("error");
				}
			}, []);

			useEffect(() => {
				load();
			}, [load]);

			const mutate = useCallback(async (patch) => {
				if (busy) return;
				setBusy(true);
				setNotice(null);
				try {
					const body = { ...patch, expectedUpdatedAt: status?.updatedAt ?? null };
					const payload = await call("POST", body);
					if (payload?.status) setStatus(payload.status);
					setPhase("ready");
					setError(null);
					setNotice({ kind: "ok", text: payload?.notice ?? copyFor(payload?.status?.lang ?? status?.lang).saved });
				} catch (cause) {
					if (cause?.status === 409 && cause?.payload?.status) {
						setStatus(cause.payload.status);
						setPhase("ready");
						setError(null);
						setNotice({ kind: "warn", text: copyFor(cause.payload.status.lang).noticeConflict });
					} else {
						setError(cause);
						setPhase((current) => (current === "ready" ? current : "error"));
						setNotice({ kind: "error", text: `${copyFor(status?.lang).writeFailed}: ${cause?.message ?? cause}` });
					}
				} finally {
					setBusy(false);
				}
			}, [busy, status]);

			return { phase, status, error, notice, busy, reload: load, mutate };
		}

		function Badge({ children, tone }) {
			return h("span", { className: `sa-badge sa-badge-${tone ?? "neutral"}` }, children);
		}

		function StatusCell({ label, children, wide }) {
			return h("div", { className: `sa-cell${wide ? " sa-cell-wide" : ""}` },
				h("div", { className: "sa-cell-label" }, label),
				h("div", { className: "sa-cell-value" }, children),
			);
		}

		function Params({ status, t }) {
			const effective = status.effective ?? {};
			const rows = [
				["maxSteps", effective.maxSteps],
				["maxInputTokens", effective.maxInputTokens],
				["compactAggressiveness", effective.compactAggressiveness],
				["peekBudgetChars", effective.peekBudgetChars],
				["keepRecent", effective.keepRecent],
				["maxSummaryChars", effective.maxSummaryChars],
				["surfacePolicy", effective.surfacePolicy],
			];
			return h("div", { className: "sa-params" },
				rows.map(([key, value]) => h("div", { className: "sa-param", key },
					h("span", { className: "sa-param-key" }, t.params[key] ?? key),
					h("span", { className: "sa-param-value" }, value === null || value === undefined ? "—" : String(value)),
				)),
			);
		}

		function ChannelCard({ channel, lang, active, locked, busy, source, onSelect }) {
			const t = copyFor(lang);
			return h("button", {
				type: "button",
				className: `sa-mode${active ? " sa-mode-active" : ""}`,
				disabled: locked || busy,
				"aria-pressed": active,
				onClick: () => onSelect(channel.id),
				title: active ? t.selected : t.apply,
			},
				h("div", { className: "sa-mode-head" },
					h("span", { className: "sa-mode-order" }, channel.order),
					h("span", { className: "sa-mode-name" }, channel.label[lang]),
					active ? h(Badge, { tone: "brand" }, t.selected) : null,
				),
				h("div", { className: "sa-mode-tagline" }, channel.tagline[lang]),
				h("div", { className: "sa-mode-row" },
					h("span", { className: "sa-mode-row-label" }, t.useWhen),
					h("span", null, channel.useWhen[lang]),
				),
				h("div", { className: "sa-mode-row sa-mode-cost" },
					h("span", { className: "sa-mode-row-label" }, t.tradeoff),
					h("span", null, channel.tradeoff[lang]),
				),
				h("div", { className: "sa-mode-row sa-mode-saving" },
					h("span", { className: "sa-mode-row-label" }, t.legacy),
					h("span", null, channel.legacyBehavior[lang]),
				),
			);
		}

		function TierButton({ tier, lang, active, locked, busy, onSelect }) {
			const t = copyFor(lang);
			const v = tier.values;
			const values = `maxSteps ${v.maxSteps} · maxInputTokens ${Math.round(v.maxInputTokens / 1000)}k · ${t.params.compactAggressiveness} ${v.compactAggressiveness}`;
			return h("button", {
				type: "button",
				className: `sa-tier${active ? " sa-tier-active" : ""}`,
				disabled: locked || busy,
				"aria-pressed": active,
				onClick: () => onSelect(tier.id),
				title: `${t.apply}: ${values}`,
			},
				h("div", { className: "sa-tier-head" },
					h("span", { className: "sa-mode-name" }, tier.label[lang]),
					active ? h(Badge, { tone: "brand" }, t.selected) : null,
				),
				h("div", { className: "sa-tier-values" }, values),
				h("div", { className: "sa-tier-when" }, tier.useWhen[lang]),
			);
		}

		function ControlPage() {
			const { phase, status, error, notice, busy, reload, mutate } = useControl();
			const lang = status?.lang === "en" ? "en" : "zh";
			const t = copyFor(lang);

			if (phase === "loading") {
				return h("div", { className: "sa-root" },
					h("div", { className: "sa-shell" },
						h("div", { className: "sa-skeleton sa-skeleton-title" }),
						h("div", { className: "sa-skeleton" }),
						h("div", { className: "sa-skeleton" }),
						h("div", { className: "sa-loading" }, t.loading),
					),
				);
			}

			if (phase === "error" || status === null) {
				return h("div", { className: "sa-root" },
					h("div", { className: "sa-shell" },
						h("div", { className: "sa-fail" },
							h("div", { className: "sa-fail-title" }, t.loadFailed),
							h("div", { className: "sa-fail-text" }, t.hostUnreachable),
							h("div", { className: "sa-fail-detail" }, String(error?.message ?? error ?? "")),
							h("button", { type: "button", className: "sa-button", onClick: reload }, t.retry),
						),
					),
				);
			}

			const channelLocked = status.channelLocked === true;
			const tierLocked = status.tierLocked === true;
			const langLocked = status.langLocked === true;
			const channelSourceLabel = sourceLabel(t, status.channelSource);
			const runtime = status.runtime ?? null;
			const codeSource = status.channel === "code" ? status.codeSource : undefined;

			return h("div", { className: "sa-root" },
				h("div", { className: "sa-shell" },
					h("header", { className: "sa-header" },
						h("div", null,
							h("div", { className: "sa-title-row" },
								h("h1", { className: "sa-title" }, t.title),
								h(Badge, { tone: "neutral" }, `v${status.version}`),
								status.takeover ? h(Badge, { tone: "ok" }, t.active) : h(Badge, { tone: "warn" }, t.inactive),
							),
							h("p", { className: "sa-subtitle" }, t.subtitle),
						),
						h("button", { type: "button", className: "sa-button", onClick: reload, disabled: busy },
							busy ? t.refreshing : t.refresh,
						),
					),

					status.takeover ? null : h("div", { className: "sa-banner sa-banner-warn" }, t.inactiveHint),
					notice ? h("div", { className: `sa-banner sa-banner-${notice.kind}` }, notice.text) : null,

					h("section", { className: "sa-section" },
						h("h2", { className: "sa-section-title" }, t.statusTitle),
						h("div", { className: "sa-grid" },
							h(StatusCell, { label: t.channel },
								`${status.channel}`,
								channelLocked ? h(Badge, { tone: "warn" }, t.locked) : null,
							),
							h(StatusCell, { label: t.tier }, `${status.tier}`),
							h(StatusCell, { label: t.source }, channelSourceLabel),
							h(StatusCell, { label: t.language }, status.lang),
							h(StatusCell, { label: t.stateFile, wide: true },
								h("code", { className: "sa-code", title: status.stateFile }, status.stateFile),
							),
							h(StatusCell, { label: t.updatedAt }, status.updatedAt ? new Date(status.updatedAt).toLocaleString() : t.never),
							// v0.4.2：运行时缓存命中率（当前会话有缓存数据才显示；离线/mock 隐藏该行）。
							status.cache && status.cache.cacheHitRatio !== null && status.cache.cacheHitRatio !== undefined
								? h(StatusCell, { label: t.cacheHit },
									h("span", { title: `${t.cacheHit}: cacheRead=${status.cache.cacheReadTokens} / billedInput=${status.cache.billedInput}` },
										`${Math.round(status.cache.cacheHitRatio * 100)}%`),
								)
								: null,
						),
						channelLocked ? h("div", { className: "sa-hint" }, status.channelSource === "env" ? t.lockedEnv : t.lockedConfig) : null,
					),

					// 区块 A：执行通道（§3.3——不出现"PTC 模式"字样；来源是探测结果行）
					h("section", { className: "sa-section" },
						h("div", { className: "sa-section-head" },
							h("h2", { className: "sa-section-title" }, t.channelTitle),
							h("span", { className: "sa-section-hint" }, t.channelHint),
						),
						h("div", { className: "sa-modes" },
							(status.channels ?? []).map((channel) => h(ChannelCard, {
								key: channel.id,
								channel,
								lang,
								active: channel.id === status.channel,
								locked: channelLocked,
								busy,
								source: codeSource,
								onSelect: (id) => mutate({ channel: id }),
							})),
						),
						h("div", { className: "sa-mode-row", style: { marginTop: "10px" } },
							h("span", { className: "sa-mode-row-label" }, t.sourceTitle),
							h("span", null, codeSourceLabel(t, codeSource)),
						),
					),

					// 区块 B：上下文档位（§3.3——只改数值，每档显示实际数值）
					h("section", { className: "sa-section" },
						h("div", { className: "sa-section-head" },
							h("h2", { className: "sa-section-title" }, t.tierTitle),
							h("span", { className: "sa-section-hint" }, t.tierHint),
						),
						h("div", { className: "sa-tiers" },
							(status.tiers ?? []).map((tier) => h(TierButton, {
								key: tier.id,
								tier,
								lang,
								active: tier.id === status.tier,
								locked: tierLocked,
								busy,
								onSelect: (id) => mutate({ tier: id }),
							})),
						),
						h("div", { className: "sa-mode-row", style: { marginTop: "10px" } },
							h("span", { className: "sa-mode-row-label" }, t.advancedTitle),
							h("span", null, t.advancedHint),
						),
					),

					// 运行状态（§3.3 底部状态行：本任务 N · 换基 · 重复取回 · 摘要）
					runtime ? h("section", { className: "sa-section" },
						h("h2", { className: "sa-section-title" }, t.runtimeTitle),
						h("div", { className: "sa-params" },
							h("div", { className: "sa-param" },
								h("span", { className: "sa-param-key" }, t.taskN),
								h("span", { className: "sa-param-value" }, String(runtime.requests ?? 0)),
							),
							h("div", { className: "sa-param" },
								h("span", { className: "sa-param-key" }, t.rebases),
								h("span", { className: "sa-param-value" }, String(runtime.rebases ?? 0)),
							),
							h("div", { className: "sa-param" },
								h("span", { className: "sa-param-key" }, t.redundant),
								h("span", { className: "sa-param-value" }, `${runtime.redundantPeeks?.hits ?? 0}/${runtime.redundantPeeks?.total ?? 0}`),
							),
							h("div", { className: "sa-param" },
								h("span", { className: "sa-param-key" }, t.summaries),
								h("span", { className: "sa-param-value" }, `${runtime.summaries ?? 0} ${t.segments}`),
							),
							h("div", { className: "sa-param" },
								h("span", { className: "sa-param-key" }, t.executor),
								h("span", { className: "sa-param-value" }, runtime.executor ?? "native"),
							),
							h("div", { className: "sa-param" },
								h("span", { className: "sa-param-key" }, t.surface),
								h("span", { className: "sa-param-value" }, runtime.surface ?? "—"),
							),
						),
					) : null,

					h("section", { className: "sa-section" },
						h("h2", { className: "sa-section-title" }, t.paramsTitle),
						h(Params, { status, t }),
					),

					h("section", { className: "sa-section" },
						h("div", { className: "sa-section-head" },
							h("h2", { className: "sa-section-title" }, t.langTitle),
							h("span", { className: "sa-section-hint" }, t.langHint),
						),
						h("div", { className: "sa-segment", role: "group", "aria-label": t.langTitle },
							h("button", {
								type: "button",
								className: `sa-segment-button${lang === "zh" ? " sa-segment-active" : ""}`,
								"aria-pressed": lang === "zh",
								disabled: langLocked || busy,
								onClick: () => mutate({ lang: "zh" }),
							}, "中文"),
							h("button", {
								type: "button",
								className: `sa-segment-button${lang === "en" ? " sa-segment-active" : ""}`,
								"aria-pressed": lang === "en",
								disabled: langLocked || busy,
								onClick: () => mutate({ lang: "en" }),
							}, "English"),
						),
						langLocked ? h("div", { className: "sa-hint" }, status.langSource === "env" ? t.lockedEnv : t.lockedConfig) : null,
					),

					h("footer", { className: "sa-footer" },
						h("div", { className: "sa-footer-title" }, t.cli),
						h("code", { className: "sa-code" }, t.cliHint),
						h("div", { className: "sa-footer-docs" }, t.docs),
					),
				),
			);
		}

		function RailIcon({ size }) {
			const edge = typeof size === "number" ? size : 20;
			return h("svg", {
				width: edge,
				height: edge,
				viewBox: "0 0 20 20",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				"aria-hidden": "true",
			},
				h("path", { d: "M3 6h14M3 10h14M3 14h14" }),
				h("circle", { cx: 7, cy: 6, r: 2.1, fill: "var(--dsw-alias-bg-layer-1, #fff)" }),
				h("circle", { cx: 13, cy: 10, r: 2.1, fill: "var(--dsw-alias-bg-layer-1, #fff)" }),
				h("circle", { cx: 8, cy: 14, r: 2.1, fill: "var(--dsw-alias-bg-layer-1, #fff)" }),
			);
		}

		function railLabel(ctx) {
			try {
				// 可选服务只走 ctx.get：裸读 ctx.locale 会撞 Cordis 的 inject 守卫
				// （v0.2.0 装载事故的同一类错误），这里不能再犯。
				const locale = ctx.get?.("locale")?.getSnapshot?.().locale;
				if (String(locale ?? "").toLowerCase().startsWith("zh")) return "控制栏";
			} catch {
				// 语言服务不可用：退回英文标签，不影响页面本身
			}
			return "Control bar";
		}

		const CSS = `
.sa-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:var(--dsw-font-s-14,14px);line-height:1.55;}
.sa-root *{box-sizing:border-box;}
.sa-shell{max-width:980px;margin:0 auto;padding:32px 28px 48px;}
.sa-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px;}
.sa-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.sa-title{margin:0;font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-.01em;}
.sa-subtitle{margin:8px 0 0;max-width:680px;color:var(--dsw-alias-label-secondary,#5f6368);font-size:13px;}
.sa-badge{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;border:1px solid transparent;}
.sa-badge-neutral{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6368);border-color:var(--dsw-alias-border-l1,rgba(0,0,0,.06));}
.sa-badge-ok{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#1a7f37) 12%,transparent);color:var(--dsw-alias-state-business-primary,#1a7f37);}
.sa-badge-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 14%,transparent);color:var(--dsw-alias-state-warn-primary,#b26a00);}
.sa-badge-brand{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent);color:var(--dsw-alias-brand-primary,#4d6bfe);}
.sa-button{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:var(--dsw-radius-md,8px);padding:7px 14px;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s;}
.sa-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));}
.sa-button:disabled{opacity:.55;cursor:default;}
.sa-banner{margin:0 0 20px;padding:11px 14px;border-radius:var(--dsw-radius-md,8px);font-size:13px;border:1px solid transparent;}
.sa-banner-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 24%,transparent);color:var(--dsw-alias-label-primary,#1a1a1a);}
.sa-banner-ok{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#1a7f37) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#1a7f37) 22%,transparent);}
.sa-banner-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d93025) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d93025) 22%,transparent);}
.sa-section{margin:0 0 26px;padding:18px 18px 16px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#fff);}
.sa-section-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px;}
.sa-section-title{margin:0 0 12px;font-size:14px;font-weight:650;letter-spacing:.01em;}
.sa-section-head .sa-section-title{margin:0;}
.sa-section-hint{color:var(--dsw-alias-label-tertiary,#80868b);font-size:12px;}
.sa-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:var(--dsw-radius-md,8px);overflow:hidden;}
.sa-cell{background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 12px;min-width:0;}
.sa-cell-wide{grid-column:1/-1;}
.sa-cell-label{color:var(--dsw-alias-label-tertiary,#80868b);font-size:11px;margin-bottom:3px;}
.sa-cell-value{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;font-size:13px;}
.sa-code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary,#5f6368);}
.sa-hint{margin-top:10px;color:var(--dsw-alias-label-tertiary,#80868b);font-size:12px;}
.sa-modes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}
.sa-tiers{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;}
.sa-mode{appearance:none;text-align:left;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,#fff);border-radius:var(--dsw-radius-md,8px);padding:13px 14px;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;display:flex;flex-direction:column;gap:8px;}
.sa-mode:hover:not(:disabled){border-color:var(--dsw-alias-border-selected,var(--dsw-alias-brand-primary,#4d6bfe));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.02));}
.sa-mode:disabled{cursor:default;opacity:.72;}
.sa-mode-active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe) inset;}
.sa-tier{appearance:none;text-align:left;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,#fff);border-radius:var(--dsw-radius-md,8px);padding:12px 13px;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;display:flex;flex-direction:column;gap:6px;}
.sa-tier:hover:not(:disabled){border-color:var(--dsw-alias-border-selected,var(--dsw-alias-brand-primary,#4d6bfe));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.02));}
.sa-tier:disabled{cursor:default;opacity:.72;}
.sa-tier-active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe) inset;}
.sa-tier-head{display:flex;align-items:center;gap:8px;}
.sa-tier-values{font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#5f6368);}
.sa-tier-when{font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a);}
.sa-mode-head{display:flex;align-items:center;gap:8px;}
.sa-mode-order{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6368);font-size:11px;font-weight:700;flex:none;}
.sa-mode-name{font-weight:650;font-size:14px;}
.sa-mode-tagline{color:var(--dsw-alias-label-secondary,#5f6368);font-size:12px;}
.sa-mode-row{display:grid;grid-template-columns:minmax(64px,max-content) minmax(0,1fr);gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a);}
.sa-mode-row-label{color:var(--dsw-alias-label-tertiary,#80868b);}
.sa-mode-cost{color:var(--dsw-alias-label-secondary,#5f6368);}
.sa-mode-saving{color:var(--dsw-alias-label-primary,#1a1a1a);}
.sa-mode-note{margin-top:2px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);color:var(--dsw-alias-label-tertiary,#80868b);font-size:11px;line-height:1.5;text-align:left;}
.sa-params{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;}
.sa-param{display:flex;flex-direction:column;gap:2px;padding:9px 11px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,#f7f8f9);}
.sa-param-key{color:var(--dsw-alias-label-tertiary,#80868b);font-size:11px;}
.sa-param-value{font-size:13px;font-weight:600;}
.sa-segment{display:inline-flex;padding:2px;gap:2px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));}
.sa-segment-button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#5f6368);font:inherit;font-size:12px;padding:5px 14px;border-radius:6px;cursor:pointer;}
.sa-segment-button:disabled{opacity:.55;cursor:default;}
.sa-segment-active{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;box-shadow:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.08));}
.sa-footer{padding-top:8px;display:flex;flex-direction:column;gap:5px;}
.sa-footer-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-quaternary,#9aa0a6);}
.sa-footer-docs{font-size:11px;color:var(--dsw-alias-label-quaternary,#9aa0a6);}
.sa-loading{margin-top:18px;color:var(--dsw-alias-label-tertiary,#80868b);font-size:13px;}
.sa-skeleton{height:44px;border-radius:var(--dsw-radius-md,8px);background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2,#f3f4f6),var(--dsw-alias-bg-layer-3,#e9eaec),var(--dsw-alias-bg-layer-2,#f3f4f6));background-size:200% 100%;animation:sa-shimmer 1.4s ease-in-out infinite;margin-bottom:10px;}
.sa-skeleton-title{height:28px;width:42%;}
@keyframes sa-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.sa-fail{max-width:620px;padding:28px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,#fff);}
.sa-fail-title{font-size:17px;font-weight:650;margin-bottom:6px;}
.sa-fail-text{color:var(--dsw-alias-label-secondary,#5f6368);font-size:13px;margin-bottom:10px;}
.sa-fail-detail{font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-state-error-primary,#d93025);margin-bottom:16px;word-break:break-all;}
@media (max-width:760px){.sa-shell{padding:20px 16px 36px}.sa-modes{grid-template-columns:1fr}.sa-tiers{grid-template-columns:1fr}.sa-params{grid-template-columns:repeat(2,minmax(0,1fr))}.sa-grid{grid-template-columns:1fr}.sa-header{flex-direction:column}}
@media (prefers-reduced-motion:reduce){.sa-skeleton{animation:none}}
`;

		/** Required client services: slot registry. */
		const inject = ["slots"];

		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.dataset.dshStreamAgentUi = "control";
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, "stream-agent-ui: styles");

			ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "stream-agent",
				order: 55,
				label: () => railLabel(ctx),
			}, RailIcon)), "stream-agent-ui: rail icon");

			ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: "stream-agent",
			}, ControlPage)), "stream-agent-ui: control page");
		}

		exports.NS = NS;
		exports.ROUTE = ROUTE;
		exports.TEXT = TEXT;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
