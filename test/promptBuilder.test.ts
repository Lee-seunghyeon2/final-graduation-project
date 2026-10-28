import { describe, expect, it } from "vitest";
import { buildImprovedPrompt } from "../src/promptBuilder/index.js";
import type { AnalysisResult, ContextBundle } from "../src/types.js";

const emptyContext: ContextBundle = { recent_conversation: [], document_context: null };

describe("promptBuilder", () => {
  it("planning: 확정된 정보가 명시화된 요청 문장에 반영된다", () => {
    const analysis: AnalysisResult = {
      task: "planning",
      original_request: "이거 보고 계획 짜줘.",
      ambiguities: [
        {
          type: "reference",
          expression: "이거",
          candidates: ["AI 공모전 안내문"],
          context_support: "strong",
          impact: "high",
          top_candidate: "AI 공모전 안내문",
          decision: "RESOLVED",
          resolved_value: "AI 공모전 안내문",
        },
      ],
      questions: [],
    };
    const prompt = buildImprovedPrompt(analysis, {
      recent_conversation: [],
      document_context: "AI 공모전 안내문 원문...",
    });
    expect(prompt).toContain("AI 공모전 안내문 보고 계획 짜줘.");
    expect(prompt).not.toMatch(/명시화된 요청\]\n이거/);
    expect(prompt).toContain("첨부된 문서에 명시된 마감일");
  });

  it("writing: task별 출력 형식 지침이 다르게 적용된다", () => {
    const analysis: AnalysisResult = {
      task: "writing",
      original_request: "그 기능 빼줘.",
      ambiguities: [
        {
          type: "reference",
          expression: "그 기능",
          candidates: ["알림 기능"],
          context_support: "strong",
          impact: "high",
          top_candidate: "알림 기능",
          decision: "RESOLVED",
          resolved_value: "알림 기능",
        },
      ],
      questions: [],
    };
    const prompt = buildImprovedPrompt(analysis, emptyContext);
    expect(prompt).toContain("알림 기능 빼줘.");
    expect(prompt).toContain("문서를 작성/수정한다");
  });
});

// v2 refinement: SAFE_INFERENCE 전달 공백 수정 회귀 테스트.
describe("promptBuilder - SAFE_INFERENCE 안전 지침 전달", () => {
  it("A. omission + impact=low + SAFE_INFERENCE + resolved_value=null -> [안전한 처리 지침] 포함", () => {
    const analysis: AnalysisResult = {
      task: "writing",
      original_request: "부서 회식 안내 메일을 써줘.",
      ambiguities: [
        {
          type: "omission",
          expression: "부서 회식 안내 메일",
          candidates: [],
          context_support: "weak",
          impact: "low",
          top_candidate: null,
          decision: "SAFE_INFERENCE",
          resolved_value: null,
        },
      ],
      questions: [],
    };
    const prompt = buildImprovedPrompt(analysis, emptyContext);
    expect(prompt).toContain("[안전한 처리 지침]");
    expect(prompt).toContain("구체적 사실을 임의로 만들어내지 않는다");
    expect(prompt).toContain("placeholder");
  });

  it("B. resolved_value가 있는 일반 RESOLVED/SAFE_INFERENCE -> 기존 동작 유지, 안전 지침 없음", () => {
    const analysis: AnalysisResult = {
      task: "writing",
      original_request: "이거 조금만 다듬어줘.",
      ambiguities: [
        {
          type: "reference",
          expression: "이거",
          candidates: ["보고서 초안 문장 표현"],
          context_support: "weak",
          impact: "low",
          top_candidate: "보고서 초안 문장 표현",
          decision: "SAFE_INFERENCE",
          resolved_value: "보고서 초안 문장 표현",
        },
      ],
      questions: [],
    };
    const prompt = buildImprovedPrompt(analysis, emptyContext);
    expect(prompt).toContain("보고서 초안 문장 표현");
    expect(prompt).not.toContain("[안전한 처리 지침]");
  });

  it("C. CLARIFICATION_REQUIRED finding -> 안전 지침이 잘못 들어가지 않음", () => {
    // buildImprovedPrompt는 questions.length===0(ready)일 때만 호출되지만, 만약 CLARIFICATION_REQUIRED
    // 상태의 finding이 섞여 improved_prompt 생성 경로를 타더라도 안전 지침 대상이 아님을 확인한다.
    const analysis: AnalysisResult = {
      task: "writing",
      original_request: "그 기능 빼줘.",
      ambiguities: [
        {
          type: "omission",
          expression: "그 기능",
          candidates: [],
          context_support: "weak",
          impact: "high",
          top_candidate: null,
          decision: "CLARIFICATION_REQUIRED",
          resolved_value: null,
          question_id: "q1",
        },
      ],
      questions: [],
    };
    const prompt = buildImprovedPrompt(analysis, emptyContext);
    expect(prompt).not.toContain("[안전한 처리 지침]");
  });

  it("D. omission이 아닌 다른 유형의 SAFE_INFERENCE(resolved_value=null)는 안전 지침 대상이 아님", () => {
    const analysis: AnalysisResult = {
      task: "writing",
      original_request: "조금 더 간결하게 써줘.",
      ambiguities: [
        {
          type: "degree",
          expression: "조금 더 간결하게",
          candidates: [],
          context_support: "weak",
          impact: "low",
          top_candidate: null,
          decision: "SAFE_INFERENCE",
          resolved_value: null,
        },
      ],
      questions: [],
    };
    const prompt = buildImprovedPrompt(analysis, emptyContext);
    expect(prompt).not.toContain("[안전한 처리 지침]");
  });

  it("omission과 다른 유형이 섞여 있어도 omission 안전 지침만 정확히 추가된다", () => {
    const analysis: AnalysisResult = {
      task: "writing",
      original_request: "그 기능 관련 공지문을 써줘.",
      ambiguities: [
        {
          type: "reference",
          expression: "그 기능",
          candidates: ["자동 저장 기능"],
          context_support: "strong",
          impact: "high",
          top_candidate: "자동 저장 기능",
          decision: "RESOLVED",
          resolved_value: "자동 저장 기능",
        },
        {
          type: "omission",
          expression: "공지문",
          candidates: [],
          context_support: "weak",
          impact: "low",
          top_candidate: null,
          decision: "SAFE_INFERENCE",
          resolved_value: null,
        },
      ],
      questions: [],
    };
    const prompt = buildImprovedPrompt(analysis, emptyContext);
    expect(prompt).toContain("자동 저장 기능");
    expect(prompt).toContain("[안전한 처리 지침]");
  });
});
