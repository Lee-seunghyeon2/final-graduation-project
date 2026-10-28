import { analyzeAmbiguities, analyzeRequest } from "./ambiguityAnalyzer.js";
import { generateClarificationQuestions } from "./clarificationQuestionGenerator.js";
import { buildContextBundle, formatContextForPrompt } from "./contextResolver.js";
import { decideAll } from "./decisionEngine.js";
import type { LLMClient } from "./llm/client.js";
import { buildImprovedPrompt } from "./promptBuilder/index.js";
import type {
  AmbiguityFinding,
  AnalysisResult,
  RawAmbiguityFinding,
  Task,
  WorkflowInput,
  WorkflowOutput,
} from "./types.js";

// 메인 워크플로우:
//   request + recent_conversation + document_context
//   -> Task 판별 -> 모호성 탐지(LLM) -> Decision -> (질문 또는 improved_prompt)
//
// previous_analysis + answers가 함께 들어오면 새로 분석하지 않고
// 이전에 CLARIFICATION_REQUIRED였던 항목을 답변으로 확정한 뒤 이어서 처리한다.
// (v0에서는 세션 DB 없이, 호출자가 이전 AnalysisResult를 그대로 다시 넘겨주는 방식으로 확장성을 확보)
//
// v2: task_hint가 없을 때 classifyTask(LLM #1) + analyzeAmbiguities(LLM #2)로 나뉘어 있던
// preprocessing을 analyzeRequest(LLM 1회)로 합쳤다. task_hint가 있으면(예: 호출자가 이미
// task를 알고 있는 경우) 기존과 동일하게 analyzeAmbiguities만 호출한다 — 이 경로는 v1에서도
// 이미 classifyTask를 부르지 않았으므로 동작/호출 수 변화가 없다. taskClassifier.ts는 삭제하지
// 않았다(자체 단위테스트·하위 호환 유지) — production은 더 이상 이를 호출하지 않는다.

export interface WorkflowDeps {
  llm: LLMClient;
}

export async function runWorkflow(
  input: WorkflowInput,
  deps: WorkflowDeps
): Promise<WorkflowOutput> {
  const contextBundle = buildContextBundle(input.recent_conversation, input.document_context);

  if (input.previous_analysis && input.answers) {
    return continueFromAnswers(input.previous_analysis, input.answers, contextBundle);
  }

  return runFreshAnalysis(input, deps, contextBundle);
}

async function runFreshAnalysis(
  input: WorkflowInput,
  deps: WorkflowDeps,
  contextBundle: ReturnType<typeof buildContextBundle>
): Promise<WorkflowOutput> {
  const contextText = formatContextForPrompt(contextBundle);
  const request = input.current_user_request;

  let task: Task;
  let rawFindings: RawAmbiguityFinding[];
  if (input.task_hint) {
    // task를 이미 알고 있으면(v0/v1과 동일) LLM 호출 1회(analyzeAmbiguities)만 필요하다.
    task = input.task_hint;
    rawFindings = await analyzeAmbiguities(deps.llm, task, request, contextText);
  } else {
    // v2: task 분류 + ambiguity 분석을 LLM 호출 1회(analyzeRequest)로 함께 수행한다.
    const analyzed = await analyzeRequest(deps.llm, request, contextText);
    task = analyzed.task;
    rawFindings = analyzed.ambiguities;
  }
  const decided = decideAll(rawFindings);
  const { questions, findings } = generateClarificationQuestions(decided);

  const analysis: AnalysisResult = {
    task,
    original_request: request,
    ambiguities: findings,
    questions: questions.map((q) => q.question),
  };

  if (questions.length > 0) {
    return { status: "clarification_required", questions, analysis };
  }

  const improved_prompt = buildImprovedPrompt(analysis, contextBundle);
  return { status: "ready", improved_prompt, analysis };
}

function continueFromAnswers(
  previousAnalysis: AnalysisResult,
  answers: Record<string, string>,
  contextBundle: ReturnType<typeof buildContextBundle>
): WorkflowOutput {
  const updated: AmbiguityFinding[] = previousAnalysis.ambiguities.map((f) => {
    if (f.decision === "CLARIFICATION_REQUIRED" && f.question_id && answers[f.question_id]) {
      return {
        ...f,
        decision: "RESOLVED",
        resolved_value: answers[f.question_id],
      };
    }
    return f;
  });

  const { questions, findings } = generateClarificationQuestions(updated);

  const analysis: AnalysisResult = {
    ...previousAnalysis,
    ambiguities: findings,
    questions: questions.map((q) => q.question),
  };

  if (questions.length > 0) {
    return { status: "clarification_required", questions, analysis };
  }

  const improved_prompt = buildImprovedPrompt(analysis, contextBundle);
  return { status: "ready", improved_prompt, analysis };
}
