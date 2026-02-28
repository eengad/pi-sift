import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import contextLens from "./index.js";

type Handler = (event: any, ctx?: any) => any;

class FakePi {
	public handlers = new Map<string, Handler[]>();
	public appended: Array<{ customType: string; data: unknown }> = [];
	public commands = new Map<string, { handler: Handler }>();

	on(eventName: string, handler: Handler) {
		const list = this.handlers.get(eventName) || [];
		list.push(handler);
		this.handlers.set(eventName, list);
	}

	registerCommand(name: string, command: { handler: Handler }) {
		this.commands.set(name, command);
	}

	appendEntry(customType: string, data?: unknown) {
		this.appended.push({ customType, data });
	}

	emit(eventName: string, event: any, ctx?: any): any[] {
		const handlers = this.handlers.get(eventName) || [];
		const out: any[] = [];
		for (const handler of handlers) {
			out.push(handler(event, ctx));
		}
		return out;
	}
}

describe("phase-1 flow validation", () => {
	let oldHome: string | undefined;
	let tempHome: string;

	beforeEach(() => {
		oldHome = process.env.HOME;
		tempHome = mkdtempSync(join(tmpdir(), "context-lens-test-"));
		process.env.HOME = tempHome;
		mkdirSync(join(tempHome, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(tempHome, ".pi", "agent", "context-lens.json"),
			JSON.stringify({
				enabled: true,
				mode: "piggyback",
				tools: ["read"],
				minCharsToScore: 20,
				editedFileProtectionTurns: 4,
				dryRun: false,
				stats: true,
			}),
			"utf8",
		);
	});

	afterEach(() => {
		if (oldHome !== undefined) {
			process.env.HOME = oldHome;
		}
		rmSync(tempHome, { recursive: true, force: true });
	});

	it("scores, strips, persists and applies decisions", () => {
		const pi = new FakePi();
		contextLens(pi as any);

		const sessionCtx = {
			sessionManager: {
				getBranch: () => [],
			},
		};

		pi.emit("session_start", { type: "session_start" }, sessionCtx);

		pi.emit("tool_result", {
			type: "tool_result",
			toolCallId: "tc-1",
			toolName: "read",
			input: { path: "src/foo.ts" },
			content: [{ type: "text", text: "x".repeat(100) }],
			isError: false,
		});

		const injected = pi.emit("context", {
			type: "context",
			messages: [
				{
					role: "toolResult",
					toolCallId: "tc-1",
					content: [{ type: "text", text: "VERY LONG CONTENT" }],
				},
			],
		})[0];

		assert.ok(injected);
		const injectedUser = injected.messages.find((m: any) => m.role === "user");
		assert.ok(injectedUser);
		assert.match(injectedUser.content[0].text, /context-lens scoring task/);
		assert.match(injectedUser.content[0].text, /tc-1/);

		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: [
						"I checked the file.",
						'<context_lens>{"toolCallId":"tc-1","action":"dismiss","summary":"legacy helpers; unrelated to auth"}</context_lens>',
					].join("\n"),
				},
			],
		};

		pi.emit("message_end", { type: "message_end", message: assistantMessage });

		assert.equal(pi.appended.length, 1);
		assert.equal(pi.appended[0]?.customType, "context_lens_decision");
		assert.deepEqual(pi.appended[0]?.data, {
			toolCallId: "tc-1",
			action: "dismiss",
			summary: "legacy helpers; unrelated to auth",
			timestamp: (pi.appended[0]?.data as any).timestamp,
		});
		assert.ok(!String((assistantMessage.content[0] as any).text).includes("<context_lens>"));

		const contextEvent = {
			type: "context",
			messages: [
				{
					role: "toolResult",
					toolCallId: "tc-1",
					content: [{ type: "text", text: "VERY LONG CONTENT" }],
				},
			],
		};

		const contextResult = pi.emit("context", contextEvent)[0];
		assert.ok(contextResult);
		assert.equal(contextResult.messages[0].content[0].text, "legacy helpers; unrelated to auth");
	});

	it("rebuilds decisions on session switch using current branch only", () => {
		const pi = new FakePi();
		contextLens(pi as any);

		const ctxA = {
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "context_lens_decision",
						data: { toolCallId: "tc-A", action: "dismiss", summary: "A only" },
					},
				],
			},
		};

		const ctxB = {
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "context_lens_decision",
						data: { toolCallId: "tc-B", action: "dismiss", summary: "B only" },
					},
				],
			},
		};

		pi.emit("session_start", { type: "session_start" }, ctxA);

		let result = pi.emit("context", {
			type: "context",
			messages: [{ role: "toolResult", toolCallId: "tc-A", content: [{ type: "text", text: "raw" }] }],
		})[0];
		assert.equal(result.messages[0].content[0].text, "A only");

		pi.emit("session_switch", { type: "session_switch" }, ctxB);

		result = pi.emit("context", {
			type: "context",
			messages: [{ role: "toolResult", toolCallId: "tc-A", content: [{ type: "text", text: "rawA" }] }],
		})[0];
		assert.equal(result, undefined);

		result = pi.emit("context", {
			type: "context",
			messages: [{ role: "toolResult", toolCallId: "tc-B", content: [{ type: "text", text: "rawB" }] }],
		})[0];
		assert.equal(result.messages[0].content[0].text, "B only");
	});
});
