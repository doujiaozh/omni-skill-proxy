/**
 * Omni-Skill-Proxy - shared types and configuration.
 *
 * 纯 Node.js + TypeScript，零原生依赖。
 * Pure Node.js + TypeScript, zero native dependencies.
 */

/** API wire format we are proxying for. Either can be detected from the
 *  upstream request shape or the URL path. */
export type ApiFormat = 'openai' | 'anthropic' | 'unknown';

/** Resolved configuration, sourced from environment variables with defaults. */
export interface ProxyConfig {
  /** Local listen address. 本地监听地址 */
  host: string;
  /** Local listen port. 本地监听端口 */
  port: number;
  /** Upstream base URL, e.g. https://api.openai.com/v1 or https://api.intelligence.io.solutions/api/v1 */
  upstreamBaseUrl: string;
  /** Upstream API key (Bearer token for OpenAI format, x-api-key for Anthropic format). */
  upstreamApiKey: string;
  /** Directory holding *.skill.md files. 存放 .skill.md 的目录 */
  skillsDir: string;
  /** Inject the forced "code-only" system prompt. 是否注入强制系统提示 */
  inject: boolean;
  /** Strip useless chatter from SSE streams / JSON bodies. 是否剥离废话 */
  strip: boolean;
  /** Max characters of pre-code prose held back before a safety flush. */
  maxHoldChars: number;
  /** Extra headers (JSON string) merged into upstream requests. */
  extraHeaders: Record<string, string>;
}

export interface SkillFile {
  /** File name without the .skill.md suffix. 文件名（去 .skill.md） */
  name: string;
  /** Optional front-matter priority, higher loads first. 可选优先级 */
  priority: number;
  /** Raw rule body. 规则正文 */
  body: string;
  /** Absolute path on disk. */
  path: string;
}

/** Normalized chat message (OpenAI style). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: unknown;
}

/** A runnable request context bound to one client connection. */
export interface RequestContext {
  url: string;
  method: string;
  format: ApiFormat;
  streaming: boolean;
}

const truthy = (v: string | undefined): boolean => v === '1' || v === 'true' || v === 'yes';

/**
 * Read configuration from the environment. Everything has a default so the
 * gateway can boot stand-alone (e.g. behind the bundled mock upstream for the
 * one-click demo).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  let extraHeaders: Record<string, string> = {};
  if (env.EXTRA_UPSTREAM_HEADERS) {
    try {
      extraHeaders = JSON.parse(env.EXTRA_UPSTREAM_HEADERS);
    } catch {
      // ignore malformed extra headers / 忽略格式错误的附加头
    }
  }
  return {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8888),
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || '').replace(/\/+$/, ''),
    upstreamApiKey: env.UPSTREAM_API_KEY || env.OPENAI_API_KEY || '',
    skillsDir: env.SKILLS_DIR || 'skills',
    inject: env.INJECT === undefined ? true : truthy(env.INJECT),
    strip: env.STRIP === undefined ? true : truthy(env.STRIP),
    maxHoldChars: Number(env.MAX_HOLD_CHARS || 200),
    extraHeaders,
  };
}
