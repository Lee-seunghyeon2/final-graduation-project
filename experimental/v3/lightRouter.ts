// V3 실험 — 경량 모델 라우터 v0.2 (점수 + 임계값) 와 rule / light / hybrid 라우팅.
//
// 경량 모델은 "질문 없이 진행하면 사용자가 원하지 않는 대상·내용을 추측하게 될 가능성"을 0~100 점으로 낸다.
// 임계값(기본 50, 사전 지정) 이상이면 위험(→ 정밀 분석). 점수를 저장해 두므로 임계값 민감도는 추가 호출 없이 계산한다.
//
// 라우팅 모드 (같은 입력에서 셋 다 비교 가능):
//   rule   : 규칙 v0.2 만. HIGH → B, UNCERTAIN → C(정밀 분석), LOW → A
//   light  : 경량 모델만. score ≥ T → B, < T → A, 오류·파싱 실패 → C(정밀 분석 = V2 fallback)
//   hybrid : 규칙 HIGH → B(경량 호출 없음). 그 외 경량 모델: score ≥ T → B, < T → A, 오류 → C
//   hybrid_cons (보수형, 오프라인 비교용): 규칙 HIGH·UNCERTAIN → 분석, 규칙 LOW 만 경량 모델에 묻는다
//
// 경로 C 는 기본 정책에서 V2 정밀 분석을 실행하므로, 모델 오류·불확실은 V2 로 돌아간다.

import { formatContextForPrompt, buildContextBundle } from "../../src/contextResolver.js";
import type { LLMClient } from "../../src/llm/client.js";
import type { Route } from "./riskRouter.js";
import { assessRiskV02, type RiskAssessmentV02, type RouterInput, type RouterOptionsV02 } from "./riskRouterV02.js";

export const LIGHT_ROUTER_V02_VERSION = "light-router-0.2";
export const DEFAULT_LIGHT_THRESHOLD = 50;

export const LIGHT_ROUTER_V02_SYSTEM_PROMPT = `너는 한국어 작업 요청을 받았을 때, 바로 처리해도 되는지 아니면 사용자에게 먼저 확인해야 할 위험이 있는지 판정하는 분류기다. 요청에 답하지 말고 위험만 판정하라.

위험 유형 (질문 없이 진행하면 사용자가 원하지 않는 대상·내용을 추측하게 됨):
A. 대상 후보가 여럿: 요청이 가리키는 대상(대화에서 만든 산출물, 파일, 문서 속 위치, 사람, 일정, 조항, 칸 등)이 문맥에서 둘 이상이고, 요청과 문맥 어디에도 하나로 고를 근거가 없다. 한 번에 함께 만든 여러 산출물, '아까·전에'로 가리킨 여러 이전 산출물, 같은 이름의 사람·파일, 바꿀 자리가 여러 곳인 수정, 'A·B'처럼 나란히 만든 산출물이 여기에 해당한다.
B. 사용자만 아는 사실이 빠짐: 결과의 핵심이 사용자의 개인 정보·실제 경험·실제 수치·소속 조직의 사실·위치·일정·지난 회의 결정인데 요청과 문맥에 없다. 일반 예시로 채우면 사용자가 원한 결과가 아니다.
C. 관점·비교 기준 후보가 여럿: 누구 입장에서 쓸지, 어느 과거 사례를 기준으로 삼을지 후보가 둘 이상이다.
D. 사용자가 아직 정하지 않았다고 문맥에서 밝혔다.
E. 문맥에서 '그 사람·그 직원'처럼 대명사로만 언급된 인물을 실제로 특정해야 한다.

위험이 아님:
- 대상이 하나뿐이거나, 서수(두 번째)·최근성(방금)·이름·문맥의 선택(필요 없어진 것, 남은 것)으로 하나로 정해진다.
- 일반 지식·사용법 질문, 열린 창작·아이디어·예시 요청 (어떤 합리적 선택이든 괜찮다).
- 분량 같은 기준값이 요청이나 문맥에 있다. 비교 기준이 하나뿐이다.
- 대화 산출물 안의 문장·항목을 고치거나 지우는 일 자체는 위험이 아니다(대상이 하나라면).

score: 질문 없이 진행하면 사용자가 원하지 않는 대상·내용을 추측하게 될 가능성(0~100). 50 이상이면 위험.
반드시 JSON 한 줄로만 답하라: {"score":정수,"type":"A|B|C|D|E|NONE","reason":"15자 이내"}`;

