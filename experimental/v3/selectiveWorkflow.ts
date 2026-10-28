// V3 실험 — 선택적 분석 워크플로우 (feature flag 로 V2 / V3 전환). production(src/)은 수정하지 않고 재사용한다.
//
//   pipeline "v2": 기존 runWorkflow 그대로 (모든 요청 LLM 분석 1회)
//   pipeline "v3": riskRouter → 경로 A(분석 생략, LLM 0회) / B·C(V2 분석 1회 + 결정론 가드)
//
// 경로 A 의 출력: status "ready", improved_prompt = 원래 요청 그대로(passthrough). 호스트 모델은 Direct 와 같은
// 입력으로 답한다. analysis.task 는 LLM 없이 정할 수 없으므로 키워드 휴리스틱으로 채우며, 경로 A 에서는 쓰이지 않는다.
//
// 한계: 이 모듈은 MCP 서버 "안"에서 비싼 분석만 생략한다. 호스트(Claude Desktop)가 tool 을 부를지 말지는
// 호스트 모델이 정하므로, tool 호출 자체의 비용·지연(인자 생성 출력 토큰, 추가 왕복)은 줄일 수 없다.

import type { LLMClient } from "../../src/llm/client.js";
import type { Task, WorkflowInput, WorkflowOutput } from "../../src/types.js";
import { runWorkflow } from "../../src/workflow.js";
import { applyGuards, type GuardFiring } from "./guards.js";
import { hybridRoute } from "./hybridRouter.js";
import { routeV02, type RouterMode } from "./lightRouter.js";
import { formatUserMessage } from "./questionFormat.js";
import { assessRisk, type RiskAssessment, type Route, type RouterOptions } from "./riskRouter.js";
import type { RiskAssessmentV02 } from "./riskRouterV02.js";

export interface SelectiveOptions extends RouterOptions {
  pipeline: "v2" | "v3";
  /** 라우터 버전. "0.1"(기본, 기존 결과 재현용) / "0.2"(riskRouterV02 + lightRouter) */
  routerVersion?: "0.1" | "0.2";
  /**
   * v0.1: "rule"(기본) / "hybrid"(hybridRouter.ts)
   * v0.2: "rule" / "light" / "hybrid" / "hybrid_cons" (lightRouter.ts 참고)
   */
  router?: "rule" | "hybrid" | RouterMode;
  /** v0.2 경량 라우터 임계값 (기본 50) */
  lightThreshold?: number;
  /** 경로 C 정책: "analyze"(기본, V2 분석 + 가드) 또는 "passthrough"(분석 생략 — 비교 실험용) */
  uncertainPolicy?: "analyze" | "passthrough";
  /** 결정론 가드 적용 여부 (기본 true) */
  guards?: boolean;
  /**
   * V3 최종 개선: clarification_required 일 때 사용자에게 그대로 보여 줄 질문 문구(user_message)를 덧붙인다 (기본 false).
   * 기본값을 끈 것은 기존 파일럿·판별 결과의 재현을 위해서다. 판단(라우터·분석기·가드)에는 영향이 없다.
   */
  userMessage?: boolean;
}

export interface V3Meta {
  pipeline: "v2" | "v3";
  route: Route | "V2_ALWAYS" | "CONTINUATION";
  analyzed: boolean;
  /** 정밀 분석(V2 분석기) LLM 호출 수 */
  llm_calls: number;
  /** 경량 라우터 LLM 호출 수 (hybrid 일 때만) */
  light_calls: number;
  router_basis: string | null;
  assessment: RiskAssessment | RiskAssessmentV02 | null;
  guards_fired: GuardFiring[];
  /** v0.2: 경량 라우터 점수·오류 (호출했을 때만) */
  light_score?: number | null;
  light_error?: string | null;
}

export type SelectiveOutput = WorkflowOutput & { v3: V3Meta; user_message?: string };

class CountingClient implements LLMClient {
  calls = 0;
  constructor(private readonly inner: LLMClient) {}
  async complete(system: string, user: string) {
    this.calls++;
    return this.inner.complete(system, user);
  }
}

