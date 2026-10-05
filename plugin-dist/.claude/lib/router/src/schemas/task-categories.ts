// Task categories -- the STABLE Layer-1 vocabulary (arch SS10.2). Defined by what the
// factory does, not by which models exist. Mirrors .claude/model-router.json task_categories.
// v5.0 Sprint 1 Commit 3. Arch 9d7294c.

export const TASK_CATEGORIES = [
  "architecture",
  "code_build",
  "quick_edit",
  "vision_ocr",
  "x_data",
  "research",
  "research_cited",
  "data_qa",
  "marketing_copy",
  "agent_dispatch",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export function isTaskCategory(v: string): v is TaskCategory {
  return (TASK_CATEGORIES as readonly string[]).includes(v);
}
