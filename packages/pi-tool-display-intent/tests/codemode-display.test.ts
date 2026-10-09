import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme,
	SessionManager, SettingsManager, ToolExecutionComponent, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AggregateProjection, registerAggregateProjectionEvents, renderAggregateActivity } from "../src/aggregate-activity.ts";
import { codemodeCallSummary, readCodemodeSnapshot, registerCodemodeRenderer, renderCodemodeSnapshot } from "../src/codemode-display.ts";
import { buildDetailModel } from "../src/detail-viewer-model.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const code = 'await Promise.allSettled([tools.read({ path: "中文.ts" }), tools.bash({ command: "npm test" })]);';
const calls = [
	{ id: "code/1", name: "read", args: '{"path":"中文.ts"}', status: "ok", durationMs: 15 },
	{ id: "code/2", name: "bash", args: '{"command":"npm test"}', status: "error", durationMs: 1200, error: "tests failed" },
];
const result = { content: [{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n\npartial result\nsecond line\nthird line\nfourth line" }], details: { calls } };

test("collapsed codemode hides source and surfaces caught child errors with bounded output", () => {
	const snapshot = readCodemodeSnapshot(result);
	const text = renderCodemodeSnapshot(snapshot, 80, theme, { expanded: false, durationMs: 1250 }).join("\n");
	assert.match(text, /read ×1 · bash ×1/);
	assert.match(text, /1 succeeded · 1 failed · 1.3s/);
	assert.match(text, /tests failed/);
	assert.match(text, /partial result/);
	assert.doesNotMatch(text, /Script completed|Wall time|fourth line|Promise/);
	assert.match(text, /expand for more/);
});

test("expanded codemode shows targets, timing, truncated JSON fallback, cancellations, models and costs", () => {
	const snapshot = readCodemodeSnapshot({ ...result, details: { calls: [
		...calls,
		{ id: "code/3", name: "models.generateImages", args: '{"prompt":"landscape"}', status: "ok", cost: 0.015 },
		{ id: "code/4", name: "mcp__search", args: '{"query":"truncated…', status: "cancelled", error: "aborted" },
	] } });
	const text = renderCodemodeSnapshot(snapshot, 100, theme, { expanded: true }).join("\n");
	assert.match(text, /read\(中文.ts\)/);
	assert.match(text, /bash\(npm test\).*1.2s/);
	assert.match(text, /mcp__search.*truncated/);
	assert.match(text, /1 cancelled/);
	assert.match(text, /\$0.0150/);
	assert.match(text, /fourth line/);
});

test("source-only and historical codemode handle missing details without inventing calls", () => {
	assert.equal(codemodeCallSummary([]), "0 calls");
	const snapshot = readCodemodeSnapshot({ content: [{ type: "text", text: "historical output" }] });
	assert.deepEqual(snapshot.calls, []);
	assert.match(renderCodemodeSnapshot(snapshot, 50, theme, { expanded: false }).join("\n"), /historical output/);
	const detail = buildDetailModel({ kind: "tool", toolName: "codemode", args: { code }, result });
	assert.equal(detail.tabs.find((tab) => tab.id === "args")?.fields?.[0]?.language, "javascript");
});

test("script failures remain visible after long partial output; stored full-output path is shown", () => {
	const snapshot = readCodemodeSnapshot({ content: [{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" + "ok\n".repeat(20) + "Script error:\nboom" }], details: { calls: [], fullOutputPath: "/tmp/full.txt" } });
	const text = renderCodemodeSnapshot(snapshot, 80, theme, { expanded: false, isError: true }).join("\n");
	assert.match(text, /script failed/);
	assert.match(text, /! boom/);
	assert.match(text, /Full output: \/tmp\/full.txt/);
});

test("codemode rendering fits narrow terminals and removes terminal control sequences", () => {
	const snapshot = readCodemodeSnapshot({ ...result, details: { calls: [{ ...calls[1], error: "\x1b]2;bad title\x07错误\n\x1b[2Jfailure" }] } });
	for (const width of [0, 1, 2, 4, 8, 20, 72, 120]) {
		for (const expanded of [false, true]) {
			const lines = renderCodemodeSnapshot(snapshot, width, theme, { expanded });
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
			assert.ok(lines.every((line) => !line.includes("\x1b]2") && !line.includes("\x1b[2J")));
		}
	}
});

test("Run groups nested events under codemode and restores the same ledger from history", async () => {
	const projection = new AggregateProjection();
	projection.setRenderTheme(theme);
	const handlers = new Map<string, Function>();
	const api = { on: (name: string, handler: Function) => handlers.set(name, handler) } as unknown as ExtensionAPI;
	registerAggregateProjectionEvents(api, projection);
	const user = { type: "message", id: "user", message: { role: "user", content: "test", timestamp: 1 } };
	const assistant = { type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "toolCall", id: "code", name: "codemode", arguments: { code } }], stopReason: "toolUse", timestamp: 2 } };
	projection.rebuild([user, assistant], [user.message, assistant.message]);
	await handlers.get("tool_execution_start")?.({ toolCallId: "code", toolName: "codemode", args: { code } });
	await handlers.get("tool_execution_start")?.({ toolCallId: "code/1", toolName: "read", parentToolCallId: "code", args: { path: "中文.ts" } });
	await handlers.get("tool_execution_update")?.({ toolCallId: "code", args: { code }, partialResult: { content: [], details: { calls: [{ ...calls[0], status: "running" }] } } });
	assert.equal(projection.getView("code")?.callCount, 1);
	assert.equal(projection.getView("code")?.nestedCallCount, 1);
	assert.equal(projection.getMember("code/1"), undefined);
	await handlers.get("tool_execution_end")?.({ toolCallId: "code/1", parentToolCallId: "code", result: {}, isError: false });
	await handlers.get("tool_execution_end")?.({ toolCallId: "code", result, isError: false });
	projection.markGroupSettled();
	projection.collapseRetainedDone();
	const view = projection.getView("code")!;
	assert.equal(view.callCount, 1);
	assert.equal(view.nestedCallCount, 2);
	assert.equal(view.nestedFailedCount, 1);
	assert.equal(view.failedCount, 0, "a caught child error does not change script success");
	const collapsed = renderAggregateActivity(view, 120, theme).join("\n");
	assert.match(collapsed, /nested failed/);
	assert.match(collapsed, /tests failed/);
	assert.match(collapsed, /partial result/);
	assert.doesNotMatch(collapsed, /Promise|arguments|\.allSettled/);
	const expanded = projection.renderExpandedToolRow("code", 120).join("\n");
	assert.match(expanded, /read\(中文.ts\)/);
	assert.match(expanded, /bash\(npm test\)/);
	const storedResult = { type: "message", id: "result", message: { role: "toolResult", toolCallId: "code", toolName: "codemode", ...result, isError: false, timestamp: 3 } };
	const restored = new AggregateProjection();
	restored.rebuild([user, assistant, storedResult], [user.message, assistant.message, storedResult.message]);
	assert.deepEqual(restored.getMember("code")?.codemode, projection.getMember("code")?.codemode);
	assert.equal(restored.getView("code")?.nestedCallCount, 2);
	await handlers.get("session_shutdown")?.();
});

test("renderer registration preserves other owners and native expansion fits every width", () => {
	initTheme();
	let resolver: any;
	registerCodemodeRenderer({ registerToolRenderer: (value: unknown) => { resolver = value; } } as ExtensionAPI, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	const other = {};
	assert.equal(resolver("read", () => other), other);
	const renderers = resolver("codemode", () => undefined);
	const component = new ToolExecutionComponent("codemode", "code", { code }, { outputPad: 1 }, renderers, { requestRender() {} } as never, process.cwd());
	component.markExecutionStarted();
	component.updateResult({ ...result, isError: false });
	assert.doesNotMatch(component.render(100).map(stripTerminalSequences).join("\n"), /Promise/);
	component.setExpanded(true);
	assert.match(component.render(100).map(stripTerminalSequences).join("\n"), /Promise/);
	for (const width of [1, 2, 8, 30, 72, 120]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `width ${width}: ${JSON.stringify(component.render(width).map(stripTerminalSequences))}`);
	let passResolver: any;
	registerCodemodeRenderer({ registerToolRenderer: (value: unknown) => { passResolver = value; } } as ExtensionAPI, () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, passthroughToolNames: ["codemode"] }));
	assert.equal(passResolver("codemode", () => other), other);
});

test("legacy generic codemode configuration does not decorate the native tool", async () => {
	const handlers = new Map<string, Function[]>();
	const parameters = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };
	const execute = async () => ({ content: [] });
	const native = { name: "codemode", parameters, execute };
	const api = {
		registerTool() {},
		getAllTools: () => [native],
		on(name: string, handler: Function) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
	} as unknown as ExtensionAPI;
	registerToolDisplayOverrides(api, () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, customToolOverrides: { codemode: { kind: "generic", outputMode: "summary" } } }));
	for (const handler of handlers.get("before_agent_start") ?? []) await handler();
	assert.equal(native.parameters, parameters);
	assert.equal(native.execute, execute);
	assert.equal((native as any).renderCall, undefined);
	assert.equal((native as any).prepareArguments, undefined);
});