function heuristicTask(request: string): Task {
  return /(계획|일정|플랜|로드맵|커리큘럼|스케줄|할 일)/.test(request) ? "planning" : "writing";
}

function passthrough(input: WorkflowInput): WorkflowOutput {
  return {
    status: "ready",
    improved_prompt: input.current_user_request,
    analysis: { task: heuristicTask(input.current_user_request), original_request: input.current_user_request, ambiguities: [], questions: [] },
  };
}

export async function runSelectiveWorkflow(input: WorkflowInput, deps: { llm: LLMClient; lightLlm?: LLMClient }, opts: SelectiveOptions): Promise<SelectiveOutput> {
  const llm = new CountingClient(deps.llm);
  const meta = (m: Partial<V3Meta> & Pick<V3Meta, "pipeline" | "route" | "analyzed">): V3Meta => ({
    llm_calls: llm.calls,
    light_calls: 0,
    router_basis: null,
    assessment: null,
    guards_fired: [],
    ...m,
  });

  if (opts.pipeline === "v2") {
    const out = await runWorkflow(input, { llm });
    return { ...out, v3: meta({ pipeline: "v2", route: "V2_ALWAYS", analyzed: true, llm_calls: llm.calls }) };
  }

  // 질문 답변 이어가기는 V2 와 동일 (LLM 호출 없음)
  if (input.previous_analysis && input.answers) {
    const out = await runWorkflow(input, { llm });
    return { ...out, v3: meta({ pipeline: "v3", route: "CONTINUATION", analyzed: false, llm_calls: llm.calls }) };
  }

  let route: Route;
  let assessment: RiskAssessment;
  let lightCalls = 0;
  let basis: string;
  let lightExtra: Pick<V3Meta, "light_score" | "light_error"> = {};
  if (opts.routerVersion === "0.2") {
    const mode = (opts.router ?? "rule") as RouterMode;
    const d = await routeV02(input, { lightLlm: deps.lightLlm }, { mode, threshold: opts.lightThreshold, irreversibleResolvedRoute: opts.irreversibleResolvedRoute });
    route = d.route;
    // 가드는 signal id·deixis 만 읽는다. v0.2 는 IRREV_* 를 외부 자원 작업에만 내므로 G2 가 내부 편집에 발동하지 않는다.
    assessment = d.rule as unknown as RiskAssessment;
    lightCalls = d.light_called ? 1 : 0;
    basis = d.basis;
    lightExtra = { light_score: d.light?.score ?? null, light_error: d.light_error };
  } else if (opts.router === "hybrid") {
    const d = await hybridRoute(input, { lightLlm: deps.lightLlm }, opts);
    route = d.route;
    assessment = d.rule;
    lightCalls = d.light_called ? 1 : 0;
    basis = d.basis;
  } else {
    assessment = assessRisk(input, opts);
    route = assessment.route;
    basis = "RULE_ONLY";
  }

  const analyze = route === "B_ANALYZE" || (route === "C_UNCERTAIN" && (opts.uncertainPolicy ?? "analyze") === "analyze");
  if (!analyze) {
    return { ...passthrough(input), v3: meta({ pipeline: "v3", route, analyzed: false, llm_calls: 0, light_calls: lightCalls, router_basis: basis, assessment, ...lightExtra }) };
  }

  const analyzed = await runWorkflow(input, { llm });
  const guarded = opts.guards === false ? { output: analyzed, fired: [] } : applyGuards(analyzed, assessment);
  // 표현 단계 (V3 최종 개선, opts.userMessage): 판단이 끝난 뒤 질문 문구만 덧붙인다. 라우터·분석기·가드 결과는 그대로다.
  const out = guarded.output;
  const presented = opts.userMessage && out.status === "clarification_required" ? { ...out, user_message: formatUserMessage(out.questions) } : out;
  return {
    ...presented,
    v3: meta({ pipeline: "v3", route, analyzed: true, llm_calls: llm.calls, light_calls: lightCalls, router_basis: basis, assessment, guards_fired: guarded.fired, ...lightExtra }),
  };
}
