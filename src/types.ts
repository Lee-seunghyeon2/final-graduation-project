// v0 공유 타입 정의
// 여기서 정의한 타입은 모든 모듈(TaskClassifier, AmbiguityAnalyzer,
// DecisionEngine, ClarificationQuestionGenerator, PromptBuilder, workflow)이 공유한다.

export type Task = "planning" | "writing";

export type AmbiguityType =
  | "reference"
  | "omission"
  | "degree"
  | "comparison"
  | "scope";

export type ContextSupport = "strong" | "medium" | "weak";

export type Impact = "high" | "low";

export type Decision = "RESOLVED" | "SAFE_INFERENCE" | "CLARIFICATION_REQUIRED";

/** AmbiguityAnalyzer(LLM)가 하나의 모호한 표현에 대해 산출하는 원시 판단 결과.
 *  decision/resolved_value는 아직 없음 — DecisionEngine이 결정론적으로 채운다. */
export interface RawAmbiguityFinding {
  type: AmbiguityType;
  expression: string;
  candidates: string[];
  context_support: ContextSupport;
  impact: Impact;
  /** 문맥상 candidates 중 가장 유력한 해석 (있다면). SAFE_INFERENCE/RESOLVED 시 사용. */
  top_candidate?: string | null;
}

/** DecisionEngine이 RawAmbiguityFinding에 decision/resolved_value를 더해 완성한 결과. */
export interface AmbiguityFinding extends RawAmbiguityFinding {
  decision: Decision;
  resolved_value: string | null;
  /** CLARIFICATION_REQUIRED일 때만 부여되는 질문 식별자 (q1, q2, q3 ...) */
  question_id?: string;
}

export interface ClarificationQuestion {
  id: string;
  type: AmbiguityType;
  question: string;
  options?: string[];
}

export interface AnalysisResult {
  task: Task;
  original_request: string;
  ambiguities: AmbiguityFinding[];
  questions: string[];
}

export interface ContextBundle {
  recent_conversation: string[];
  document_context: string | null;
}

export interface WorkflowInput {
  current_user_request: string;
  recent_conversation?: string[];
  document_context?: string;
  task_hint?: Task;
  /** 이전 analyze_prompt 호출에서 받은 AnalysisResult(JSON)를 그대로 전달하면
   *  answers와 함께 clarification 이어가기 흐름으로 처리된다. */
  previous_analysis?: AnalysisResult;
  /** question id -> 사용자 답변 텍스트 */
  answers?: Record<string, string>;
}

export type WorkflowOutput =
  | {
      status: "clarification_required";
      questions: ClarificationQuestion[];
      analysis: AnalysisResult;
    }
  | {
      status: "ready";
      improved_prompt: string;
      analysis: AnalysisResult;
    };
