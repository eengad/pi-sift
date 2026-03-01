import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTextLength, parseDecisionPayload, parseDecisionsFromText, stripBlocks, extractText } from "./index.js";

describe("extractTextLength", () => {
	it("handles plain string", () => { assert.equal(extractTextLength("hello"), 5); });
	it("handles content array", () => { assert.equal(extractTextLength([{ type: "text", text: "hello world" }]), 11); });
	it("skips non-text blocks", () => { assert.equal(extractTextLength([{ type: "image", source: "abc" }, { type: "text", text: "hi" }]), 2); });
	it("returns 0 for null/undefined", () => { assert.equal(extractTextLength(null), 0); assert.equal(extractTextLength(undefined), 0); });
	it("returns 0 for empty array", () => { assert.equal(extractTextLength([]), 0); });
});

describe("extractText", () => {
	it("extracts from string", () => { assert.equal(extractText("hello"), "hello"); });
	it("extracts from content array", () => { assert.equal(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb"); });
	it("returns empty for non-array/string", () => { assert.equal(extractText(42), ""); });
});

describe("parseDecisionPayload", () => {
	it("parses valid keep", () => { const d = parseDecisionPayload({ toolCallId: "tc-1", action: "keep" }); assert.ok(d); assert.equal(d.action, "keep"); });
	it("parses valid summarize", () => { const d = parseDecisionPayload({ toolCallId: "tc-2", action: "summarize", summary: "Short" }); assert.ok(d); assert.equal(d.summary, "Short"); });
	it("parses valid dismiss", () => { const d = parseDecisionPayload({ toolCallId: "tc-3", action: "dismiss", summary: "Not relevant" }); assert.ok(d); assert.equal(d.action, "dismiss"); });
	it("rejects missing toolCallId", () => { assert.equal(parseDecisionPayload({ action: "keep" }), null); });
	it("rejects invalid action", () => { assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "remove" }), null); });
	it("rejects non-string summary", () => { assert.equal(parseDecisionPayload({ toolCallId: "tc-1", action: "summarize", summary: 123 }), null); });
	it("rejects non-object", () => { assert.equal(parseDecisionPayload("nope"), null); assert.equal(parseDecisionPayload(null), null); });
});

describe("parseDecisionsFromText", () => {
	it("parses single block", () => {
		const d = parseDecisionsFromText('text <context_lens>{"toolCallId":"tc-1","action":"keep"}</context_lens> more');
		assert.equal(d.length, 1);
		assert.equal(d[0].action, "keep");
	});
	it("parses multiple blocks", () => {
		const d = parseDecisionsFromText('<context_lens>{"toolCallId":"a","action":"keep"}</context_lens><context_lens>{"toolCallId":"b","action":"dismiss","summary":"x"}</context_lens>');
		assert.equal(d.length, 2);
	});
	it("ignores malformed JSON", () => { assert.equal(parseDecisionsFromText("<context_lens>not json</context_lens>").length, 0); });
	it("ignores empty block", () => { assert.equal(parseDecisionsFromText("<context_lens></context_lens>").length, 0); });
	it("ignores invalid schema", () => { assert.equal(parseDecisionsFromText('<context_lens>{"action":"nope"}</context_lens>').length, 0); });
	it("returns empty for no blocks", () => { assert.equal(parseDecisionsFromText("just text").length, 0); });
	it("handles multiline JSON", () => {
		const d = parseDecisionsFromText('<context_lens>{\n"toolCallId":"tc-1",\n"action":"summarize",\n"summary":"test"\n}</context_lens>');
		assert.equal(d.length, 1);
	});
});

describe("stripBlocks", () => {
	it("removes single block", () => { assert.equal(stripBlocks("before <context_lens>{}</context_lens> after"), "before  after"); });
	it("removes multiple", () => { assert.ok(!stripBlocks("<context_lens>a</context_lens><context_lens>b</context_lens>").includes("context_lens")); });
	it("collapses newlines", () => { assert.ok(!stripBlocks("a\n\n\n\n\nb").includes("\n\n\n")); });
	it("trims", () => { assert.equal(stripBlocks("  text  "), "text"); });
});

