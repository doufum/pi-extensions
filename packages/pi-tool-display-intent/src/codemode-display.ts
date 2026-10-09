import { highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatAggregateArgumentPreview } from "./aggregate-argument-preview.js";
import { layoutPreviewRows } from "./preview-text.js";
import { extractTextOutput, shortenPath } from "./render-utils.js";
import { sanitizeDetailText } from "./detail-viewer-model.js";
import type { ToolDisplayConfig } from "./types.js";

export interface CodemodeCall {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
}
export interface CodemodeSnapshot {
	calls: CodemodeCall[];
	output: string;
	fullOutputPath?: string;
}
export interface CodemodeTheme { fg(color: string, text: string): string; bold?(text: string): string }

const STATUSES = new Set(["running", "ok", "error", "cancelled"]);
const clean = (text: string) => sanitizeDetailText(text, false).replace(/\s+/g, " ").trim();

/** Use Pi's actual execution ledger; source code is never parsed as a call plan. */
export function readCodemodeSnapshot(result: unknown): CodemodeSnapshot {
	const record = result as { details?: { calls?: unknown; fullOutputPath?: unknown } } | undefined;
	const details = record?.details;
	const calls = Array.isArray(details?.calls) ? details.calls.filter((call): call is CodemodeCall =>
		call !== null && typeof call === "object" && typeof call.id === "string" &&
		typeof call.name === "string" && typeof call.args === "string" && STATUSES.has(call.status),
	).map((call) => ({ ...call })) : [];
	const text = extractTextOutput(result as never).replace(/\r\n?/g, "\n");
	// These two lines are native codemode chrome, duplicated by our status row.
	const output = text.replace(/^Script (?:completed|failed)\nWall time [^\n]*\nOutput:\n?/, "").trim();
	return {
		calls, output,
		...(typeof details?.fullOutputPath === "string" ? { fullOutputPath: details.fullOutputPath } : {}),
	};
}

export function codemodeCallSummary(calls: readonly CodemodeCall[]): string {
	const counts = new Map<string, number>();
	for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
	return [...counts].map(([name, count]) => `${clean(name)} ×${count}`).join(" · ") || "0 calls";
}

