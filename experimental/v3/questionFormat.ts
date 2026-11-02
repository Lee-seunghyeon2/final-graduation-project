// V3 최종 개선 (2026-10-16): 사용자에게 그대로 보여 줄 질문 문구 하나(user_message)를 만든다.
//
// 문제: V2 질문 생성기(src/clarificationQuestionGenerator.ts)는 question 문자열 안에 번호 목록을 넣고,
// 같은 후보를 options 배열로도 돌려준다. 이를 그대로 출력하면 후보가 두 번(번호 목록 + '선택지:' 줄) 나오고,
// 질문이 여럿이면 번호가 겹친다(1. 질문 / 1. 후보).
// 해결: src/는 바꾸지 않고(V2 production 유지), 표현 단계에서만 후보를 한 번씩 보여 준다.
// 라우터·분석기·가드의 판단은 바꾸지 않는다 — 이미 정해진 questions 를 문구로 옮길 뿐이다.

import type { ClarificationQuestion } from "../../src/types.js";

/** 질문 문장에서 후보 목록을 뺀 첫 줄 (options 가 있을 때만 목록이 question 안에 들어 있다) */
export function questionStem(q: Pick<ClarificationQuestion, "question" | "options">): string {
  return q.options?.length ? q.question.split("\n")[0].trim() : q.question.trim();
}

/**
 * 사용자에게 그대로 전달할 질문 문구.
 * 질문 1개: 머리말 없이 질문 + 번호 후보 목록. 여러 개: 기존 머리말·질문 번호는 그대로 두고 후보는 "-" 목록으로 한 번만
 * (질문 번호와 후보 번호가 겹치지 않게). 후보가 없는 여러 질문은 개선 전 문구와 같다.
 */
export function formatUserMessage(questions: Pick<ClarificationQuestion, "question" | "options">[]): string {
  if (!questions.length) return "";
  const opts = (q: Pick<ClarificationQuestion, "options">, bullet: (i: number) => string) => (q.options ?? []).map((o, i) => `${bullet(i)}${o}`);
  if (questions.length === 1) {
    const q = questions[0];
    return [questionStem(q), ...opts(q, (i) => `${i + 1}. `)].join("\n");
  }
  const lines = ["진행하기 전에 확인이 필요합니다."];
  questions.forEach((q, k) => {
    lines.push(`${k + 1}. ${questionStem(q)}`);
    lines.push(...opts(q, () => "   - "));
  });
  return lines.join("\n");
}
