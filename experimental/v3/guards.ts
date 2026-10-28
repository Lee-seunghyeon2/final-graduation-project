// V3 실험 — V2 정밀 분석 결과에 적용하는 결정론적 안전 가드 (LLM 미사용).
//
// 라우터가 "구조적으로" 확인한 위험(여러 후보·미결정·약한 근거의 비가역 실행)과 V2 분석 결과가 충돌할 때만
// 질문으로 바꾼다. 라우터가 위험을 탐지했다는 이유만으로 질문을 만들지 않는다(탐지 ≠ 질문 필요).
//
//   G1a 과거 지시어 다중 후보 : REF_PAST_MULTI 인데 V2 가 ready → 질문 (F100-MT-15 유형: 최근성 규칙이 '아까'를 최신 산출물로 해석)
//   G1b 같은 턴 다중 산출물   : REF_GROUP_MULTI 인데 V2 가 ready → 질문 ("두 메일을 작성했습니다" + "그 메일")
//   G2  약한 근거의 비가역 실행: IRREV_WEAK/IRREV_UNRESOLVED 인데 V2 가 reference/scope 를 strong 이 아닌 근거로 해소하고 ready → 질문
//                               (CLAMBER-T-30 유형: 재서술 후보를 medium 으로 단정)
//   G3  사용자 미결정          : CTX_UNDECIDED 인데 V2 가 ready → 질문
//
// 가드는 V2 의 finding 을 CLARIFICATION_REQUIRED 로 바꾸거나(해당 finding 이 있으면) 라우터 후보로 finding 을 추가한 뒤
// V2 의 질문 생성기(src/clarificationQuestionGenerator.ts)를 그대로 다시 호출한다.

import { generateClarificationQuestions } from "../../src/clarificationQuestionGenerator.js";
import type { AmbiguityFinding, WorkflowOutput } from "../../src/types.js";
import type { RiskAssessment, SignalId } from "./riskRouter.js";

export type GuardId = "G1a_PAST_DEIXIS_MULTI" | "G1b_SAME_TURN_MULTI" | "G2_IRREVERSIBLE_WEAK" | "G3_USER_UNDECIDED";

export interface GuardFiring {
  guard: GuardId;
  detail: string;
}

const has = (a: RiskAssessment, id: SignalId) => a.signals.some((s) => s.id === id);
const candidatesOf = (a: RiskAssessment, id: SignalId) => a.signals.find((s) => s.id === id)?.candidates ?? [];

function toClarification(f: AmbiguityFinding, candidates?: string[]): AmbiguityFinding {
  return {
    ...f,
    candidates: candidates && candidates.length >= 2 ? candidates : f.candidates,
    decision: "CLARIFICATION_REQUIRED",
    resolved_value: null,
    question_id: undefined,
  };
}

function syntheticReference(expression: string, candidates: string[]): AmbiguityFinding {
  return {
    type: "reference",
    expression,
    candidates,
    context_support: "weak",
    impact: "high",
    top_candidate: null,
    decision: "CLARIFICATION_REQUIRED",
    resolved_value: null,
  };
}

/** V2 결과(output)에 가드를 적용한다. 바뀌지 않으면 원래 output 을 그대로 반환한다. */
export function applyGuards(output: WorkflowOutput, a: RiskAssessment): { output: WorkflowOutput; fired: GuardFiring[] } {
  if (output.status !== "ready") return { output, fired: [] };
  let findings = [...output.analysis.ambiguities];
  const fired: GuardFiring[] = [];
  const refIdx = findings.findIndex((f) => f.type === "reference" && f.decision !== "CLARIFICATION_REQUIRED");
  const expr = a.deixis[0] ?? "지시 대상";

  const forceReference = (guard: GuardId, candidates: string[], detail: string) => {
    if (refIdx >= 0) findings[refIdx] = toClarification(findings[refIdx], candidates);
    else findings.push(syntheticReference(expr, candidates));
    fired.push({ guard, detail });
  };

  if (has(a, "REF_PAST_MULTI")) {
    forceReference("G1a_PAST_DEIXIS_MULTI", candidatesOf(a, "REF_PAST_MULTI"), "과거 지시어가 가리킬 이전 산출물이 2개 이상인데 V2 가 하나로 해소함");
  } else if (has(a, "REF_GROUP_MULTI")) {
    forceReference("G1b_SAME_TURN_MULTI", candidatesOf(a, "REF_GROUP_MULTI"), "같은 턴에서 만든 산출물이 2개 이상인데 V2 가 하나로 해소함");
  }

  if (!fired.length && (has(a, "IRREV_WEAK") || has(a, "IRREV_UNRESOLVED"))) {
    const weak = findings.findIndex(
      (f) => (f.type === "reference" || f.type === "scope") && (f.decision === "RESOLVED" || f.decision === "SAFE_INFERENCE") && f.context_support !== "strong"
    );
    if (weak >= 0) {
      findings[weak] = toClarification(findings[weak]);
      fired.push({ guard: "G2_IRREVERSIBLE_WEAK", detail: `비가역 실행의 대상(${findings[weak].expression})을 V2 가 strong 이 아닌 근거로 해소함` });
    }
  }

  if (!fired.length && has(a, "CTX_UNDECIDED")) {
    forceReference("G3_USER_UNDECIDED", [], "사용자가 아직 정하지 않았다고 밝혔는데 V2 가 하나로 해소함");
  }

  if (!fired.length) return { output, fired };
  const { questions, findings: numbered } = generateClarificationQuestions(findings);
  findings = numbered;
  return {
    output: {
      status: "clarification_required",
      questions,
      analysis: { ...output.analysis, ambiguities: findings, questions: questions.map((q) => q.question) },
    },
    fired,
  };
}
