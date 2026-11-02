import type { ContextBundle } from "./types.js";

// ContextResolver (v0 + v1 보완 B)
// 복잡한 retrieval/scoring 없이 recent_conversation과 document_context를
// LLM 프롬프트에 넣을 수 있는 하나의 텍스트로 정리하는 역할만 한다.
// "현재 Task와 의미적으로 연결되는지"에 대한 판단은 여기서 점수화하지 않고,
// 정리된 컨텍스트를 AmbiguityAnalyzer(LLM)에게 그대로 넘겨 LLM이 직접 판단하게 한다.
//
// v1 보완 B (긴 document_context): v0의 4000자 truncation이 4000자 밖 섹션을 참조하는
// 요청에서 "실제로는 문서에 있는데 안 보여서" 불필요한 clarification을 유발하는 것이
// v1-longdoc fixture(LD1 vs 대조군 LD8)로 확인됐다. Summary/RAG/section retrieval은
// 도입하지 않고, (1) 상한을 12000자로 올리고 (2) 잘린 경우 명시적 표시만 덧붙인다.
// 12000자 근거: 한국어 기준 대략 8~12k 토큰으로 Claude/Gemini context에 여유가 있고,
// 호출당 추가 비용이 크지 않음. (Groq 무료 티어는 TPM 한도상 긴 문서 자체가 어려움 — 별개 제약)

const MAX_DOCUMENT_CHARS = 12000;
const DOCUMENT_TRUNCATION_NOTICE =
  "\n\n[※ 첨부 문서가 길어 앞부분 일부만 제공되었습니다. " +
  "여기 표시되지 않은 뒷부분의 내용을 임의로 추론하지 마세요.]";
const MAX_CONVERSATION_TURNS = 10;

export function buildContextBundle(
  recentConversation: string[] | undefined,
  documentContext: string | undefined
): ContextBundle {
  const trimmedConversation = (recentConversation ?? [])
    .filter((turn) => turn.trim().length > 0)
    .slice(-MAX_CONVERSATION_TURNS);

  const documentText = documentContext?.trim() ?? "";
  const trimmedDocument = !documentText
    ? null
    : documentText.length > MAX_DOCUMENT_CHARS
      ? documentText.slice(0, MAX_DOCUMENT_CHARS) + DOCUMENT_TRUNCATION_NOTICE
      : documentText;

  return {
    recent_conversation: trimmedConversation,
    document_context: trimmedDocument,
  };
}

export function formatContextForPrompt(bundle: ContextBundle): string {
  const parts: string[] = [];

  if (bundle.recent_conversation.length > 0) {
    const numbered = bundle.recent_conversation
      .map((turn, i) => `  ${i + 1}. ${turn}`)
      .join("\n");
    parts.push(`[최근 대화 (오래된 순)]\n${numbered}`);
  } else {
    parts.push("[최근 대화]\n(없음)");
  }

  if (bundle.document_context) {
    parts.push(`[첨부 문서 내용]\n${bundle.document_context}`);
  } else {
    parts.push("[첨부 문서 내용]\n(없음)");
  }

  return parts.join("\n\n");
}
