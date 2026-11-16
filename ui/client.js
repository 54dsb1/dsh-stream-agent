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
		 * bridge, no duplicated state: mode/lang still live in control.json and the
		 * loop's in-memory control object is the one writer.
		 */

		const ROUTE = "/stream-agent/control";
		const NS = "stream-agent-ui";

		const TEXT = {
			zh: {
				title: "控制栏",
				subtitle: "单流协议运行模式与语言。改完立即对新会话生效，已有会话保持原设置。",
				refresh: "刷新",
				refreshing: "刷新中…",
				loading: "正在读取控制状态…",
				loadFailed: "读不到控制状态",
				retry: "重试",
				hostUnreachable: "宿主没有响应控制路由。确认插件已装入当前 profile，并重启客户端。",
				active: "接管生效",
				inactive: "未接管",
				inactiveHint: "loop 没有注册 agent factory。模式仍可写入状态文件，但修复装载并重启后才会生效。",
				statusTitle: "当前状态",
				modeTitle: "运行模式",
				modeHint: "四选一。每张卡都写了“什么时候选”和“代价”，不确定就先用均衡。",
				paramsTitle: "生效参数",
				langTitle: "控制栏语言",
				langHint: "只影响控制栏文案与页面，不改模型输出语言。",
				version: "版本",
				mode: "模式",
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
				apply: "切到这个模式",
				applying: "应用中…",
				useWhen: "什么时候选",
				tradeoff: "代价",
				saved: "已保存，对新会话生效。",
				noticeConflict: "状态已被其他窗口或 CLI 修改，已刷新为最新值。",
				writeFailed: "写入失败",
				params: {
					selfReadFeedback: "自写回验",
					enableCode: "tf-code",
					persistFallback: "本地兜底",
					maxParallelToolCalls: "并行命令",
					maxReentries: "最大重入",
					budgetTokens: "token 预算",
				},
				values: {
					receipt: "只回回执",
					full: "全文回灌",
					auto: "跟随宿主",
					on: "开启",
					off: "关闭",
					unlimited: "不限",
				},
				cli: "命令行等价操作",
				cliHint: "dsh-stream-agent mode <id> · dsh-stream-agent lang <zh|en> · dsh-stream-agent bar",
				docs: "说明文档：README.md#桌面客户端控制页",
			},
			en: {
				title: "Control bar",
				subtitle: "Single-stream runtime mode and language. Changes apply to new sessions immediately; existing sessions keep their settings.",
				refresh: "Refresh",
				refreshing: "Refreshing…",
				loading: "Reading control state…",
				loadFailed: "Cannot read control state",
				retry: "Retry",
				hostUnreachable: "The Host did not answer the control route. Confirm the plugin is installed in this profile, then restart the client.",
				active: "Takeover active",
				inactive: "Not taking over",
				inactiveHint: "The loop did not register an agent factory. Mode changes still write the state file, but they only apply after the load failure is fixed and the client restarts.",
				statusTitle: "Current state",
				modeTitle: "Runtime mode",
				modeHint: "Pick one of four. Every card states when to choose it and what it costs; start with Balanced when unsure.",
				paramsTitle: "Effective parameters",
				langTitle: "Control bar language",
				langHint: "Only the control bar and this page; it does not change the model's output language.",
				version: "Version",
				mode: "Mode",
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
				apply: "Switch to this mode",
				applying: "Applying…",
				useWhen: "When to choose",
				tradeoff: "Trade-off",
				saved: "Saved. Applies to new sessions.",
				noticeConflict: "Another window or the CLI changed the state; refreshed to the latest value.",
				writeFailed: "Write failed",
				params: {
					selfReadFeedback: "Self-read feedback",
					enableCode: "tf-code",
					persistFallback: "Local fallback",
					maxParallelToolCalls: "Parallel commands",
					maxReentries: "Max re-entries",
					budgetTokens: "Token budget",
				},
				values: {
					receipt: "receipt only",
					full: "full echo",
					auto: "follow Host",
					on: "on",
					off: "off",
					unlimited: "unlimited",
				},
				cli: "CLI equivalents",
				cliHint: "dsh-stream-agent mode <id> · dsh-stream-agent lang <zh|en> · dsh-stream-agent bar",
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

		function valueLabel(t, key, value) {
			if (value === null || value === undefined) return t.values.unlimited;
			if (typeof value === "boolean") return value ? t.values.on : t.values.off;
			if (typeof value === "string") return t.values[value] ?? value;
			return String(value);
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
				["selfReadFeedback", effective.selfReadFeedback],
				["enableCode", effective.enableCode],
				["persistFallback", effective.persistFallback],
				["maxParallelToolCalls", effective.maxParallelToolCalls],
				["maxReentries", effective.maxReentries],
				["budgetTokens", effective.budgetTokens],
			];
			return h("div", { className: "sa-params" },
				rows.map(([key, value]) => h("div", { className: "sa-param", key },
					h("span", { className: "sa-param-key" }, t.params[key] ?? key),
					h("span", { className: "sa-param-value" }, valueLabel(t, key, value)),
				)),
			);
		}

		function ModeCard({ mode, lang, active, locked, busy, onSelect }) {
			const t = copyFor(lang);
			return h("button", {
				type: "button",
				className: `sa-mode${active ? " sa-mode-active" : ""}`,
				disabled: locked || busy,
				"aria-pressed": active,
				onClick: () => onSelect(mode.id),
				title: active ? t.selected : t.apply,
			},
				h("div", { className: "sa-mode-head" },
					h("span", { className: "sa-mode-order" }, mode.order),
					h("span", { className: "sa-mode-name" }, mode.label[lang]),
					active ? h(Badge, { tone: "brand" }, t.selected) : null,
				),
				h("div", { className: "sa-mode-tagline" }, mode.tagline[lang]),
				h("div", { className: "sa-mode-row" },
					h("span", { className: "sa-mode-row-label" }, t.useWhen),
					h("span", null, mode.useWhen[lang]),
				),
				h("div", { className: "sa-mode-row sa-mode-cost" },
					h("span", { className: "sa-mode-row-label" }, t.tradeoff),
					h("span", null, mode.tradeoff[lang]),
				),
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

			const locked = status.modeLocked === true;
			const langLocked = status.langLocked === true;
			const source = sourceLabel(t, status.modeSource);
			const activeMode = (status.modes ?? []).find((mode) => mode.id === status.mode);

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
							h(StatusCell, { label: t.mode },
								activeMode ? `${activeMode.order} · ${activeMode.label[lang]}` : status.mode,
								locked ? h(Badge, { tone: "warn" }, t.locked) : null,
							),
							h(StatusCell, { label: t.source }, source),
							h(StatusCell, { label: t.language }, status.lang),
							h(StatusCell, { label: t.updatedAt }, status.updatedAt ? new Date(status.updatedAt).toLocaleString() : t.never),
							h(StatusCell, { label: t.stateFile, wide: true },
								h("code", { className: "sa-code", title: status.stateFile }, status.stateFile),
							),
						),
						locked ? h("div", { className: "sa-hint" }, status.modeSource === "env" ? t.lockedEnv : t.lockedConfig) : null,
					),

					h("section", { className: "sa-section" },
						h("div", { className: "sa-section-head" },
							h("h2", { className: "sa-section-title" }, t.modeTitle),
							h("span", { className: "sa-section-hint" }, t.modeHint),
						),
						h("div", { className: "sa-modes" },
							(status.modes ?? []).map((mode) => h(ModeCard, {
								key: mode.id,
								mode,
								lang,
								active: mode.id === status.mode,
								locked,
								busy,
								onSelect: (id) => mutate({ mode: id }),
							})),
						),
					),

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
.sa-mode{appearance:none;text-align:left;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-alias-bg-layer-1,#fff);border-radius:var(--dsw-radius-md,8px);padding:13px 14px;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .15s;display:flex;flex-direction:column;gap:8px;}
.sa-mode:hover:not(:disabled){border-color:var(--dsw-alias-border-selected,var(--dsw-alias-brand-primary,#4d6bfe));background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.02));}
.sa-mode:disabled{cursor:default;opacity:.72;}
.sa-mode-active{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary,#4d6bfe) inset;}
.sa-mode-head{display:flex;align-items:center;gap:8px;}
.sa-mode-order{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#5f6368);font-size:11px;font-weight:700;flex:none;}
.sa-mode-name{font-weight:650;font-size:14px;}
.sa-mode-tagline{color:var(--dsw-alias-label-secondary,#5f6368);font-size:12px;}
.sa-mode-row{display:grid;grid-template-columns:minmax(64px,max-content) minmax(0,1fr);gap:8px;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a);}
.sa-mode-row-label{color:var(--dsw-alias-label-tertiary,#80868b);}
.sa-mode-cost{color:var(--dsw-alias-label-secondary,#5f6368);}
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
@media (max-width:760px){.sa-shell{padding:20px 16px 36px}.sa-modes{grid-template-columns:1fr}.sa-params{grid-template-columns:repeat(2,minmax(0,1fr))}.sa-grid{grid-template-columns:1fr}.sa-header{flex-direction:column}}
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
