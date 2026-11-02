import { describe, expect, it } from "vitest";
import { analyzeAmbiguities, analyzeRequest } from "../src/ambiguityAnalyzer.js";
import { StubLLMClient, analyzerResponse, unifiedAnalyzerResponse } from "./stubLlmClient.js";

// v2: analyzeRequest (task 분류 + ambiguity 분석 통합 호출) 단위 테스트.
// 실제 LLM 판단 품질(예: omission carve-out이 실제로 "창업 아이디어" 류를 안 물어보게
// 하는지)은 여기서 검증하지 않는다 — 이는 live smoke test의 몫이다. 여기서는 순수하게
// "LLM 응답을 정확히 1회만 호출해 파싱하고, task/ambiguities를 스키마대로 반환하는가"만 본다.

describe("analyzeRequest (v2 통합 호출)", () => {
  it("LLM을 1회만 호출해 task와 ambiguities를 함께 반환한다", async () => {
    const llm = new StubLLMClient([
      unifiedAnalyzerResponse("writing", [
        {
          type: "reference",
          expression: "그 기능",
          candidates: ["자동 저장 기능"],
          context_support: "strong",
          impact: "high",
          top_candidate: "자동 저장 기능",
        },
      ]),
    ]);

    const result = await analyzeRequest(llm, "그 기능 빼줘.", "(문맥 없음)");

    expect(llm.callCount).toBe(1);
    expect(result.task).toBe("writing");
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0].type).toBe("reference");
    expect(result.ambiguities[0].candidates).toEqual(["자동 저장 기능"]);
  });

  it("planning으로 분류되는 응답도 정상 파싱한다", async () => {
    const llm = new StubLLMClient([unifiedAnalyzerResponse("planning", [])]);
    const result = await analyzeRequest(llm, "이 공모전 준비 계획 짜줘.", "(문맥 없음)");
    expect(result.task).toBe("planning");
    expect(result.ambiguities).toEqual([]);
  });

  it("top_candidate가 없으면 null로 채운다 (analyzeAmbiguities와 동일한 정규화)", async () => {
    const llm = new StubLLMClient([
      unifiedAnalyzerResponse("writing", [
        {
          type: "omission",
          expression: "바꿔줘",
          candidates: [],
          context_support: "weak",
          impact: "high",
        },
      ]),
    ]);
    const result = await analyzeRequest(llm, "바꿔줘.", "(문맥 없음)");
    expect(result.ambiguities[0].top_candidate).toBeNull();
  });

  it("task 필드가 스키마를 벗어나면 에러를 던진다", async () => {
    const llm = new StubLLMClient([JSON.stringify({ task: "unknown", ambiguities: [] })]);
    await expect(analyzeRequest(llm, "아무 요청", "(문맥 없음)")).rejects.toThrow();
  });
});

describe("analyzeAmbiguities (task 주어짐 — 기존 v0/v1 경로, 회귀 확인용)", () => {
  it("기존과 동일하게 동작한다 (v2-A 이후에도 회귀 없음)", async () => {
    const llm = new StubLLMClient([
      analyzerResponse([
        {
          type: "reference",
          expression: "그 기능",
          candidates: ["자동 저장 기능"],
          context_support: "strong",
          impact: "high",
          top_candidate: "자동 저장 기능",
        },
      ]),
    ]);
    const result = await analyzeAmbiguities(llm, "writing", "그 기능 빼줘.", "(문맥 없음)");
    expect(llm.callCount).toBe(1);
    expect(result).toHaveLength(1);
    expect(result[0].candidates).toEqual(["자동 저장 기능"]);
  });
});
