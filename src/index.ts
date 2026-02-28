import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type LensAction = "keep" | "summarize" | "dismiss";
type LensMode = "piggyback" | "external-model";

interface LensConfig {
	enabled: boolean;
	mode: LensMode;
	tools: string[];
	minCharsToScore: number;
	editedFileProtectionTurns: number;
	dryRun: boolean;
	stats: boolean;
}

interface LensDecision {
	toolCallId: string;
	action: LensAction;
	summary?: string;
	timestamp: number;
}

interface MessageTextBlock {
	type?: string;
	text?: string;
}

const DEFAULT_CONFIG: LensConfig = {
	enabled: true,
	mode: "piggyback",
	tools: ["read", "grep", "bash"],
	minCharsToScore: 2000,
	editedFileProtectionTurns: 4,
	dryRun: false,
	stats: true,
};

const CUSTOM_ENTRY_TYPE = "context_lens_decision";
const BLOCK_REGEX = /<context_lens>([\s\S]*?)<\/context_lens>/g;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const extractTextLength = (content: unknown): number => {
	if (typeof content === "string") {
		return content.length;
	}

	if (!Array.isArray(content)) {
		return 0;
	}

	let total = 0;
	for (const part of content) {
		if (!isObject(part)) {
			continue;
		}
		if (part.type === "text" && typeof part.text === "string") {
			total += part.text.length;
		}
	}
	return total;
};

const parseDecisionPayload = (payload: unknown): LensDecision | null => {
	if (!isObject(payload)) {
		return null;
	}
	const toolCallId = payload.toolCallId;
	const action = payload.action;
	const summary = payload.summary;
	if (typeof toolCallId !== "string") {
		return null;
	}
	if (action !== "keep" && action !== "summarize" && action !== "dismiss") {
		return null;
	}
	if (summary !== undefined && typeof summary !== "string") {
		return null;
	}
	return {
		toolCallId,
		action,
		summary,
		timestamp: Date.now(),
	};
};

const parseDecisionsFromText = (text: string): LensDecision[] => {
	const decisions: LensDecision[] = [];
	for (const match of text.matchAll(BLOCK_REGEX)) {
		const payload = match[1]?.trim();
		if (!payload) {
			continue;
		}
		try {
			const parsed = JSON.parse(payload);
			const decision = parseDecisionPayload(parsed);
			if (decision) {
				decisions.push(decision);
			}
		} catch {
			// fail-safe: ignore malformed block and keep context unchanged
		}
	}
	return decisions;
};

