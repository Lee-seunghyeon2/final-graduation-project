import type { AnalysisResult, ContextBundle } from "../types.js";
import { buildExplicitRequest, buildResolvedInfoList, buildSafeInferenceGuidance } from "./common.js";

export function buildWritingPrompt(analysis: AnalysisResult, context: ContextBundle): string {
  const explicitRequest = buildExplicitRequest(analysis.original_request, analysis.ambiguities);
  const resolvedInfo = buildResolvedInfoList(analysis.ambiguities);
  const safeInferenceGuidance = buildSafeInferenceGuidance(analysis.ambiguities);

  const lines = [
    "다음 요청에 따라 문서를 작성/수정한다.",
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
      "[첨부 자료 반영 지침]",
      "첨부된 자료의 내용을 근거로 작성하며, 자료에 명시된 사실과 어긋나지 않게 한다."
    );
  }

  lines.push(
    "",
    "[출력 형식 지침]",
    "위에서 확정된 대상/범위/기준/스타일을 그대로 반영하여 완성도 있는 문서를 작성한다."
  );

  return lines.join("\n");
}
