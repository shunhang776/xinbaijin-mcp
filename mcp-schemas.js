import { z } from "zod";

// 所有 4 个 MCP 工具共享的 repository 参数
// 提取为独立模块：worker.js 和 test 共同导入，避免重复定义
export const REPOSITORY_PARAM = z
  .enum(["xinbaijin", "xinbaijin-mcp"])
  .describe("目标仓库（必填）");

// ---------------------------------------------------------------------------
// 完整工具输入 schema — 生产代码与测试共用，消除定义不一致风险
// ---------------------------------------------------------------------------

export const GET_LATEST_HANDOFF_SCHEMA = {
  repository: REPOSITORY_PARAM
};

export const GET_PATCH_SCHEMA = z.object({
  repository: REPOSITORY_PARAM,
  sha: z
    .string()
    .trim()
    .min(7)
    .optional()
    .describe("可选提交 SHA；省略时读取 dev 分支最新提交。")
});

export const SUBMIT_REVIEW_SCHEMA = z.object({
  repository: REPOSITORY_PARAM,
  commit: z
    .string()
    .regex(/^[0-9a-fA-F]{40}$/)
    .describe("本次审查对应的完整 Git commit SHA。"),
  verdict: z.enum(["approved", "changes_requested", "blocked"]),
  summary: z.string().trim().min(1).max(10000),
  findings: z
    .array(
      z.object({
        severity: z.enum(["critical", "high", "medium", "low", "info"]),
        file: z.string().trim().min(1).max(500),
        line: z.number().int().positive().nullable().optional(),
        title: z.string().trim().min(1).max(300),
        description: z.string().trim().min(1).max(5000),
        recommendation: z.string().trim().min(1).max(5000)
      })
    )
    .max(100)
});

export const GET_FILE_CONTENT_SCHEMA = {
  path: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("仓库相对路径，例如 worker.js 或 src/index.js。"),
  ref: z
    .string()
    .regex(/^[0-9a-fA-F]{40}$/)
    .describe("要读取的完整 Git commit SHA。"),
  repository: REPOSITORY_PARAM
};
