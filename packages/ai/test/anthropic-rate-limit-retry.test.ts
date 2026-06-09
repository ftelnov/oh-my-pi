import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamAnthropic } from "../src/providers/anthropic";
import type { AnthropicMessagesClientLike } from "../src/providers/anthropic-client";
import type { Context, Model, ModelSpec } from "../src/types";
import { getRetryAfterMsFromError } from "../src/utils/retry-after";

const modelSpec: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};
const model: Model<"anthropic-messages"> = buildModel(modelSpec);

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;
type MockAnthropicStream = AsyncIterable<MockAnthropicEvent>;
type MockAnthropicRequest = {
	withResponse(): Promise<{ data: MockAnthropicStream; response: Response; request_id: string | null }>;
};

function createSuccessStream(text: string): MockAnthropicRequest {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_ok" } });
	const stream: MockAnthropicStream = {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "message_start",
				message: {
					id: "msg_ok",
					usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			};
			yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
			yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
			yield { type: "content_block_stop", index: 0 };
			yield {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			};
			yield { type: "message_stop" };
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: "req_ok" };
		},
	};
}

function createRateLimitError(retryAfterMs: number): Error {
	return new Error(
		`429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}} retry-after-ms=${retryAfterMs}`,
	);
}

function createRateLimitErrorViaHeaders(retryAfterSeconds: number): Error {
	const err = new Error("429 Rate limit exceeded") as Error & { headers: Record<string, string> };
	err.headers = { "retry-after": String(retryAfterSeconds) };
	return err;
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// getRetryAfterMsFromError
// ─────────────────────────────────────────────────────────────────────────────
describe("getRetryAfterMsFromError", () => {
	it("extracts retry-after-ms from error message hint", () => {
		expect(getRetryAfterMsFromError(new Error("429 rate limit retry-after-ms=5000"))).toBe(5000);
	});

	it("extracts retry-after from .headers property (seconds → ms)", () => {
		const err = createRateLimitErrorViaHeaders(10);
		expect(getRetryAfterMsFromError(err)).toBe(10_000);
	});

	it("prefers headers over message hint", () => {
		const err = createRateLimitErrorViaHeaders(2) as Error & { message: string };
		err.message = `${err.message} retry-after-ms=99999`;
		// headers say 2s; message hint says 99999ms — headers win
		expect(getRetryAfterMsFromError(err)).toBe(2_000);
	});

	it("returns undefined when neither source is present", () => {
		expect(getRetryAfterMsFromError(new Error("429 rate limit exceeded"))).toBeUndefined();
	});

	it("returns undefined for non-Error values", () => {
		expect(getRetryAfterMsFromError("not an error")).toBeUndefined();
		expect(getRetryAfterMsFromError(null)).toBeUndefined();
		expect(getRetryAfterMsFromError({ message: "retry-after-ms=5000" })).toBeUndefined();
	});

	it("returns undefined for zero or negative hint values", () => {
		expect(getRetryAfterMsFromError(new Error("retry-after-ms=0"))).toBeUndefined();
		expect(getRetryAfterMsFromError(new Error("retry-after-ms=-100"))).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// streamAnthropic rate-limit retry
// ─────────────────────────────────────────────────────────────────────────────
describe("streamAnthropic rate-limit retry", () => {
	it("honors mandatory retry-after on first 429 then succeeds", async () => {
		let attempt = 0;
		const create = ((_body: unknown, _opts?: { signal?: AbortSignal }) => {
			attempt++;
			if (attempt === 1) {
				return {
					async withResponse() {
						throw createRateLimitError(3000);
					},
				} as never;
			}
			return createSuccessStream("recovered") as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];

		const delays: number[] = [];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (ms: number) => {
			delays.push(ms);
		});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		// Should have retried once after the mandatory 3000ms wait
		expect(attempt).toBe(2);
		expect(delays).toEqual([3000]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("uses exponential backoff within 5-minute budget on subsequent rate-limit errors", async () => {
		// First 429 with retry-after=500ms, second 429 without retry-after (no header/hint)
		let attempt = 0;
		const create = ((_body: unknown) => {
			attempt++;
			if (attempt === 1) {
				return {
					async withResponse() {
						throw createRateLimitError(500);
					},
				} as never;
			}
			if (attempt === 2) {
				// Second attempt: rate-limit without retry-after (triggers exponential backoff)
				return {
					async withResponse() {
						throw new Error("429 rate limit exceeded");
					},
				} as never;
			}
			return createSuccessStream("ok") as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];

		const delays: number[] = [];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (ms: number) => {
			delays.push(ms);
		});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		expect(attempt).toBe(3);
		expect(delays).toHaveLength(2);
		// First delay: mandatory retry-after 500ms
		expect(delays[0]).toBe(500);
		// Second delay: exponential backoff attempt 0 → 1000ms (base * 2^0)
		expect(delays[1]).toBe(1000);
		expect(result.stopReason).toBe("stop");
	});

	it("does not enter rate-limit path for errors without retry-after (falls through to generic retry)", async () => {
		let attempt = 0;
		const create = ((_body: unknown) => {
			attempt++;
			if (attempt <= 2) {
				// Rate limit error but NO retry-after hint — goes through generic path
				return {
					async withResponse() {
						throw new Error("429 rate limit exceeded");
					},
				} as never;
			}
			return createSuccessStream("generic retry ok") as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];

		const delays: number[] = [];
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (ms: number) => {
			delays.push(ms);
		});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		expect(attempt).toBe(3);
		// No retry-after + no open rate-limit budget → generic transient-retry path,
		// not the rate-limit exponential backoff (whose fixed base delay is 1000ms).
		// The generic path applies jittered backoff via calculateAnthropicRetryDelayMs,
		// so the first delay stays below 1000ms and each retry grows.
		expect(delays).toHaveLength(2);
		expect(delays[0]).toBeLessThan(1000);
		expect(delays[1]).toBeGreaterThan(delays[0]);
		expect(result.stopReason).toBe("stop");
	});

	it("throws immediately when a subsequent retry-after would exceed the 5-minute budget", async () => {
		// First 429: retry-after=100ms (sets budget to now+5min)
		// Second 429: retry-after=400_000ms (exceeds 5-min budget)
		let attempt = 0;
		const create = ((_body: unknown) => {
			attempt++;
			if (attempt === 1) {
				return {
					async withResponse() {
						throw createRateLimitError(100);
					},
				} as never;
			}
			// Second attempt still rate-limited with a huge retry-after
			return {
				async withResponse() {
					throw createRateLimitError(400_000);
				},
			} as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];

		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async () => {});

		const result = await streamAnthropic(model, context, { client, providerRetryWait }).result();

		// 2 attempts: first 429 honored (100ms), second 429 retry-after=400s exceeds budget → error
		expect(attempt).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(result.stopReason).toBe("error");
	});

	it("respects AbortSignal during mandatory retry-after wait", async () => {
		const create = ((_body: unknown) => {
			return {
				async withResponse() {
					throw createRateLimitError(60_000);
				},
			} as never;
		}) as unknown as AnthropicMessagesClientLike["messages"]["create"];

		const controller = new AbortController();
		const client = { messages: { create } } as AnthropicMessagesClientLike;
		const providerRetryWait = vi.fn(async (_ms: number, signal?: AbortSignal) => {
			// Abort during the wait, simulating user cancellation
			controller.abort();
			if (signal?.aborted) {
				throw new Error("AbortError");
			}
		});

		const result = await streamAnthropic(model, context, {
			client,
			signal: controller.signal,
			providerRetryWait,
		}).result();

		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(providerRetryWait).toHaveBeenCalledWith(60_000, controller.signal);
		expect(result.stopReason).toBe("aborted");
	});
});
