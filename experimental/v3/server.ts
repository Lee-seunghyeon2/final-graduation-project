#!/usr/bin/env node
// V3 실험용 MCP 서버 진입점 (production src/index.ts 와 별도 — Claude Desktop 설정에는 연결하지 않았다).
//
// 같은 analyze_prompt tool 을 노출하고, 환경변수로 경로를 전환한다.
//   KPI_PIPELINE = v2 (기본, production 과 동일) | v3 (선택적 분석)
//   KPI_ROUTER   = rule (기본) | hybrid (경량 모델 라우터 사용; KPI_LIGHT_MODEL 필요)
//   KPI_LIGHT_MODEL = 경량 라우터 모델 ID (예: 유료 실험에서 정할 Haiku 계열)
//   KPI_UNCERTAIN = analyze (기본) | passthrough
//   KPI_ROUTER_VERSION = 0.1 (기본, 기존 결과 재현) | 0.2 (최종 V3: riskRouterV02 + 경량 라우터, KPI_LIGHT_THRESHOLD 기본 50)
// 최종 V3 구성(파일럿·Final-120과 같음): KPI_PIPELINE=v3 KPI_ROUTER_VERSION=0.2 KPI_ROUTER=hybrid KPI_LIGHT_MODEL=claude-haiku-5-5
// pipeline v3 에서는 질문 문구(user_message)를 덧붙이고, 호스트가 그대로 전달하도록 설명(V3_TOOL_DESCRIPTION)을 바꾼다.
// 실행 예 (개발용): npx tsx experimental/v3/server.ts
//
// 한계: 이 서버도 호스트가 tool 을 호출한 뒤에야 실행된다. tool 호출 자체(인자 생성·추가 왕복)는 줄이지 못한다.

try {
  process.loadEnvFile();
} catch {
  // .env 없음 — 무시
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnthropicLLMClient } from "../../src/llm/client.js";
import type { AnalysisResult } from "../../src/types.js";
import { runSelectiveWorkflow, type SelectiveOptions } from "./selectiveWorkflow.js";
import { BASE_TOOL_DESCRIPTION, V3_TOOL_DESCRIPTION } from "./toolDescription.js";

const opts: SelectiveOptions = {
  pipeline: process.env.KPI_PIPELINE === "v3" ? "v3" : "v2",
  router: process.env.KPI_ROUTER === "hybrid" ? "hybrid" : "rule",
  uncertainPolicy: process.env.KPI_UNCERTAIN === "passthrough" ? "passthrough" : "analyze",
  routerVersion: process.env.KPI_ROUTER_VERSION === "0.2" ? "0.2" : "0.1",
  lightThreshold: process.env.KPI_LIGHT_THRESHOLD ? Number(process.env.KPI_LIGHT_THRESHOLD) : undefined,
  userMessage: process.env.KPI_PIPELINE === "v3",
};
const llm = new AnthropicLLMClient();
const lightLlm = process.env.KPI_LIGHT_MODEL ? new AnthropicLLMClient(process.env.KPI_LIGHT_MODEL) : undefined;

const server = new McpServer({ name: "korean-prompt-improver-v3-experimental", version: "0.0.1" });

server.registerTool(
  "analyze_prompt",
  {
    title: "한국어 프롬프트 모호성 분석 및 개선 (V3 실험)",
    description: opts.pipeline === "v3" ? V3_TOOL_DESCRIPTION : BASE_TOOL_DESCRIPTION,
    inputSchema: {
      current_user_request: z.string().describe("사용자의 현재 요청 원문"),
      recent_conversation: z.array(z.string()).optional().describe("최근 대화 내역 (오래된 순서)"),
      document_context: z.string().optional().describe("첨부 문서 내용 또는 요약"),
      task_hint: z.enum(["planning", "writing"]).optional(),
      previous_analysis: z.string().optional(),
      answers: z.record(z.string()).optional(),
    },
  },
  async (args) => {
    const previous_analysis: AnalysisResult | undefined = args.previous_analysis ? (JSON.parse(args.previous_analysis) as AnalysisResult) : undefined;
    const result = await runSelectiveWorkflow({ ...args, previous_analysis }, { llm, lightLlm }, opts);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }
);

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`korean-prompt-improver V3 experimental (pipeline=${opts.pipeline}, router=${opts.router}, router_version=${opts.routerVersion}) running on stdio`);
}

main().catch((err) => {
  console.error("MCP 서버 시작 실패:", err);
  process.exit(1);
});
