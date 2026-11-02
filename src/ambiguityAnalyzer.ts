import { z } from "zod";
import type { LLMClient } from "./llm/client.js";
import { parseJsonResponse } from "./llm/client.js";
import type { RawAmbiguityFinding, Task } from "./types.js";

// AmbiguityAnalyzer (v0 + v1 보완 A + v2-A + v2 통합 호출)
// 형태소 분석기/별도 NLP 모델 없이, LLM에게 5개 모호성 유형의 정의와 판단 기준을
// 그대로 프롬프트로 제공해 "LLM 기반 구조적 판단"으로 탐지한다.
// 여기서는 후보(candidates)/문맥근거(context_support)/영향도(impact)만 산출하고,
// 최종 RESOLVED/SAFE_INFERENCE/CLARIFICATION_REQUIRED 판정은 DecisionEngine이
// 결정론적으로 내린다 (LLM이 매번 다르게 판단해 테스트가 흔들리는 것을 방지).
//
// v1 보완 A (Recent-context Priority): 여러 턴 대화에서 후보가 여러 시점에서 나올 때,
// 가장 최근에 명시적으로 다룬 작업 대상을 우선하고 명백히 전환된 이전 대상은 후보에서
// 제외하도록 SYSTEM_PROMPT에 지침만 추가했다. turn-weight 계산·상태 저장은 하지 않는다
// (contextResolver/DecisionEngine/타입 변경 없음 — 프롬프트 지침 한정).
//
// v2-A (omission 판단 기준 보완): "여러 답이 가능하다" ≠ "질문이 반드시 필요하다"를
// 구분하는 지침을 omission 유형에 한정해 추가했다 (TAXONOMY_BODY 안, impact 항목).
// reference/scope/comparison의 recency 규칙, degree 규칙은 문자 그대로 보존했다.
// DecisionEngine/타입/다른 4개 유형의 정의는 변경하지 않았다 — 프롬프트 지침 한정.
//
// v2 통합 호출: task_hint가 없을 때 production(workflow.ts)이 별도 classifyTask LLM
// 호출을 하지 않고, 이 파일의 analyzeRequest()가 "task 분류 + ambiguity 분석"을 한 번의
// LLM 호출로 함께 수행한다 (UNIFIED_SYSTEM_PROMPT). task_hint가 이미 있으면 기존과 동일하게
// analyzeAmbiguities()만 호출한다(호출 수 변화 없음 — 기존 동작 그대로).
// taskClassifier.ts는 삭제하지 않았다(호환성 유지, 자체 단위테스트 존재) — 다만 production
// workflow는 더 이상 이를 호출하지 않는다.

// NOTE: 외부 benchmark 평가 harness(scripts/external-eval)가 "현재 production 프롬프트"를
// 정확히 재현하기 위해 이 상수를 import한다. 문자열/동작은 임의로 바꾸지 않는다(v2-A 변경만 반영).

// [Task] 섹션: analyzeAmbiguities()(task가 이미 주어짐, 참고용 정의)와
// analyzeRequest()(task를 직접 분류해야 함, 지시문) 둘이 다르므로 분리한다.
const TASK_SECTION_GIVEN = `너는 한국어 사용자의 작업 요청에서 5가지 유형의 모호성을 탐지하는 분석기다.
아래 정의를 정확히 따르라.

[Task]
- planning: 프로젝트/학업/업무 계획, 첨부 문서 기반 실행 계획
- writing: 보고서/자기소개서/기획서 등 자료 기반 문서 작성/수정`;

const TASK_SECTION_CLASSIFY = `너는 한국어 사용자의 작업 요청을 분류하고, 그 안에서 5가지 유형의 모호성을 탐지하는 분석기다.
아래 정의를 정확히 따르라.

[Task 분류] — 요청을 다음 두 가지 중 하나로 분류해 결과의 "task" 필드에 넣어라.
- planning: 프로젝트/학업/업무 계획 수립, 첨부 문서를 기반으로 한 실행 계획 작성
- writing: 보고서, 자기소개서, 기획서 등 자료 기반 문서의 작성/수정`;

