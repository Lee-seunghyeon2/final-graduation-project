import type { AmbiguityFinding, Decision, RawAmbiguityFinding } from "./types.js";

// v0 DecisionEngine
// AmbiguityAnalyzer(LLM)가 산출한 원시 후보/영향도를 받아
// RESOLVED / SAFE_INFERENCE / CLARIFICATION_REQUIRED를 "결정론적으로" 판단한다.
// LLM을 다시 호출하지 않는 순수 함수이므로 테스트에서 stub 없이도 검증 가능하다.
//
// 핵심 규칙 (요구사항 3):
//   질문이 필요한 조건 = 유력 후보가 2개 이상 남음 AND 후보 선택에 따라 결과가 크게 달라짐(impact=high)
//
// 예외: candidates가 0개인데 impact가 high인 경우(예: degree 유형에서 "글자 수를 꼭 지켜야
// 한다"면서 실제 기준값이 전혀 없는 경우)도 AI가 안전하게 추론할 근거 자체가 없으므로
// CLARIFICATION_REQUIRED로 처리한다.
//
// v2 regression fix (safety gap): "후보가 정확히 1개"를 곧바로 "의미가 하나로 해소됐다"로
// 취급하지 않는다. impact=high + 후보 1개 + context_support=weak + top_candidate 없음(=Analyzer
// 스스로도 그 후보를 대표 해석으로 확신하지 못함)이 동시에 성립하면, 그 유일한 후보를 그대로
// resolved_value로 쓰는 SAFE_INFERENCE 대신 CLARIFICATION_REQUIRED로 처리한다. OFFLINE
// blast-radius audit(883 records / 1616 findings) 기준 이 조합은 극히 드물고(4건), 이 조건을
// 추가해도 기존 정답 사례에 회귀가 없음을 확인했다(results/decision-engine-safety-gap-review.md).
// top_candidate가 있으면(=Analyzer가 그래도 대표값을 골랐으면) 기존 SAFE_INFERENCE 동작을
// 그대로 유지한다 — "high+weak 전부를 질문으로 보낸다"는 더 넓은 규칙이 아니다.

function dedupe(candidates: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of candidates) {
    const trimmed = c.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export function decide(raw: RawAmbiguityFinding): AmbiguityFinding {
  const unique = dedupe(raw.candidates);
  const { impact, context_support } = raw;

  let decision: Decision;
  let resolved_value: string | null;

  if (impact === "high" && unique.length !== 1) {
    // 후보가 없거나(0개) 유력 후보가 2개 이상인데 결과 영향이 큼 -> 질문 필요
    decision = "CLARIFICATION_REQUIRED";
    resolved_value = null;
  } else if (
    impact === "high" &&
    unique.length === 1 &&
    context_support === "weak" &&
    !raw.top_candidate?.trim()
  ) {
    // 후보가 정확히 1개지만 문맥 근거가 약하고, Analyzer 스스로도 그 후보를 대표 해석으로
    // 확신하지 못함(top_candidate 없음) -> "후보가 하나다" != "의미가 해소됐다"이므로 질문 필요
    decision = "CLARIFICATION_REQUIRED";
    resolved_value = null;
  } else if (unique.length === 1 && context_support !== "weak") {
    // 후보가 사실상 하나이고 문맥 근거가 약하지 않음 -> 문맥으로 해결됨
    decision = "RESOLVED";
    resolved_value = unique[0];
  } else {
    // 완전히 확실하진 않지만 영향이 낮거나(=안전) 후보가 하나뿐인데 근거가 약한 경우
    // -> 질문하지 않고 AI가 합리적으로 추론
    decision = "SAFE_INFERENCE";
    resolved_value = raw.top_candidate?.trim() || unique[0] || null;
  }

  return { ...raw, decision, resolved_value };
}

export function decideAll(raws: RawAmbiguityFinding[]): AmbiguityFinding[] {
  return raws.map(decide);
}
