import { describe, expect, it } from "vitest";
import { decide } from "../src/decisionEngine.js";
import type { RawAmbiguityFinding } from "../src/types.js";

function raw(partial: Partial<RawAmbiguityFinding>): RawAmbiguityFinding {
  return {
    type: "reference",
    expression: "그거",
    candidates: [],
    context_support: "medium",
    impact: "low",
    top_candidate: null,
    ...partial,
  };
}

describe("decisionEngine (순수 로직 경계값)", () => {
  it("후보 1개 + 강한 문맥 근거 -> RESOLVED", () => {
    const result = decide(
      raw({ candidates: ["자동 저장 기능"], context_support: "strong", impact: "high" })
    );
    expect(result.decision).toBe("RESOLVED");
    expect(result.resolved_value).toBe("자동 저장 기능");
  });

  it("후보 1개 + 약한 문맥 근거 -> SAFE_INFERENCE (질문 X)", () => {
    const result = decide(
      raw({ candidates: ["자동 저장 기능"], context_support: "weak", impact: "low" })
    );
    expect(result.decision).toBe("SAFE_INFERENCE");
    expect(result.resolved_value).toBe("자동 저장 기능");
  });

  it("후보 2개 이상 + impact high -> CLARIFICATION_REQUIRED", () => {
    const result = decide(
      raw({
        candidates: ["자동 저장 기능", "알림 기능"],
        context_support: "weak",
        impact: "high",
      })
    );
    expect(result.decision).toBe("CLARIFICATION_REQUIRED");
    expect(result.resolved_value).toBeNull();
  });

  it("후보 2개 이상 + impact low -> SAFE_INFERENCE (질문 X)", () => {
    const result = decide(
      raw({
        candidates: ["자동 저장 기능", "알림 기능"],
        context_support: "medium",
        impact: "low",
        top_candidate: "자동 저장 기능",
      })
    );
    expect(result.decision).toBe("SAFE_INFERENCE");
    expect(result.resolved_value).toBe("자동 저장 기능");
  });

  it("후보 0개 + impact high -> CLARIFICATION_REQUIRED (예: 기준값 자체가 없는 degree)", () => {
    const result = decide(raw({ candidates: [], context_support: "weak", impact: "high" }));
    expect(result.decision).toBe("CLARIFICATION_REQUIRED");
    expect(result.resolved_value).toBeNull();
  });

  it("후보 0개 + impact low -> SAFE_INFERENCE (질문 X)", () => {
    const result = decide(raw({ candidates: [], context_support: "weak", impact: "low" }));
    expect(result.decision).toBe("SAFE_INFERENCE");
  });

  it("[v2 regression fix] 후보 1개 + impact high + weak + top_candidate 없음 -> CLARIFICATION_REQUIRED (신규 safety branch)", () => {
    const result = decide(
      raw({
        candidates: ["그 사람"],
        context_support: "weak",
        impact: "high",
        top_candidate: null,
      })
    );
    expect(result.decision).toBe("CLARIFICATION_REQUIRED");
    expect(result.resolved_value).toBeNull();
  });

  it("[v2 regression fix] 후보 1개 + impact high + weak이어도 top_candidate가 있으면 기존 SAFE_INFERENCE 유지", () => {
    const result = decide(
      raw({
        candidates: ["X"],
        context_support: "weak",
        impact: "high",
        top_candidate: "X",
      })
    );
    expect(result.decision).toBe("SAFE_INFERENCE");
    expect(result.resolved_value).toBe("X");
  });

  it("[v2 regression fix] 후보 1개 + impact high + context_support=medium + top_candidate 없음 -> 기존 RESOLVED 유지(신규 분기 미적용)", () => {
    const result = decide(
      raw({
        candidates: ["X"],
        context_support: "medium",
        impact: "high",
        top_candidate: null,
      })
    );
    expect(result.decision).toBe("RESOLVED");
    expect(result.resolved_value).toBe("X");
  });

  it("[v2 regression fix] 후보 1개 + impact low + weak + top_candidate 없음 -> 기존 SAFE_INFERENCE 유지(신규 분기는 high 전용)", () => {
    const result = decide(
      raw({
        candidates: ["X"],
        context_support: "weak",
        impact: "low",
        top_candidate: null,
      })
    );
    expect(result.decision).toBe("SAFE_INFERENCE");
    expect(result.resolved_value).toBe("X");
  });

  it("중복 후보는 하나로 취급된다", () => {
    const result = decide(
      raw({
        candidates: ["자동 저장 기능", "자동 저장 기능", " 자동 저장 기능 "],
        context_support: "strong",
        impact: "high",
      })
    );
    expect(result.decision).toBe("RESOLVED");
    expect(result.resolved_value).toBe("자동 저장 기능");
  });
});
