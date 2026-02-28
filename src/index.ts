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

interface DecisionEntry {
	toolCallId?: unknown;
	action?: unknown;
	summary?: unknown;
	timestamp?: unknown;
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
	let transformedCount = 0;

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
				`decisions=${decisions.size}`,
				`transformed=${transformedCount}`,
			];
			ctx.ui.notify(`[context-lens] ${lines.join(" | ")}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		decisions.clear();
		pendingToolCallIds.clear();
		protectedFiles.clear();
		currentTurn = 0;
		transformedCount = 0;

		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type !== "custom") {
				continue;
			}
			if (entry.customType !== CUSTOM_ENTRY_TYPE) {
				continue;
			}
			const data = (entry as { data?: DecisionEntry }).data;
			const decision = parseDecisionPayload(data);
			if (!decision) {
				continue;
			}
			decisions.set(decision.toolCallId, decision);
		}
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

	pi.on("before_agent_start", (event) => {
		if (!config.enabled || config.mode !== "piggyback") {
			return;
		}
		if (pendingToolCallIds.size === 0) {
			return;
		}

		const ids = Array.from(pendingToolCallIds);
		const instruction = [
			"",
			"[context-lens scoring task]",
			"After your normal response, emit one <context_lens> JSON block for each listed toolCallId.",
			"Schema: {\"toolCallId\":\"...\",\"action\":\"keep|summarize|dismiss\",\"summary\":\"...\"}",
			"Rules:",
			"- keep: highly relevant; no summary required",
			"- summarize: relevant but compressible; include concise summary",
			"- dismiss: irrelevant; include one-line reason",
			"- Fail-safe: if uncertain, use keep.",
			`toolCallIds: ${ids.join(", ")}`,
			"Use exactly this wrapper: <context_lens>{json}</context_lens>",
		].join("\n");

		pendingToolCallIds.clear();

		return {
			systemPrompt: `${event.systemPrompt}\n${instruction}`,
		};
	});

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
		if (decisions.size === 0) {
			return;
		}

		let changed = false;
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
			msg.content = [{ type: "text", text: summary }];
			changed = true;
			transformedCount++;
		}

		if (changed) {
			return { messages: event.messages };
		}
	});
}
