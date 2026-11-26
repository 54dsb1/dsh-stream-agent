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
	 *   区块 A「执行通道」standard/code——用户选择的是模型看到什么；0.6.1 起第二项
	 *   命名为「PTC兼容模式」，"依赖 PTC"仍是探测结果（来源行如实显示探测结果）。
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
				channelHint: "选模型看到什么：标准 = tf-* 命令；PTC兼容模式 = 单一 run_code 入口。",
				tierTitle: "② 上下文档位",
				tierHint: "只改压缩强度与展示参考值；默认数值面 = thinkflow 对齐层。",
				tierValuesTitle: "实际数值",
				advancedTitle: "高级",
				advancedHint: "取回预算 / 前缀策略 / 重复抑制（peekBudgetChars / prefixPolicy / spanLedger）",
				sourceTitle: "PTC兼容模式来源",
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
				unlimited: "不限",
				unsetHint: "0 = 不限制。默认数值面 = thinkflow 对齐层（轮数不设上限），你的 limits 逐项覆盖。",
				limitsTitle: "③ 用户上限",
				limitsHint: "轮数、上下文、取回预算、重入、tf-code 配额等全部由你定义（0 = 不限制）；留空 = 沿用 thinkflow 对齐默认层。",
				limitsUnset: "留空 = 默认预设",
				limitsApply: "写入上限",
				limitsClear: "清空自定义（回默认）",
				limitsEmpty: "状态里没有上限目录：请确认插件已正确装载。",
				limitsWarn: "部分键未被接受",
				limitsApplied: "上限已写入：新会话立即生效，运行中的会话在下一个任务边界生效。",
				limitsCleared: "已清空自定义上限（回到 thinkflow 对齐默认预设）。",
				limitsDegraded: "loop 未接管：上限已写入状态文件，修复装载并重启后生效。",
				limitsCount: "已定义",
				limitsGroupBudget: "预算",
				limitsGroupTransport: "传输（wire）",
				limitsGroupRetrieval: "取回与回灌",
				limitsGroupCompaction: "压缩",
				limitsGroupRebase: "换基与重入",
				limitsGroupExecution: "并行与执行",
				limitsGroupCode: "tf-code 配额",
				switchesTitle: "④ 行为开关",
				switchesHint: "折叠 = 压缩/效果折叠/段边界；验收 = tf-final/accepts；原样 = 上下文完全不处理（不压缩/不折叠/不丢段/不去重/不截断）。开关对新会话生效。",
				foldLabel: "上下文折叠",
				finalLabel: "流末验收",
				rawLabel: "上下文原样（完全不处理）",
				finalInert: "PTC兼容模式无验收闸，不生效",
				switchOn: "开",
				switchOff: "关",
				hostPresetsTitle: "宿主会话预设（DSH 标准 / PTC）",
				hostPresetsHint: "宿主 agent preset 名册（只读）。新建会话时在宿主会话页选择预设：standard ↔ 本插件 A 通道；ptc ↔ B 通道（PTC兼容模式）。",
				hostPresetsNone: "宿主未提供预设名册（headless 或旧宿主）。",
				tierReference: "参考值（未生效）",
				useWhen: "什么时候选",
				tradeoff: "代价",
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
				cliHint: "dsh-stream-agent channel <standard|code> · tier <light|standard|deep> · fold/final/raw <on|off> · lang <zh|en> · limits --set k=v · bar",
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
				channelHint: "Pick what the model sees: Standard = tf-* commands; PTC-compat = single run_code entry.",
				tierTitle: "(2) Context tier",
				tierHint: "Compaction strength and display references only; the default numeric face is the thinkflow-aligned layer.",
				tierValuesTitle: "Actual values",
				advancedTitle: "Advanced",
				advancedHint: "peek budget / prefix policy / dup suppression (peekBudgetChars / prefixPolicy / spanLedger)",
				sourceTitle: "PTC-compat source",
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
				unlimited: "unlimited",
				unsetHint: "0 = unlimited. The default numeric face is the thinkflow-aligned layer (no round cap); your limits override item by item.",
				limitsTitle: "(3) User limits",
				limitsHint: "Rounds, context, retrieval budget, re-entries, tf-code quota: all yours to define (0 = unlimited). Blank = keep the thinkflow-aligned defaults.",
				limitsUnset: "blank = default preset",
				limitsApply: "Write limits",
				limitsClear: "Clear overrides (defaults)",
				limitsEmpty: "No limit catalog in the status payload: make sure the plugin is properly loaded.",
				limitsWarn: "some keys rejected",
				limitsApplied: "Limits written: new sessions pick them up immediately, running sessions at the next task boundary.",
				limitsCleared: "Custom limits cleared (back to the thinkflow-aligned default preset).",
				limitsDegraded: "No takeover: limits written to the state file, effective after reload and restart.",
				limitsCount: "defined",
				limitsGroupBudget: "Budget",
				limitsGroupTransport: "Transport (wire)",
				limitsGroupRetrieval: "Retrieval & feedback",
				limitsGroupCompaction: "Compaction",
				limitsGroupRebase: "Rebase & re-entry",
				limitsGroupExecution: "Parallelism",
				limitsGroupCode: "tf-code quota",
				switchesTitle: "(4) Behavior switches",
				switchesHint: "Fold = compaction/effect fold/segment boundary; Final = tf-final/accepts; Raw = no context processing at all. Switches apply to new sessions.",
				foldLabel: "Context fold",
				finalLabel: "Final check",
				rawLabel: "Raw context (no processing)",
				finalInert: "PTC-compat channel has no final gate; inert",
				switchOn: "on",
				switchOff: "off",
				hostPresetsTitle: "Host session presets (DSH standard / PTC)",
				hostPresetsHint: "Host agent preset roster (read-only). Pick a preset when creating a new session in the host session page: standard ↔ channel A; ptc ↔ channel B (PTC-compat).",
				hostPresetsNone: "Host preset roster unavailable (headless or old host).",
				tierReference: "reference (not applied)",
				useWhen: "When to choose",
				tradeoff: "Trade-off",
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
				cliHint: "dsh-stream-agent channel <standard|code> · tier <light|standard|deep> · fold/final/raw <on|off> · lang <zh|en> · limits --set k=v · bar",
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
			const [hostPresets, setHostPresets] = useState(null);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [busy, setBusy] = useState(false);

			const load = useCallback(async () => {
				setPhase((current) => (current === "ready" ? current : "loading"));
				try {
					const payload = await call("GET");
					setStatus(payload.status);
					setHostPresets(payload.presets ?? null);
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
					const copy = copyFor(payload?.status?.lang ?? status?.lang);
					const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
					setNotice({
						kind: warnings.length > 0 ? "warn" : "ok",
						text: `${payload?.notice ?? copy.saved}${warnings.length > 0 ? ` (${copy.limitsWarn}: ${warnings.join("; ")})` : ""}`,
					});
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

			return { phase, status, hostPresets, error, notice, busy, reload: load, mutate };
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
			// 0.5.2：0 表示"不限制"（limits 语义），不能原样显示成"上限 0"；
			// 未定义同样是"不限制"，但那是"没设过"，用破折号区分。
			const show = (value) => {
				if (value === null || value === undefined) return "—";
				if (value === 0) return t.unlimited;
				return String(value);
			};
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
					h("span", { className: "sa-param-value" }, show(value)),
				)),
				h("div", { className: "sa-param-hint" }, t.unsetHint),
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
			);
		}

		function TierButton({ tier, lang, active, locked, busy, onSelect }) {
			const t = copyFor(lang);
			// 0.5.2：档位不再预设上限（values 的数值位恒为 0 = 不限制），
			// 卡片上能摆的只有**参考值**，并且必须标出来，否则用户会以为已经在生效。
			const v = tier.reference ?? tier.values;
			const values = `maxSteps ${v.maxSteps} · maxInputTokens ${Math.round(v.maxInputTokens / 1000)}k · ${t.params.compactAggressiveness} ${v.compactAggressiveness}`;
			const caption = `${t.tierReference}：${values}`;
			return h("button", {
				type: "button",
				className: `sa-tier${active ? " sa-tier-active" : ""}`,
				disabled: locked || busy,
				"aria-pressed": active,
				onClick: () => onSelect(tier.id),
				title: `${t.apply}: ${caption}`,
			},
				h("div", { className: "sa-tier-head" },
					h("span", { className: "sa-mode-name" }, tier.label[lang]),
					active ? h(Badge, { tone: "brand" }, t.selected) : null,
				),
				h("div", { className: "sa-tier-values" }, caption),
				h("div", { className: "sa-tier-when" }, tier.useWhen[lang]),
			);
		}

		/**
		 * ③ 用户上限（0.5.3）。设计口径：**控件本身不预填任何值**——目录来自状态里的
		 * limitCatalog（key/unit/group/label/value），value 未定义就渲染成空输入框。
		 * 提交面 = { limits: {k: number}, limitsReplace: true }（整组替换，清空自定义 =
		 * 回到默认预设），这样"用户删掉一个键"与"用户没设过这个键"在语义上完全一致。
		 */
		function LimitsEditor({ status, t, busy, onApply, onClear }) {
			const catalog = Array.isArray(status.limitCatalog) ? status.limitCatalog : [];
			const [draft, setDraft] = useState({});
			const [dirty, setDirty] = useState(false);

			useEffect(() => {
				const next = {};
				for (const item of catalog) next[item.key] = item.value === undefined ? "" : String(item.value);
				setDraft(next);
				setDirty(false);
			}, [status.updatedAt, status.lang]);

			if (catalog.length === 0) return h("div", { className: "sa-hint" }, t.limitsEmpty);

			const configured = catalog.filter((item) => item.value !== undefined).length;
			const edit = (key, value) => {
				setDraft((current) => ({ ...current, [key]: value }));
				setDirty(true);
			};
			const commit = () => {
				const patch = {};
				for (const item of catalog) {
					const raw = draft[item.key];
					if (raw === undefined || String(raw).trim() === "") continue;
					patch[item.key] = Number(String(raw).trim());
				}
				onApply(patch);
				setDirty(false);
			};
			const groups = [];
			for (const item of catalog) {
				const last = groups[groups.length - 1];
				if (last !== undefined && last.group === item.group) last.items.push(item);
				else groups.push({ group: item.group, items: [item] });
			}
			const groupLabel = (group) => t[`limitsGroup${group[0].toUpperCase()}${group.slice(1)}`] ?? group;

			return h("div", null,
				h("div", { className: "sa-limits-head" },
					h(Badge, { tone: configured > 0 ? "ok" : "neutral" }, `${t.limitsCount} ${configured}/${catalog.length}`),
					h("button", { type: "button", className: "sa-button", disabled: busy, onClick: commit },
						busy ? t.applying : t.limitsApply),
					h("button", { type: "button", className: "sa-button sa-button-ghost", disabled: busy, onClick: onClear },
						t.limitsClear),
					dirty ? h("span", { className: "sa-limits-dirty" }, "●") : null,
				),
				groups.map((section) => h("div", { className: "sa-limits-group", key: section.group },
					h("div", { className: "sa-limits-group-title" }, groupLabel(section.group)),
					h("div", { className: "sa-limits-grid" },
						section.items.map((item) => h("label", { className: "sa-limit", key: item.key },
							h("span", { className: "sa-limit-label" }, (item.label && item.label[status.lang === "en" ? "en" : "zh"]) ?? item.key),
							h("input", {
								className: "sa-limit-input",
								type: "number",
								min: 0,
								step: 1,
								inputMode: "numeric",
								placeholder: t.limitsUnset,
								value: draft[item.key] ?? "",
								disabled: busy,
								onChange: (event) => edit(item.key, event.target.value),
							}),
							h("span", { className: "sa-limit-key" }, item.unit === "count" ? item.key : `${item.key} · ${item.unit}`),
						)),
					),
				)),
			);
		}

		/** 0.6.0 正式版：行为开关（折叠 / 验收 / 原样）。PTC兼容模式验收闸置灰。 */
		function Switches({ status, t, busy, onToggle }) {
			const rows = [
				["contextFold", t.foldLabel, status.contextFold !== false],
				["finalCheck", t.finalLabel, status.finalCheck !== false],
				["contextRaw", t.rawLabel, status.contextRaw === true],
			];
			return h("div", null,
				rows.map(([key, label, on]) => {
					const inert = key === "finalCheck" && status.channel === "code";
					return h("div", { className: "sa-mode-row", key, style: { marginTop: "8px" } },
						h("span", { className: "sa-mode-row-label" }, label),
						h("span", null,
							h("div", { className: "sa-segment", role: "group", "aria-label": label },
								h("button", {
									type: "button",
									className: `sa-segment-button${on ? " sa-segment-active" : ""}`,
									disabled: busy || inert,
									"aria-pressed": on,
									onClick: () => onToggle(key, true),
								}, t.switchOn),
								h("button", {
									type: "button",
									className: `sa-segment-button${!on ? " sa-segment-active" : ""}`,
									disabled: busy || inert,
									"aria-pressed": !on,
									onClick: () => onToggle(key, false),
								}, t.switchOff),
							),
							inert ? h("div", { className: "sa-hint" }, t.finalInert) : null,
						),
					);
				}),
			);
		}

		function ControlPage() {
			const { phase, status, hostPresets, error, notice, busy, reload, mutate } = useControl();
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

					// 区块 A：执行通道（0.6.1：第二项 = PTC兼容模式；来源是探测结果行）
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

					// ③ 用户上限（0.5.3）：0.6.1 起默认面 = thinkflow 对齐层，这里写 limits 即逐项覆盖
					h("section", { className: "sa-section" },
						h("div", { className: "sa-section-head" },
							h("h2", { className: "sa-section-title" }, t.limitsTitle),
							h("span", { className: "sa-section-hint" }, t.limitsHint),
						),
						h(LimitsEditor, {
							status,
							t,
							busy,
							onApply: (patch) => mutate({ limits: patch, limitsReplace: true }),
							onClear: () => mutate({ limits: null }),
						}),
					),

					// ④ 行为开关（0.6.0 正式版）：折叠 / 验收 / 原样（完全不处理）
					h("section", { className: "sa-section" },
						h("div", { className: "sa-section-head" },
							h("h2", { className: "sa-section-title" }, t.switchesTitle),
							h("span", { className: "sa-section-hint" }, t.switchesHint),
						),
						h(Switches, {
							status,
							t,
							busy,
							onToggle: (key, value) => mutate({ [key]: value }),
						}),
					),

					// 宿主会话预设名册（DSH 标准 / PTC 适配面；只读——切换在宿主会话页新建时选择）
					h("section", { className: "sa-section" },
						h("div", { className: "sa-section-head" },
							h("h2", { className: "sa-section-title" }, t.hostPresetsTitle),
							h("span", { className: "sa-section-hint" }, t.hostPresetsHint),
						),
						hostPresets && Array.isArray(hostPresets.items) && hostPresets.items.length > 0
							? h("div", { className: "sa-params" },
								hostPresets.items.map((p) => h("div", { className: "sa-param", key: p.id },
									h("span", { className: "sa-param-key" }, `${p.id}${p.id === hostPresets.defaultId ? " · default" : ""}${p.broken ? " · broken" : ""}`),
									h("span", { className: "sa-param-value" }, p.name ?? p.id),
								)),
							)
							: h("div", { className: "sa-hint" }, hostPresets && hostPresets.error ? String(hostPresets.error) : t.hostPresetsNone),
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
.sa-limits-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;}
.sa-limits-dirty{color:var(--dsw-alias-brand-primary,#1a73e8);font-size:12px;}
.sa-limits-group{margin:0 0 14px;}
.sa-limits-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6368);margin:0 0 8px;}
.sa-limits-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;}
.sa-limit{display:flex;flex-direction:column;gap:4px;}
.sa-limit-label{font-size:12px;color:var(--dsw-alias-label-secondary,#5f6368);}
.sa-limit-input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#202124);font:inherit;font-size:13px;}
.sa-limit-input::placeholder{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
.sa-limit-key{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
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
.sa-param-hint{grid-column:1/-1;color:var(--dsw-alias-label-tertiary,#80868b);font-size:11px;line-height:1.5;}
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
