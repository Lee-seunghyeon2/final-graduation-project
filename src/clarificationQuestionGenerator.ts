import type { AmbiguityFinding, AmbiguityType, ClarificationQuestion } from "./types.js";

// v0 ClarificationQuestionGenerator
// LLM을 다시 호출하지 않고 템플릿으로 질문을 생성한다 (결정론적, 테스트 용이).
// - 최대 3개까지만 생성
// - 자유 입력보다 선택형(후보 나열) 질문을 우선
// - 우선순위: 작업 자체를 바꾸는 정보 > 대상/범위 > 결과 구조에 큰 영향 > 스타일(degree는 거의 안 옴)

const MAX_QUESTIONS = 3;

const TYPE_PRIORITY: Record<AmbiguityType, number> = {
  omission: 1, // 작업 자체를 바꾸는 핵심 정보
  reference: 2, // 작업 대상
  scope: 2, // 수정 범위
  comparison: 3, // 결과 구조에 영향을 주는 비교 기준
  degree: 4, // 스타일/세부 조건 (가능하면 질문하지 않음)
};

function buildQuestionText(finding: AmbiguityFinding): { question: string; options?: string[] } {
  const unique = Array.from(new Set(finding.candidates.map((c) => c.trim()).filter(Boolean)));

  if (unique.length >= 2) {
    const optionLines = unique.map((c, i) => `${i + 1}. ${c}`).join("\n");
    return {
      question: `"${finding.expression}"은(는) 다음 중 무엇을 의미하나요?\n${optionLines}`,
      options: unique,
    };
  }

  // candidates가 0개인 경우 (예: degree 유형에서 기준값 자체가 없음)
  switch (finding.type) {
    case "degree":
      return {
        question: `"${finding.expression}"에 대해 지켜야 할 구체적인 기준이 있다면 알려주세요. (예: 글자 수, 분량, 페이지 수 등)`,
      };
    default:
      return {
        question: `"${finding.expression}"이(가) 정확히 무엇을 가리키는지 알려주세요.`,
      };
  }
}

export function generateClarificationQuestions(findings: AmbiguityFinding[]): {
  questions: ClarificationQuestion[];
  findings: AmbiguityFinding[];
} {
  const needsClarification = findings.filter((f) => f.decision === "CLARIFICATION_REQUIRED");

  const sorted = [...needsClarification].sort(
    (a, b) => TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type]
  );
  const selected = sorted.slice(0, MAX_QUESTIONS);
  const selectedSet = new Set(selected);

  const questions: ClarificationQuestion[] = [];
  let counter = 1;

  const updatedFindings = findings.map((f) => {
    if (f.decision !== "CLARIFICATION_REQUIRED" || !selectedSet.has(f)) {
      return f;
    }
    const id = `q${counter++}`;
    const { question, options } = buildQuestionText(f);
    questions.push({ id, type: f.type, question, options });
    return { ...f, question_id: id };
  });

  return { questions, findings: updatedFindings };
}
