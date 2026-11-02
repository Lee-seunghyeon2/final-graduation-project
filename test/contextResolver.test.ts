import { describe, expect, it } from "vitest";
import { buildContextBundle, formatContextForPrompt } from "../src/contextResolver.js";

// v1 보완 B: 문서 상한(12000자) + 잘린 경우 명시적 표시.
// LLM을 호출하지 않는 순수 로직이라 stub 없이 검증한다.

const TRUNCATION_MARK = "앞부분 일부만 제공되었습니다";

describe("ContextResolver - document_context 상한/절단 표시", () => {
  it("12000자 이하 문서는 그대로 두고 절단 표시를 붙이지 않는다", () => {
    const doc = "가".repeat(12000);
    const bundle = buildContextBundle(undefined, doc);
    expect(bundle.document_context).toBe(doc);
    expect(bundle.document_context).not.toContain(TRUNCATION_MARK);
  });

  it("12000자 초과 문서는 12000자로 자르고 절단 표시를 덧붙인다", () => {
    const doc = "나".repeat(15000);
    const bundle = buildContextBundle(undefined, doc);
    expect(bundle.document_context).not.toBeNull();
    expect(bundle.document_context!.startsWith("나".repeat(12000))).toBe(true);
    expect(bundle.document_context).toContain(TRUNCATION_MARK);
    // 잘린 본문 자체는 정확히 12000자 (표시 문구는 그 뒤에 별도로 붙는다)
    expect(bundle.document_context!.slice(0, 12000)).toBe("나".repeat(12000));
  });

  it("절단 표시가 프롬프트 텍스트에도 그대로 전달된다", () => {
    const bundle = buildContextBundle(undefined, "다".repeat(13000));
    const text = formatContextForPrompt(bundle);
    expect(text).toContain(TRUNCATION_MARK);
  });

  it("빈/공백 문서는 null", () => {
    expect(buildContextBundle(undefined, "   ").document_context).toBeNull();
    expect(buildContextBundle(undefined, undefined).document_context).toBeNull();
  });
});