const stripBlocks = (text: string): string =>
	text
		.replace(BLOCK_REGEX, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

const loadConfig = (): LensConfig => {
	const configPath = join(homedir(), ".pi", "agent", "context-lens.json");
	if (!existsSync(configPath)) {
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(raw);
		if (!isObject(parsed)) {
			return { ...DEFAULT_CONFIG };
		}
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_CONFIG.enabled,
			mode:
				parsed.mode === "piggyback" || parsed.mode === "external-model"
					? parsed.mode
					: DEFAULT_CONFIG.mode,
			tools: Array.isArray(parsed.tools)
				? parsed.tools.filter((tool): tool is string => typeof tool === "string")
				: DEFAULT_CONFIG.tools,
			minCharsToScore:
				typeof parsed.minCharsToScore === "number" ? parsed.minCharsToScore : DEFAULT_CONFIG.minCharsToScore,
			editedFileProtectionTurns:
				typeof parsed.editedFileProtectionTurns === "number"
					? parsed.editedFileProtectionTurns
					: DEFAULT_CONFIG.editedFileProtectionTurns,
			dryRun: typeof parsed.dryRun === "boolean" ? parsed.dryRun : DEFAULT_CONFIG.dryRun,
			stats: typeof parsed.stats === "boolean" ? parsed.stats : DEFAULT_CONFIG.stats,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
};

const getFilePathFromInput = (input: Record<string, unknown>): string | undefined => {
	if (typeof input.path === "string") {
		return input.path;
	}
	if (typeof input.filePath === "string") {
		return input.filePath;
	}
	return undefined;
};

export default function contextLens(pi: ExtensionAPI) {
	let config = loadConfig();
	const decisions = new Map<string, LensDecision>();
	const pendingToolCallIds = new Set<string>();
	const protectedFiles = new Map<string, number>();
	let currentTurn = 0;
	let totalCharsSaved = 0;
	let decisionsAppliedCount = 0;

	const rebuildDecisions = (ctx: { sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> } }) => {
		decisions.clear();
		pendingToolCallIds.clear();
		protectedFiles.clear();
		currentTurn = 0;
		totalCharsSaved = 0;
		decisionsAppliedCount = 0;

		const branch = ctx.sessionManager.getBranch();
		for (const entry of branch) {
			if (entry.type !== "custom") {
				continue;
			}
			if (entry.customType !== CUSTOM_ENTRY_TYPE) {
				continue;
			}
			const decision = parseDecisionPayload(entry.data);
			if (decision) {
				decisions.set(decision.toolCallId, decision);
			}
		}
	};

	const shouldProtectFile = (toolName: string, input: Record<string, unknown>): boolean => {
		if (toolName !== "read") {
			return false;
		}
		const path = getFilePathFromInput(input);
		if (!path) {
			return false;
		}
		const editedTurn = protectedFiles.get(path);
		if (editedTurn === undefined) {
			return false;
		}
		return currentTurn - editedTurn <= config.editedFileProtectionTurns;
	};

	pi.registerCommand("context-lens-stats", {
		description: "Show basic pi-context-lens runtime stats",
		handler: async (_args, ctx) => {
			const lines = [
				`mode=${config.mode}`,
				`enabled=${String(config.enabled)}`,
				`pending=${pendingToolCallIds.size}`,
				`decisions=${decisions.size} (${decisionsAppliedCount} applied)`,
				`chars saved≈${totalCharsSaved}`,
			];
			ctx.ui.notify(`[context-lens] ${lines.join(" | ")}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		rebuildDecisions(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		config = loadConfig();
		rebuildDecisions(ctx);
	});

	pi.on("turn_start", (event) => {
		currentTurn = event.turnIndex;
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "edit" && event.toolName !== "write") {
			return;
		}
		if (!isObject(event.args)) {
			return;
		}
		const path = getFilePathFromInput(event.args);
		if (!path) {
			return;
		}
		protectedFiles.set(path, currentTurn);
	});

	pi.on("tool_result", (event) => {
		if (!config.enabled || config.mode !== "piggyback") {
			return;
		}
		if (event.isError) {
			return;
		}
		if (!config.tools.includes(event.toolName)) {
			return;
		}
		if (shouldProtectFile(event.toolName, event.input)) {
			return;
		}
		const size = extractTextLength(event.content);
		if (size < config.minCharsToScore) {
			return;
		}
		pendingToolCallIds.add(event.toolCallId);
	});

	const buildScoringInstruction = (ids: string[]): string =>
		[
			"[context-lens scoring task]",
			"After completing your normal response, score each listed tool result for relevance to the current task.",
			"Emit one <context_lens> JSON block per toolCallId, at the END of your message.",
			"",
			"Schema: <context_lens>{\"toolCallId\":\"...\",\"action\":\"keep|summarize|dismiss\",\"summary\":\"...\"}</context_lens>",
			"",
			"Actions:",
			"- keep: content is directly relevant to what you're working on (e.g., file you'll modify, key API you're calling). No summary needed.",
			"- summarize: partially relevant or large. Provide a concise summary: file path, key exports/functions, why it matters (2-4 lines).",
			"- dismiss: not relevant. Provide a one-line reason (e.g., \"test fixtures for unrelated module\").",
			"",
			"Bias toward summarize over keep — you can always re-read the file. When uncertain, keep.",
			`toolCallIds to score: ${ids.join(", ")}`,
		].join("\n");

	pi.on("message_end", (event) => {
		if (!config.enabled || config.mode !== "piggyback") {
			return;
		}
		if (event.message.role !== "assistant") {
			return;
		}

		const content = event.message.content;
		if (typeof content === "string") {
			const parsed = parseDecisionsFromText(content);
			for (const decision of parsed) {
				decisions.set(decision.toolCallId, decision);
				if (!config.dryRun) {
					pi.appendEntry(CUSTOM_ENTRY_TYPE, decision);
				}
			}
			event.message.content = [{ type: "text", text: stripBlocks(content) }];
			return;
		}

		if (!Array.isArray(content)) {
			return;
		}

		for (const block of content as MessageTextBlock[]) {
			if (block?.type !== "text" || typeof block.text !== "string") {
				continue;
			}
			const parsed = parseDecisionsFromText(block.text);
			for (const decision of parsed) {
				decisions.set(decision.toolCallId, decision);
				if (!config.dryRun) {
					pi.appendEntry(CUSTOM_ENTRY_TYPE, decision);
				}
			}
			block.text = stripBlocks(block.text);
		}
	});

	pi.on("context", (event) => {
		if (!config.enabled || config.mode !== "piggyback") {
			return;
		}

		let changed = false;

		if (pendingToolCallIds.size > 0) {
			const ids = Array.from(pendingToolCallIds);
			pendingToolCallIds.clear();
			event.messages.push({
				role: "user",
				content: [{ type: "text", text: buildScoringInstruction(ids) }],
				timestamp: Date.now(),
			});
			changed = true;
		}

		if (decisions.size > 0) {
			for (const msg of event.messages) {
				if (!isObject(msg)) {
					continue;
				}
				if (msg.role !== "toolResult") {
					continue;
				}
				const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
				if (!toolCallId) {
					continue;
				}
				const decision = decisions.get(toolCallId);
				if (!decision || decision.action === "keep") {
					continue;
				}
				const summary = (decision.summary || "Not relevant to current task.").trim();
				const originalLength = extractTextLength(msg.content);
				msg.content = [{ type: "text", text: summary }];
				totalCharsSaved += Math.max(0, originalLength - summary.length);
				changed = true;
			}
			if (changed) {
				decisionsAppliedCount++;
			}
		}

		if (changed) {
			return { messages: event.messages };
		}
	});
}
