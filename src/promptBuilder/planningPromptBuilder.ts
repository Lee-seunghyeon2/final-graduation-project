import type { AnalysisResult, ContextBundle } from "../types.js";
import { buildExplicitRequest, buildResolvedInfoList, buildSafeInferenceGuidance } from "./common.js";

export function buildPlanningPrompt(analysis: AnalysisResult, context: ContextBundle): string {
  const explicitRequest = buildExplicitRequest(analysis.original_request, analysis.ambiguities);
  const resolvedInfo = buildResolvedInfoList(analysis.ambiguities);
  const safeInferenceGuidance = buildSafeInferenceGuidance(analysis.ambiguities);

  const lines = [
    "다음 요청에 대한 실행 계획을 작성한다.",
    "",
    `[명시화된 요청]\n${explicitRequest}`,
    "",
    `[확정된 정보]\n${resolvedInfo}`,
  ];

  if (safeInferenceGuidance) {
    lines.push("", "[안전한 처리 지침]", safeInferenceGuidance);
  }

  if (context.document_context) {
    lines.push(
      "",
      "[첨부 문서 반영 지침]",
      "첨부된 문서에 명시된 마감일, 제출물, 평가 기준, 요구사항이 있다면 반드시 계획에 반영한다."
    );
  }

  lines.push(
    "",
    "[출력 형식 지침]",
    "구체적인 단계별 실행 계획(할 일, 순서, 기한 고려사항 포함)으로 작성한다."
  );

  return lines.join("\n");
}
