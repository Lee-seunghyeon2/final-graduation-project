import { describe, expect, it } from "vitest";
import { parseJsonResponse } from "../src/llm/client.js";

describe("parseJsonResponse", () => {
  it("순수 JSON 문자열을 파싱한다", () => {
    expect(parseJsonResponse<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("코드펜스로 감싼 JSON을 파싱한다", () => {
    const raw = '```json\n{"a": 1}\n```';
    expect(parseJsonResponse<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it("reasoning 모델의 <think> 블록을 제거하고 파싱한다 (Groq qwen3.6 등)", () => {
    const raw = '<think>\n어떤 값을 넣을지 고민 중...\n여러 줄에 걸친 사고 과정\n</think>\n{"a": 1}';
    expect(parseJsonResponse<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it("<think> 블록 + 코드펜스가 함께 있어도 파싱한다", () => {
    const raw = '<think>고민 중</think>\n```json\n{"a": 1}\n```';
    expect(parseJsonResponse<{ a: number }>(raw)).toEqual({ a: 1 });
  });
});
