import type { AnalysisResult, ContextBundle } from "../types.js";
import { buildPlanningPrompt } from "./planningPromptBuilder.js";
import { buildWritingPrompt } from "./writingPromptBuilder.js";

export function buildImprovedPrompt(analysis: AnalysisResult, context: ContextBundle): string {
  switch (analysis.task) {
    case "planning":
      return buildPlanningPrompt(analysis, context);
    case "writing":
      return buildWritingPrompt(analysis, context);
  }
}
