// V3 최종 개선 (2026-10-16): 호스트가 MCP 질문을 그대로 전달하도록 analyze_prompt 설명에 결과 처리 방법을 덧붙인다.
//
// 배경: 호스트 시뮬레이션(hostSim.ts)에서 호스트는 MCP 질문을 다시 쓰거나 줄이고, 자기 질문을 덧붙이기도 했다.
// production 설명(src/index.ts)은 그대로 두고, V3 서버·호스트 시뮬레이션에서만 이 설명을 쓴다.

/** src/index.ts 의 analyze_prompt 설명 (변경 없음 — 기존 결과 재현용) */
export const BASE_TOOL_DESCRIPTION =
  "사용자의 짧고 모호한 한국어 요청을 이전 대화와 첨부 문서 문맥으로 분석해 모호성을 해결하고, 필요한 경우에만 명확화 질문을 반환하며, 그렇지 않으면 실제 작업에 사용할 수 있는 개선된 Prompt를 생성한다.";

/** V3 최종: 결과 처리 지시를 덧붙인 설명 */
export const V3_TOOL_DESCRIPTION =
  BASE_TOOL_DESCRIPTION +
  " 결과 처리: status가 \"clarification_required\"이면 user_message를 사용자에게 그대로 보여 주고 답을 기다린다." +
  " 질문을 요약·재작성하거나 선택지를 다시 나열하거나 다른 질문을 덧붙이지 않는다." +
  " 사용자가 답하면 previous_analysis(이번 결과의 analysis JSON 문자열)와 answers(질문 id → 답)를 넣어 다시 호출한다." +
  " status가 \"ready\"이면 improved_prompt대로 작업한다.";