// SYSTEM_PROMPT / UNIFIED_SYSTEM_PROMPT가 공유하는 본문. 5개 유형 정의와 판단 기준은
// task를 누가 정하든(주어짐 vs 직접 분류) 동일해야 하므로 하나로 유지해 중복/불일치를 막는다.
const TAXONOMY_BODY = `[모호성 유형 5개]
1. reference (지시 대상 모호성): "이거", "그거", "이 부분", "그 기능", "위에 거" 등
2. omission (성분 생략): "해줘", "바꿔줘", "빼줘", "정리해줘" 등 대상/목적이 생략된 표현
3. degree (정도 모호성): "좀", "많이", "적당히", "조금 더", "길게", "짧게" 등. 단, "단편"/"도입부"/
   "서론"/"결론"/"요약문"/"초안" 같은 장르·문서 구조·형식을 나타내는 명사는 그 자체만으로는
   degree 표현이 아니다 (예: "아주 짧은 단편"에서 "단편"은 degree가 아니지만 "아주 짧은"은 degree
   후보가 될 수 있다).
4. comparison (비교 기준 모호성): "전처럼", "비슷하게", "아까처럼", "이거랑 비슷하게" 등
5. scope (범위 모호성): "여기만", "이 부분만", "일부만", "전체적으로", "필요한 부분만" 등

[각 표현마다 판단할 것]
- expression: 모호한 표현 원문 그대로
- candidates: 현재 요청/최근 대화/첨부 문서에서 찾을 수 있는 "구체적인 해석 후보" 목록.
  - 문맥에서 후보를 전혀 찾을 수 없으면 빈 배열([])로 둔다.
  - 후보는 실제 지칭 대상/기준/범위를 설명하는 짧은 한국어 구절로 작성한다 (예: "자동 저장 기능").
  - (reference/scope/comparison 한정) 최근 대화가 여러 턴에 걸쳐 서로 다른 작업 대상을 다뤘다면,
    지시 표현("이거", "그거", "이 부분", "전처럼" 등)이 가리키는 대상은 가장 최근 턴에서 명시적으로
    다룬 대상을 우선한다. 대화가 이전 대상에서 새 대상으로 명백히 전환됐다면(예: "이제 X 해보자")
    전환 이전 대상은 후보에서 뺀다. 단, 사용자가 특정 과거 대상을 명시하거나("아까 서론에서",
    "지원동기로 돌아가서") 직전 턴이 단순 메타 질문("몇 자야?")이면 그 신호를 최근성보다 우선한다.
    이렇게 해서 지시 대상이 하나로 특정되면 후보 1개로 제시하고 하위 범위로 임의 분할하지 않으며
    context_support를 strong으로 둔다. 그래도 둘 이상이면 후보를 모두 남긴다. 단, 삭제·제거·교체·
    덮어쓰기처럼 원본을 되돌리기 어렵게 바꾸는 편집 요청에서는 더 신중하게 판단한다. 이때 후보는
    문맥에서 실제로 식별되는 대상이어야 하며, 모호한 표현을 새로운 식별 정보 없이 그대로 풀어쓴
    것에 불과하면 유효한 후보로 세지 않는다(문맥에서 후보를 전혀 찾을 수 없으면 빈 배열로 둔다는
    규칙을 그대로 적용한다). 이런 경우와 대상·범위가 여전히 여러 해석으로 남는 경우 모두, 최근성
    이나 표현을 되풀이한 서술만으로 후보를 하나로 좁히지 말고 impact를 high로 유지한다.
  - 이 규칙은 지시 표현이 가리키는 "대상 후보"에만 적용된다. omission 후보나 impact 판단은 바꾸지 않는다.
    지시/비교 표현의 대상을 좁히면서 같은 문장의 생략 동사("만들어줘", "해줘" 등)까지 덩달아
    여러 갈래로 쪼개지 마라. 생략 동사는 평소 기준대로만 판단한다.
  - [첨부 문서 내용]에 "앞부분 일부만 제공되었습니다" 표시가 있으면 그 문서는 발췌본이다.
    표시되지 않은 부분의 내용을 근거 없이 지어내지 마라. 요청이 가리키는 섹션·기준·수치가 제공된
    범위에서 확인되지 않으면 그 후보의 context_support를 "weak"로 낮추거나 candidates를 비워 둔다.
- context_support: 후보를 뒷받침하는 문맥 근거의 강도. "strong" | "medium" | "weak" 중 하나.
- impact: 후보 중 어떤 것을 선택하느냐에 따라 작업 대상/내용/결과 구조가 실제로 크게
  달라지는지 여부. "high" | "low" 중 하나.
  - degree 유형에서: 이미 구체적인 기준값이 요청 자체에 명시돼 있으면(예: "500자 이내로") 애초에
    degree ambiguity로 보지 않는다. 사용자가 제한 준수를 강조하지 않은 일반적인 정성적 표현
    ("조금 더 간결하게", "좀 짧게", "자연스럽게", "간단하게" 등)은 모델이 일반적인 언어적 의미로
    자연스럽게 수행할 수 있으므로 기본적으로 impact를 "low"로 둔다. 단, 사용자가 글자수/분량 등
    제한 준수를 강조했지만 실제 기준값이 문맥 어디에도 없다면 candidates를 빈 배열로, impact는
    "high"로 표시하라.
  - omission 유형에서: 누락된 것이 모델이 새로 작성해야 할 문구·표현 자체(산출물 본문, 예: 사과
    메일의 구체적 사과 문구)라면 그것을 쓰는 일 자체가 요청의 본체이므로 애초에 omission으로 보지
    않는다. 그 외의 경우, "여러 답이 가능하다"는 사실 자체는 clarification의 근거가 아니다. 누락된
    정보가 산출물의 핵심 가치(사용자가 실제로 원하는 내용 그 자체)인지, 문서의 구조·톤·목적은
    유지한 채 비워도 되는 주변부 정보인지를 먼저 구분한다. 주변부 정보(예: 안내 메일의 날짜·
    장소·금액·계좌·기한)는 placeholder나 사실을 특정하지 않는 일반적인 표현으로 안전하게 남길
    수 있으므로 impact를 "low"로 둔다 — 이때 존재하지 않는 구체적 사실을 새로 지어내지 말고
    placeholder 또는 일반적인 표현을 쓴다. 반대로 누락된 정보가 핵심 가치 자체라서 placeholder로
    채우면 빈 틀만 남는 경우(예: "자기소개서 써줘"의 실제 경험, "우리 동네 카페 추천해줘"의 위치)는
    impact를 "high"로 유지한다. 창작 세부사항이나 여러 합리적 선택지 중 아무거나로 자연스럽게
    진행 가능한 열린 항목(예: "창업 아이디어 3개랑 시작 방법을 정리해줘"에서 분야·자본 규모)은
    애초에 omission으로 표시하지 않는다.
- top_candidate: candidates 중 가장 유력한 해석 (있다면). 없으면 null.

모호성이 전혀 없는 명확한 요청이면 빈 배열을 반환하라.
표현이 요청 안에 실제로 등장하지 않으면 만들어내지 마라.`;