test("Pi SDK executes native codemode parallel calls and dynamic discovery without replacing its schema", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codemode-display-sdk-"));
	writeFileSync(join(cwd, "中文.ts"), "export const value = 42;\n");
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "codemode"], codemode: { mode: "on" } });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, extensionFactories: [createCodemodeExtension({ mode: "on" }), (pi) => registerCodemodeRenderer(pi, () => DEFAULT_TOOL_DISPLAY_CONFIG)] });
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
	try {
		await session.bindExtensions({});
		const tool = session.agent.state.tools.find((tool) => tool.name === "codemode")!;
		assert.ok(tool);
		assert.deepEqual(Object.keys((tool.parameters as any).properties), ["code"]);
		const updates: unknown[] = [];
		// Nested execution requires an issued assistant call, just like the real loop.
		const issued = { role: "assistant", content: [{ type: "toolCall", id: "native-code", name: "codemode", arguments: { code: "" } }], api: "openai-responses", provider: "test", model: "test", stopReason: "toolUse", timestamp: Date.now() };
		session.sessionManager.appendMessage(issued as never);
		session.agent.state.messages.push(issued as never);
		const execution = await tool.execute("native-code", { code: 'const found = await searchTools("read file"); const r = await Promise.allSettled([tools.read({path: "中文.ts"}), tools.read({path: "missing.ts"})]); text(r.map(v => v.status));' }, new AbortController().signal, (value) => updates.push(value));
		const snapshot = readCodemodeSnapshot(execution);
		assert.equal(snapshot.calls.filter((call) => call.name === "read").length, 2);
		assert.equal(snapshot.calls.filter((call) => call.status === "error").length, 1, JSON.stringify(snapshot));
		assert.ok(updates.some((value) => readCodemodeSnapshot(value).calls.some((call) => call.status === "running")));
		assert.match(renderCodemodeSnapshot(snapshot, 100, theme, { expanded: false }).join("\n"), /1 failed/);
		assert.ok(session.extensionRunner.resolveToolRenderers("codemode", () => undefined)?.renderResult);
	} finally { session.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