export interface LightScore {
  score: number;
  type: string;
  reason: string;
  raw: string;
}

export function buildLightUserPrompt(input: RouterInput): string {
  const ctx = formatContextForPrompt(buildContextBundle(input.recent_conversation, input.document_context));
  return `[사용자 요청]\n${input.current_user_request}\n\n[문맥]\n${ctx}`;
}

export function parseLightScore(raw: string): LightScore {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error(`경량 라우터 JSON 없음: ${raw.slice(0, 120)}`);
  const v = JSON.parse(m[0]) as { score?: unknown; type?: unknown; reason?: unknown };
  const score = Number(v.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`경량 라우터 score 형식 오류: ${m[0].slice(0, 120)}`);
  return { score: Math.round(score), type: String(v.type ?? ""), reason: String(v.reason ?? ""), raw };
}

export async function lightRouterScore(llm: LLMClient, input: RouterInput): Promise<LightScore> {
  const raw = await llm.complete(LIGHT_ROUTER_V02_SYSTEM_PROMPT, buildLightUserPrompt(input));
  return parseLightScore(raw);
}

export type RouterMode = "rule" | "light" | "hybrid" | "hybrid_cons";

export interface RouteDecisionV02 {
  mode: RouterMode;
  route: Route;
  rule: RiskAssessmentV02;
  light: LightScore | null;
  light_called: boolean;
  light_error: string | null;
  basis: "RULE_HIGH" | "RULE_UNCERTAIN" | "RULE_LOW" | "LIGHT_HIGH" | "LIGHT_LOW" | "LIGHT_FAILED";
}

/** 규칙 결과와 (있으면) 경량 점수로 경로를 정한다. 오프라인 비교에도 같은 함수를 쓴다. */
export function decideRoute(mode: RouterMode, rule: RiskAssessmentV02, light: LightScore | null, lightError: string | null, threshold = DEFAULT_LIGHT_THRESHOLD): Pick<RouteDecisionV02, "route" | "basis"> {
  const fromLight = (): Pick<RouteDecisionV02, "route" | "basis"> =>
    lightError || !light ? { route: "C_UNCERTAIN", basis: "LIGHT_FAILED" } : light.score >= threshold ? { route: "B_ANALYZE", basis: "LIGHT_HIGH" } : { route: "A_DIRECT", basis: "LIGHT_LOW" };
  if (mode === "rule") return { route: rule.route, basis: rule.tier === "HIGH" ? "RULE_HIGH" : rule.tier === "UNCERTAIN" ? "RULE_UNCERTAIN" : "RULE_LOW" };
  if (mode === "light") return fromLight();
  if (rule.tier === "HIGH") return { route: "B_ANALYZE", basis: "RULE_HIGH" };
  if (mode === "hybrid_cons" && rule.tier === "UNCERTAIN") return { route: "C_UNCERTAIN", basis: "RULE_UNCERTAIN" };
  return fromLight();
}

/** 경량 모델 호출이 필요한 모드인지 (규칙 결과 기준) */
export function needsLight(mode: RouterMode, rule: RiskAssessmentV02): boolean {
  if (mode === "rule") return false;
  if (mode === "light") return true;
  if (rule.tier === "HIGH") return false;
  if (mode === "hybrid_cons" && rule.tier === "UNCERTAIN") return false;
  return true;
}

export async function routeV02(input: RouterInput, deps: { lightLlm?: LLMClient }, opts: RouterOptionsV02 & { mode: RouterMode; threshold?: number }): Promise<RouteDecisionV02> {
  const rule = assessRiskV02(input, opts);
  let light: LightScore | null = null;
  let lightError: string | null = null;
  let called = false;
  if (needsLight(opts.mode, rule)) {
    if (!deps.lightLlm) lightError = "경량 모델 미설정";
    else {
      called = true;
      try {
        light = await lightRouterScore(deps.lightLlm, input);
      } catch (e) {
        lightError = (e as Error).message.slice(0, 200);
      }
    }
  }
  const d = decideRoute(opts.mode, rule, light, lightError, opts.threshold);
  return { mode: opts.mode, ...d, rule, light, light_called: called, light_error: lightError };
}
