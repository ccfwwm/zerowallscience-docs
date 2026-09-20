import assert from "node:assert/strict";
import test from "node:test";
import {
  callAIChat,
  callAIChatStream,
  extractTextFromChatCompletion,
  resolveAIEndpoint,
  type AISettings,
} from "../src/services/ai-client";

const settings: AISettings = {
  ai_provider: "openai",
  ai_api_url: "https://example.test",
  ai_api_key: "test-key",
  ai_model: "test-model",
  ai_embedding_profile_id: "",
  ai_embedding_url: "",
  ai_embedding_key: "",
  ai_embedding_model: "",
};

test("bare AI host resolves to Responses and extracts Responses output", async () => {
  assert.equal(resolveAIEndpoint(settings.ai_api_url, "responses"), "https://example.test/v1/responses");
  assert.equal(resolveAIEndpoint("https://example.test/v1", "chat/completions"), "https://example.test/v1/chat/completions");

  const previous = globalThis.fetch;
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "Responses 正常" }] }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const text = await callAIChat(settings, [{ role: "user", content: "测试" }]);
    assert.equal(text, "Responses 正常");
    assert.equal(requests[0].url, "https://example.test/v1/responses");
    assert.deepEqual(requests[0].body.input, [{ role: "user", content: "测试" }]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("Responses stream deltas are emitted and chat fallback remains compatible", async () => {
  const previous = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/responses")) {
      return new Response(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"流"}\n\n' +
        'data: {"type":"response.output_text.delta","delta":"式"}\n\n' +
        "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "回退" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const chunks: string[] = [];
    for await (const chunk of callAIChatStream(settings, [{ role: "user", content: "测试" }])) chunks.push(chunk);
    assert.equal(chunks.join(""), "流式");
    assert.deepEqual(urls, ["https://example.test/v1/responses"]);

    globalThis.fetch = (async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/responses")) return new Response("不支持", { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "回退" } }] }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await callAIChat(settings, [{ role: "user", content: "测试" }]), "回退");
    assert.equal(urls.at(-1), "https://example.test/v1/chat/completions");
  } finally {
    globalThis.fetch = previous;
  }
});

test("Responses output arrays are normalized without leaking reasoning fields", () => {
  assert.equal(extractTextFromChatCompletion({
    output: [{ type: "reasoning", content: [{ text: "思考" }] }, { type: "message", content: [{ text: "答案" }] }],
  }), "答案");
});
