import { z } from "zod";

// MCP 工具共享的 repository 参数 schema — 所有 4 个工具必须使用此定义
// 提取为独立模块以便测试，避免 worker.js 中的 Cloudflare Workers 专属 import
// 导致 Vitest（Node.js 环境）解析失败
export const REPOSITORY_PARAM = z
  .enum(["xinbaijin", "xinbaijin-mcp"])
  .describe("目标仓库（必填）");
