// LLM 호출을 추상화한 인터페이스.
// TaskClassifier / AmbiguityAnalyzer는 이 인터페이스에만 의존하므로
// 테스트에서는 실제 API 대신 StubLLMClient(테스트 코드에 위치)를 주입해
// 네트워크 호출 없이 핵심 로직(DecisionEngine, PromptBuilder 등)을 검증할 수 있다.

export interface LLMClient {
  /**
   * system/user 프롬프트를 보내고 모델의 텍스트 응답을 그대로 반환한다.
   * 호출부는 응답이 JSON 문자열이라고 가정하고 직접 파싱한다.
   */
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export class AnthropicLLMClient implements LLMClient {
  private client: import("@anthropic-ai/sdk").default | null = null;
  private model: string;

  constructor(model = "claude-sonnet-4-5") {
    this.model = model;
  }

  private async getClient() {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
          "ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다. " +
            "실제 LLM 호출을 사용하려면 API 키를 설정하세요."
        );
      }
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        // identity-linked API 키는 요청을 어느 workspace 예산으로 처리할지
        // anthropic-workspace-id 헤더로 명시해야 한다 (없으면 400 에러).
        defaultHeaders: workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined,
      });
    }
    return this.client;
  }

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const client = await this.getClient();
    const response = await client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("LLM 응답에서 텍스트 블록을 찾을 수 없습니다.");
    }
    return textBlock.text;
  }
}

/** LLM 응답 텍스트에서 JSON 부분만 추출해 파싱한다.
 *  모델이 코드펜스(```json ... ```)로 감싸 응답하거나, reasoning 모델이
 *  <think>...</think> 사고 과정을 답변 앞에 붙이는 경우를 방어적으로 처리한다. */
export function parseJsonResponse<T>(raw: string): T {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fenceMatch = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenceMatch ? fenceMatch[1] : withoutThinking;
  const trimmed = candidate.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw new Error(
      `LLM 응답을 JSON으로 파싱하지 못했습니다: ${(err as Error).message}\n원본: ${raw}`
    );
  }
}
