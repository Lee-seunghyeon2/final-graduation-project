// V3 실험 — 하이브리드 라우터: 결정론 규칙(riskRouter) + 경량 모델 라우터.
//
// 배경: 규칙 라우터 v0.1 은 개발 사례에서는 FN 0 이었지만, 저장된 Final-100/Final-60 재조합에서
// 질문 필요 case 를 6/35, 8/13 놓쳤다(어휘 변형·의미적 누락). 규칙만으로 "분석 생략"을 결정하면
// V2 의 안전성 이점을 잃는다. 그래서 규칙은 "확실한 위험"만 즉시 정밀 분석으로 보내고,
// 나머지(LOW·UNCERTAIN)는 짧은 프롬프트의 경량 모델에 위험 여부를 묻는다.
//
//   규칙 HIGH                 → B (경량 모델 호출 없음)
//   규칙 LOW/UNCERTAIN        → 경량 모델: HIGH → B, LOW → A
//   경량 모델 실패(오류·파싱) → C (분석 쪽으로 안전하게)
//   경량 모델 미설정          → 규칙 v0.1 경로 그대로 (LOW → A, UNCERTAIN → C)
//
// 경량 모델은 LLMClient 인터페이스로 주입한다 (테스트는 mock). 실제 모델·파라미터(예: Haiku 계열,
// 사고 끔·낮은 effort)는 유료 실험 단계에서 정하며, 이 파일은 API 를 호출하지 않는다.

import { parseJsonResponse, type LLMClient } from "../../src/llm/client.js";
import { formatContextForPrompt, buildContextBundle } from "../../src/contextResolver.js";
import { assessRisk, type RiskAssessment, type Route, type RouterInput, type RouterOptions } from "./riskRouter.js";

export const LIGHT_ROUTER_SYSTEM_PROMPT = `너는 한국어 요청을 바로 처리해도 되는지 판단하는 위험 분류기다. 답을 쓰지 말고 위험만 판정하라.

다음 중 하나라도 해당하면 HIGH:
1. 요청이 가리키는 대상(파일·문서·사람·산출물·일정·조항 등)이 문맥에서 둘 이상이고 무엇인지 확정되지 않는다.
2. 결과의 핵심이 사용자만 아는 사실(개인 경험·실제 수치·장소·날짜·기준값 등)인데 요청·문맥에 없다.
3. 비교 기준이나 관점(누구 입장인지 등)의 후보가 둘 이상이다.
4. 삭제·발송·해지·덮어쓰기 같은 되돌리기 어려운 외부 작업인데 대상이 하나로 확정되지 않는다.

다음은 LOW: 대상이 문맥상 하나로 정해짐, 일반 지식·창작·예시 요청, 세부 정보를 placeholder 나 일반 표현으로 채워도 되는 요청,
대상이 명시된 비가역 작업. 확신이 없으면 HIGH.

반드시 JSON 한 줄로만 답하라: {"risk":"HIGH"|"LOW","reason":"20자 이내"}`;

export interface LightVerdict {
  risk: "HIGH" | "LOW";
  reason: string;
}

export async function lightRouterVerdict(llm: LLMClient, input: RouterInput): Promise<LightVerdict> {
  const ctx = formatContextForPrompt(buildContextBundle(input.recent_conversation, input.document_context));
  const raw = await llm.complete(LIGHT_ROUTER_SYSTEM_PROMPT, `[사용자 요청]\n${input.current_user_request}\n\n[문맥]\n${ctx}`);
  const v = parseJsonResponse<{ risk?: string; reason?: string }>(raw);
  if (v.risk !== "HIGH" && v.risk !== "LOW") throw new Error(`경량 라우터 응답 형식 오류: ${raw}`);
  return { risk: v.risk, reason: String(v.reason ?? "") };
}

export interface HybridDecision {
  route: Route;
  rule: RiskAssessment;
  light: LightVerdict | null;
  light_called: boolean;
  light_error: string | null;
  basis: "RULE_HIGH" | "LIGHT_HIGH" | "LIGHT_LOW" | "LIGHT_FAILED" | "RULE_ONLY";
}

export async function hybridRoute(input: RouterInput, deps: { lightLlm?: LLMClient }, opts: RouterOptions = {}): Promise<HybridDecision> {
  const rule = assessRisk(input, opts);
  if (rule.tier === "HIGH") return { route: "B_ANALYZE", rule, light: null, light_called: false, light_error: null, basis: "RULE_HIGH" };
  if (!deps.lightLlm) return { route: rule.route, rule, light: null, light_called: false, light_error: null, basis: "RULE_ONLY" };
  try {
    const light = await lightRouterVerdict(deps.lightLlm, input);
    return { route: light.risk === "HIGH" ? "B_ANALYZE" : "A_DIRECT", rule, light, light_called: true, light_error: null, basis: light.risk === "HIGH" ? "LIGHT_HIGH" : "LIGHT_LOW" };
  } catch (e) {
    return { route: "C_UNCERTAIN", rule, light: null, light_called: true, light_error: (e as Error).message.slice(0, 200), basis: "LIGHT_FAILED" };
  }
}