const AMBIGUITIES_JSON_FORMAT = `반드시 아래 JSON 형식으로만 답하라. 다른 설명, 마크다운, 주석을 추가하지 마라.
{
  "ambiguities": [
    {
      "type": "reference" | "omission" | "degree" | "comparison" | "scope",
      "expression": "string",
      "candidates": ["string", ...],
      "context_support": "strong" | "medium" | "weak",
      "impact": "high" | "low",
      "top_candidate": "string" | null
    }
  ]
}`;

const UNIFIED_JSON_FORMAT = `반드시 아래 JSON 형식으로만 답하라. 다른 설명, 마크다운, 주석을 추가하지 마라.
{
  "task": "planning" | "writing",
  "ambiguities": [
    {
      "type": "reference" | "omission" | "degree" | "comparison" | "scope",
      "expression": "string",
      "candidates": ["string", ...],
      "context_support": "strong" | "medium" | "weak",
      "impact": "high" | "low",
      "top_candidate": "string" | null
    }
  ]
}`;

/** task_hint가 이미 있을 때 사용 (기존 v0/v1과 동일한 프롬프트 — task는 주어진 값을 참고만 한다). */
export const SYSTEM_PROMPT = `${TASK_SECTION_GIVEN}\n\n${TAXONOMY_BODY}\n\n${AMBIGUITIES_JSON_FORMAT}`;

/** task_hint가 없을 때 사용 (v2) — task 분류 + ambiguity 분석을 한 번의 LLM 호출로 함께 수행한다. */
export const UNIFIED_SYSTEM_PROMPT = `${TASK_SECTION_CLASSIFY}\n\n${TAXONOMY_BODY}\n\n${UNIFIED_JSON_FORMAT}`;

const RawFindingSchema = z.object({
  type: z.enum(["reference", "omission", "degree", "comparison", "scope"]),
  expression: z.string(),
  candidates: z.array(z.string()),
  context_support: z.enum(["strong", "medium", "weak"]),
  impact: z.enum(["high", "low"]),
  top_candidate: z.string().nullable().optional(),
});

const ResponseSchema = z.object({
  ambiguities: z.array(RawFindingSchema),
});

const UnifiedResponseSchema = z.object({
  task: z.enum(["planning", "writing"]),
  ambiguities: z.array(RawFindingSchema),
});

/** task가 이미 알려진 경우(task_hint) 사용 — v0/v1과 동일, 동작 변경 없음. */
export async function analyzeAmbiguities(
  llm: LLMClient,
  task: Task,
  request: string,
  contextText: string
): Promise<RawAmbiguityFinding[]> {
  const userPrompt = `[Task]\n${task}\n\n[사용자 요청]\n${request}\n\n[문맥]\n${contextText}`;
  const raw = await llm.complete(SYSTEM_PROMPT, userPrompt);
  const parsed = parseJsonResponse<unknown>(raw);
  const validated = ResponseSchema.parse(parsed);
  return validated.ambiguities.map((f) => ({
    ...f,
    top_candidate: f.top_candidate ?? null,
  }));
}

/** v2: task_hint가 없을 때 사용 — task 분류 + ambiguity 분석을 LLM 호출 1회로 수행한다
 *  (기존에는 classifyTask + analyzeAmbiguities 2회 호출이었다). */
export async function analyzeRequest(
  llm: LLMClient,
  request: string,
  contextText: string
): Promise<{ task: Task; ambiguities: RawAmbiguityFinding[] }> {
  const userPrompt = `[사용자 요청]\n${request}\n\n[문맥]\n${contextText}`;
  const raw = await llm.complete(UNIFIED_SYSTEM_PROMPT, userPrompt);
  const parsed = parseJsonResponse<unknown>(raw);
  const validated = UnifiedResponseSchema.parse(parsed);
  return {
    task: validated.task,
    ambiguities: validated.ambiguities.map((f) => ({
      ...f,
      top_candidate: f.top_candidate ?? null,
    })),
  };
}