export function codemodeDuration(ms: number | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function codemodeStatusSummary(calls: readonly CodemodeCall[], partial = false): string {
	const labels = { running: "running", ok: "succeeded", error: "failed", cancelled: "cancelled" };
	const parts = Object.entries(labels).flatMap(([status, label]) => {
		const count = calls.filter((call) => call.status === status).length;
		return count ? [`${count} ${label}`] : [];
	});
	return parts.join(" · ") || (partial ? "running" : "no nested calls");
}

export function codemodeCallTarget(call: CodemodeCall): string {
	try {
		const args = JSON.parse(call.args);
		if (args && typeof args === "object") {
			const path = typeof args.path === "string" ? shortenPath(args.path) : undefined;
			const target = path ?? (typeof args.command === "string" ? args.command : formatAggregateArgumentPreview(args));
			return target ? `${clean(call.name)}(${clean(target)})` : clean(call.name);
		}
	} catch { /* Pi truncates argument JSON; preserve its readable prefix. */ }
	return call.args ? `${clean(call.name)}(${clean(call.args)})` : clean(call.name);
}

function boundedRows(source: string[], cap: number, width: number): string[] {
	const layout = layoutPreviewRows(source, cap, width);
	const rows = [...layout.rows];
	if (layout.rowLimitReached || layout.longLineTruncated || layout.safetyLimitReached) rows.push(truncateToWidth("… expand for more", width, "…"));
	return rows;
}

/** Shared by the individual renderer and the Run ledger. Never hides nested failures. */
export function renderCodemodeSnapshot(
	snapshot: CodemodeSnapshot,
	width: number,
	theme: CodemodeTheme,
	options: { expanded: boolean; partial?: boolean; isError?: boolean; durationMs?: number; maxRows?: number },
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (!safeWidth) return [];
	const fit = (line: string) => truncateToWidth(line, safeWidth, "…");
	const failed = snapshot.calls.some((call) => call.status === "error" || call.status === "cancelled");
	const status = `${options.isError ? "script failed · " : ""}${codemodeStatusSummary(snapshot.calls, options.partial)}`;
	const duration = codemodeDuration(options.durationMs);
	const cost = snapshot.calls.reduce((sum, call) => sum + (typeof call.cost === "number" && Number.isFinite(call.cost) && call.cost > 0 ? call.cost : 0), 0);
	const lines = [fit(theme.fg("muted", codemodeCallSummary(snapshot.calls))), fit(theme.fg(options.isError || failed ? "error" : "muted", `${status}${duration ? ` · ${duration}` : ""}${cost ? ` · $${cost.toFixed(4)}` : ""}`))];
	if (options.expanded) {
		const calls = snapshot.calls.slice(0, options.maxRows ?? 4000);
		for (const call of calls) {
			const marker = call.status === "ok" ? "✓" : call.status === "running" ? "●" : "!";
			const color = call.status === "ok" ? "success" : call.status === "running" ? "warning" : "error";
			const timing = codemodeDuration(call.durationMs);
			lines.push(fit(`${theme.fg(color, marker)} ${codemodeCallTarget(call)}${timing ? ` · ${timing}` : ""}`));
			if (call.error) lines.push(fit(theme.fg("error", `  ${clean(call.error)}`)));
		}
		if (calls.length < snapshot.calls.length) lines.push(fit(theme.fg("muted", `… ${snapshot.calls.length - calls.length} more calls; open details`)));
	} else {
		const failures = snapshot.calls.filter((call) => call.status === "error" || call.status === "cancelled");
		for (const call of failures.slice(0, 2)) lines.push(fit(theme.fg("error", `! ${clean(call.name)}: ${clean(call.error ?? call.status)}`)));
		if (failures.length > 2) lines.push(fit(theme.fg("error", `… ${failures.length - 2} more failed/cancelled calls`)));
	}
	// A caught child error does not necessarily fail the script. A script error may
	// occur after a long partial output, so surface its tail before the preview.
	const scriptError = options.isError ? snapshot.output.match(/(?:^|\n)Script error:\s*([\s\S]*)$/)?.[1] : undefined;
	if (scriptError && !options.expanded) lines.push(fit(theme.fg("error", `! ${clean(scriptError).slice(0, 500)}`)));
	if (snapshot.output) {
		lines.push(...boundedRows(sanitizeDetailText(snapshot.output).split("\n"), options.expanded ? options.maxRows ?? 4000 : 3, safeWidth).map((line) => fit(theme.fg("toolOutput", line))));
	}
	if (snapshot.fullOutputPath) lines.push(fit(theme.fg("muted", `Full output: ${shortenPath(snapshot.fullOutputPath)}`)));
	return lines;
}

function component(render: (width: number) => string[]): Component { return { render, invalidate() {} }; }

export function registerCodemodeRenderer(pi: ExtensionAPI, getConfig: () => ToolDisplayConfig): void {
	pi.registerToolRenderer((name, next) => {
		const config = getConfig();
		if (name !== "codemode" || config.passthroughToolNames.includes(name)) return next();
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				const codeSource = (args as { code?: unknown })?.code;
				return component((width) => {
					const pad = Math.min(Math.max(0, Math.floor(context.outputPad ?? 0)), Math.max(0, width - 1));
					const innerWidth = Math.max(0, width - pad);
					if (!innerWidth) return [];
					const snapshot = context.state.codemodeSnapshot as CodemodeSnapshot | undefined;
					const failed = context.isError || snapshot?.calls.some((call) => call.status === "error" || call.status === "cancelled");
					const color = failed ? "error" : snapshot && !context.isPartial ? "success" : "warning";
					const summary = snapshot ? theme.fg("muted", ` · ${codemodeCallSummary(snapshot.calls)}`) : "";
					const title = `${theme.fg(color, failed ? "!" : "●")} ${theme.fg("toolTitle", theme.bold("Codemode"))}${summary}`;
					const lines = [truncateToWidth(title, innerWidth, "…")];
					if (context.expanded && typeof codeSource === "string") {
						let code: string[];
						const source = sanitizeDetailText(codeSource.slice(0, 128 * 1024), false);
						try { code = highlightCode(source, "javascript"); } catch { code = source.split("\n"); }
						lines.push(...boundedRows(code, getConfig().expandedPreviewMaxRows, innerWidth));
						if (source.length < codeSource.length) lines.push(truncateToWidth("… script preview truncated", innerWidth, "…"));
					}
					return lines.map((line) => " ".repeat(pad) + truncateToWidth(line, innerWidth, "…"));
				});
			},
			renderResult(result, options, theme, context) {
				const snapshot = readCodemodeSnapshot(result);
				context.state.codemodeSnapshot = snapshot;
				return component((width) => {
					const prefix = " ".repeat(Math.min(Math.max(0, Math.floor(context.outputPad ?? 0)) + 2, Math.max(0, width - 1)));
					return renderCodemodeSnapshot(snapshot, Math.max(0, width - visibleWidth(prefix)), theme, {
						expanded: options.expanded, partial: options.isPartial, isError: context.isError,
						durationMs: context.durationMs, maxRows: getConfig().expandedPreviewMaxRows,
					}).slice(1).map((line) => prefix + line);
				});
			},
		};
	});
}