describe("Mode A inline marker flow", () => {
	it("marks large tool results and strips decisions from responses", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		// session_start
		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		// No before_agent_start — scoring instructions are inline with markers now

		// tool_result with large content — should prepend marker
		let trResult: any;
		for (const h of handlers.get("tool_result") || []) {
			trResult = h({
				type: "tool_result", toolCallId: "tc-1", toolName: "read",
				input: { path: "/big/file.py" }, content: [{ type: "text", text: "x".repeat(5000) }], isError: false,
			}, {});
		}
		assert.ok(trResult);
		const markedText = trResult.content[0].text;
		assert.ok(markedText.startsWith("[CONTEXT_LENS_SCORE:tc-1]"));
		assert.ok(markedText.includes("This result is 5000 chars."));
		assert.ok(markedText.includes("x".repeat(100))); // original content preserved

		// context hook should inject scoring instruction in control message lane
		const scoringMsgs = [
			{ role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "x".repeat(5000) }] },
		];
		let scoringCtx: any;
		for (const h of handlers.get("context") || []) {
			scoringCtx = h({ messages: scoringMsgs }, {});
		}
		assert.ok(scoringCtx);
		const injected = scoringCtx.messages[scoringCtx.messages.length - 1];
		assert.equal(injected.role, "user");
		assert.ok(String(injected.content[0].text).includes("toolCallIds to score: tc-1"));

		// message_end with context_lens block — should parse & persist but NOT strip content
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: 'Here is my analysis.\n\n<context_lens>{"toolCallId":"tc-1","action":"summarize","summary":"Big file with 5 classes."}</context_lens>' }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg }, {});
		}
		// Content must remain unmodified (no stripping) to preserve thinking block integrity
		assert.ok(assistantMsg.content[0].text.includes("context_lens"), "message_end must NOT strip context_lens blocks");
		assert.ok(assistantMsg.content[0].text.includes("analysis"));
		assert.equal(appended.length, 1);
		assert.equal((appended[0].data as any).action, "summarize");

		// context hook — should replace tc-1 with summary AND strip blocks from older assistant msgs
		const contextMsgs = [
			{ role: "user", content: [{ type: "text", text: "do something" }] },
			// older assistant message with leftover context_lens block
			{ role: "assistant", content: [{ type: "text", text: 'Analysis.\n\n<context_lens>{"toolCallId":"tc-1","action":"summarize","summary":"Big file with 5 classes."}</context_lens>' }] },
			{ role: "toolResult", toolCallId: "tc-1", content: [{ type: "text", text: "x".repeat(5000) }] },
			// latest assistant message — must NOT be stripped
			{ role: "assistant", content: [{ type: "text", text: 'Latest reply <context_lens>{"toolCallId":"tc-99","action":"keep"}</context_lens>' }] },
		];
		let ctxResult: any;
		for (const h of handlers.get("context") || []) {
			ctxResult = h({ messages: contextMsgs }, {});
		}
		assert.ok(ctxResult);
		// tool result replaced with summary
		assert.equal(ctxResult.messages[2].content[0].text, "Big file with 5 classes.");
		// older assistant message stripped
		assert.ok(!ctxResult.messages[1].content[0].text.includes("context_lens"), "older assistant msg should be stripped");
		assert.ok(ctxResult.messages[1].content[0].text.includes("Analysis"), "non-block text preserved");
		// latest assistant message left intact
		assert.ok(ctxResult.messages[3].content[0].text.includes("context_lens"), "latest assistant msg must NOT be stripped");
	});

	it("preserves thinking blocks in latest assistant message", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		// Simulate extended-thinking assistant message: [thinking, text_with_block, thinking, text]
		const thinkingMsg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Let me analyze this..." },
				{ type: "text", text: '<context_lens>{"toolCallId":"tc-5","action":"dismiss","summary":"irrelevant"}</context_lens>' },
				{ type: "thinking", thinking: "Now continuing..." },
				{ type: "text", text: "Final answer here." },
			],
		};

		// message_end should parse the decision but leave ALL content intact
		for (const h of handlers.get("message_end") || []) {
			h({ message: thinkingMsg }, {});
		}
		assert.equal(appended.length, 1, "decision parsed and persisted");
		assert.equal((appended[0].data as any).action, "dismiss");
		// Content must be completely unmodified
		assert.equal(thinkingMsg.content.length, 4, "all 4 blocks preserved");
		assert.equal(thinkingMsg.content[0].type, "thinking");
		assert.ok(thinkingMsg.content[1].text!.includes("context_lens"), "text block not stripped by message_end");
		assert.equal(thinkingMsg.content[2].type, "thinking");
		assert.equal(thinkingMsg.content[3].text, "Final answer here.");

		// context handler: older assistant with thinking blocks gets stripped; latest does not
		const olderThinkingMsg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "old thinking" },
				{ type: "text", text: '<context_lens>{"toolCallId":"tc-old","action":"keep"}</context_lens>' },
				{ type: "thinking", thinking: "more old thinking" },
				{ type: "text", text: "old answer" },
			],
		};
		const latestThinkingMsg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "latest thinking" },
				{ type: "text", text: '<context_lens>{"toolCallId":"tc-new","action":"keep"}</context_lens> result' },
			],
		};
		const contextMsgs = [
			{ role: "user", content: [{ type: "text", text: "question" }] },
			olderThinkingMsg,
			{ role: "user", content: [{ type: "text", text: "follow up" }] },
			latestThinkingMsg,
		];
		let ctxResult: any;
		for (const h of handlers.get("context") || []) {
			ctxResult = h({ messages: contextMsgs }, {});
		}
		assert.ok(ctxResult, "context handler returned modified messages");

		// Older assistant: text blocks stripped, empty ones removed, thinking blocks untouched
		const olderContent = ctxResult.messages[1].content;
		const olderThinkingBlocks = olderContent.filter((b: any) => b.type === "thinking");
		assert.equal(olderThinkingBlocks.length, 2, "thinking blocks preserved in older msg");
		const olderTextBlocks = olderContent.filter((b: any) => b.type === "text");
		for (const block of olderTextBlocks) {
			assert.ok(!block.text.includes("context_lens"), "context_lens stripped from older msg text blocks");
		}
		// The first text block was only context_lens content → should be removed as empty
		assert.equal(olderTextBlocks.length, 1, "empty text block removed after stripping");
		assert.equal(olderTextBlocks[0].text, "old answer");

		// Latest assistant: completely untouched
		const latestContent = ctxResult.messages[3].content;
		assert.equal(latestContent.length, 2, "latest msg blocks untouched");
		assert.equal(latestContent[0].type, "thinking");
		assert.ok(latestContent[1].text.includes("context_lens"), "latest msg text not stripped");
	});

	it("falls back to deterministic keep when assistant does tool-call-only turns", async () => {
		const { default: piSift } = await import("./index.js");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const appended: Array<{ type: string; data: unknown }> = [];
		const fakePi = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			registerCommand() {},
			appendEntry(customType: string, data: unknown) { appended.push({ type: customType, data }); },
		};
		piSift(fakePi as any);

		for (const h of handlers.get("session_start") || []) h({}, { sessionManager: { getBranch: () => [] } });

		for (const h of handlers.get("tool_result") || []) {
			h({
				type: "tool_result",
				toolCallId: "tc-auto-1|fc_suffix",
				toolName: "read",
				input: { path: "/tmp/huge.py" },
				content: [{ type: "text", text: "x".repeat(6000) }],
				isError: false,
			}, {});
		}

		const assistantMsg1 = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "foo.py" } }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg1 }, {});
		}
		// After 1 assistant message, fallback should NOT fire yet (context hook needs a turn)
		assert.equal(appended.length, 0);

		const assistantMsg2 = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "bar.py" } }],
		};
		for (const h of handlers.get("message_end") || []) {
			h({ message: assistantMsg2 }, {});
		}

		assert.equal(appended.length, 1);
		const decision = appended[0].data as any;
		assert.equal(decision.toolCallId, "tc-auto-1");
		assert.equal(decision.action, "keep");
		assert.equal(decision.summary, undefined);

		const contextMsgs = [
			{ role: "toolResult", toolCallId: "tc-auto-1|fc_suffix", content: [{ type: "text", text: "x".repeat(6000) }] },
		];
		let ctxResult: any;
		for (const h of handlers.get("context") || []) {
			ctxResult = h({ messages: contextMsgs }, {});
		}
		assert.equal(ctxResult, undefined);
		assert.equal((contextMsgs[0] as any).content[0].text.length, 6000);
	});
});
