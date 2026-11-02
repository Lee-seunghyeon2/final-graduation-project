import type { AmbiguityFinding } from "../types.js";

// v0 PromptBuilder 공통 로직 (템플릿 기반, LLM 미사용 - 결정론적/테스트 용이).
// "이거", "그거" 같은 모호한 표현을 실제 해석 값으로 치환해 명시적인 요청 문장을 만들고,
// 확정된 정보를 별도 목록으로도 덧붙여 최종 Prompt에 모호성이 남지 않도록 한다.

/** 원본 요청에서 모호 표현을 resolved_value로 치환한 문장을 만든다.
 *  겹치는 표현(예: "이 부분" vs "이 부분만") 오치환을 줄이기 위해 긴 표현부터 치환한다. */
export function buildExplicitRequest(
  originalRequest: string,
  findings: AmbiguityFinding[]
): string {
  const resolvable = findings
    .filter((f) => f.resolved_value)
    .sort((a, b) => b.expression.length - a.expression.length);

  let explicit = originalRequest;
  for (const f of resolvable) {
    if (!f.resolved_value) continue;
    explicit = explicit.split(f.expression).join(f.resolved_value);
  }
  return explicit;
}

/** 해결된 모호성을 "표현 → 확정 값" 형태의 불릿 목록으로 정리한다. */
export function buildResolvedInfoList(findings: AmbiguityFinding[]): string {
  const resolved = findings.filter((f) => f.resolved_value);
  if (resolved.length === 0) return "(명시적으로 해결된 모호 표현 없음)";
  return resolved
    .map((f) => `- "${f.expression}" → ${f.resolved_value} (${describeDecision(f)})`)
    .join("\n");
}

function describeDecision(f: AmbiguityFinding): string {
  switch (f.decision) {
    case "RESOLVED":
      return "문맥상 확정";
    case "SAFE_INFERENCE":
      return "AI 추론(영향 낮음)";
    default:
      return "사용자 답변으로 확정";
  }
}

/** v2 refinement: SAFE_INFERENCE 전달 공백 수정.
 *
 *  DecisionEngine은 omission 유형에서 candidates가 비어 있으면(=placeholder로 안전하게
 *  진행하기로 한 미해결 정보) resolved_value를 null로 둔 채 SAFE_INFERENCE를 내린다.
 *  그런데 buildResolvedInfoList/buildExplicitRequest는 둘 다 resolved_value가 있는
 *  finding만 사용하므로, 이런 finding은 downstream(최종 생성)에 "이 정보가 비어있으니
 *  placeholder를 쓰고 사실을 지어내지 마라"는 안내 없이 조용히 사라졌다.
 *
 *  이 함수는 그 공백만 메운다 — DecisionEngine/schema는 그대로다. omission 유형에만
 *  적용한다: degree/reference/scope/comparison의 SAFE_INFERENCE는 "특정 사실이 비어
 *  있어 placeholder가 필요한" 상황이 아니라 "후보가 하나로 좁혀지지 않았지만 위험이
 *  낮아 AI가 합리적으로 진행"하는 상황이라 같은 안내가 적용되지 않는다. */
export function buildSafeInferenceGuidance(findings: AmbiguityFinding[]): string | null {
  const unresolvedSafeOmissions = findings.filter(
    (f) => f.type === "omission" && f.decision === "SAFE_INFERENCE" && !f.resolved_value
  );
  if (unresolvedSafeOmissions.length === 0) return null;

  const items = unresolvedSafeOmissions
    .map((f) => `- "${f.expression}": 관련 정보가 제공되지 않았다.`)
    .join("\n");

  return [
    items,
    "이 항목들에 대해 존재하지 않는 구체적 사실을 임의로 만들어내지 않는다.",
    "요청의 핵심 목적을 유지할 수 있다면 [ ] 형태의 placeholder를 사용하거나, 사실을 특정하지 않는 일반적인 표현을 사용한다.",
  ].join("\n");
}
