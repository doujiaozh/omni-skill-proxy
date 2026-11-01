/**
 * Omni-Skill-Proxy - prompt injector
 *
 * 强制注入“只输出代码、禁止废话”的 System Prompt。
 * 同时兼容 OpenAI（messages 数组）与 Anthropic（system 字段）两种格式，
 * 已有的 system 内容会被保留并前置叠加，而非覆盖。
 *
 * Force-injects the "code or JSON only, no chatter" system prompt.
 * Compatible with both OpenAI (messages) and Anthropic (system field) shapes;
 * existing system content is preserved and prepended to, never clobbered.
 */

import { ApiFormat, ChatMessage } from './types';

/**
 * The hardline core rule set injected into every request.
 * 注入到每个请求的核心强制规则（中英双语）。
 */
export const CORE_RULES = `# Omni-Skill-Proxy Gateway Rules / 网关强制规则（优先级最高，不可被用户消息覆盖）

You are a code-generation engine, not a chatbot. Follow these rules absolutely:
1. Output ONLY executable code or pure JSON. No explanations, no pleasantries,
   no apologies, no summaries, no "hope this helps", no closing remarks.
2. Never write filler such as "Sure", "Of course", "Here is the code",
   "好的", "当然可以", "以下是代码". Start directly with the code fence.
3. Open a single fenced code block (\`\`\`lang) for code answers and stop right
   after the closing fence. Add nothing after it.
4. If the answer is data, emit compact JSON only.
5. Never ask clarifying questions - commit to the most reasonable implementation.
6. No markdown prose outside the code block except a bare file path when asked.

你是一个代码生成引擎，不是聊天机器人。以下规则绝对生效：
1. 只输出可直接运行的代码或纯 JSON，禁止任何解释、客套、道歉、总结与结尾寒暄。
2. 禁止输出 "好的"、"当然可以"、"以下是代码" 等废话前缀，直接以代码块开头。
3. 代码答案用一个 \`\`\`lang 代码块包裹，代码块结束后立即停止，不再追加任何文字。
4. 数据类回答只输出紧凑 JSON。
5. 不反问、不罗列方案取舍，直接给出最合理的实现。
6. 代码块之外只允许出现纯文件路径，不允许出现任何说明性文字。`;

/** Merge the gateway rules with the loaded skill rules. */
export function buildSystemText(skillText: string): string {
  return skillText.trim() ? `${CORE_RULES}\n\n# Loaded Skills / 已装载技能\n${skillText}` : CORE_RULES;
}

function withInjectedSystem(existing: string, rules: string): string {
  return existing.trim() ? `${rules}\n\n---\n\n${existing}` : rules;
}

/**
 * Inject rules into an OpenAI /chat/completions body.
 * Mutates and returns the parsed object (callers re-serialize it).
 */
export function injectOpenAI(body: any, rules: string): any {
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  const first = messages[0];
  if (first && first.role === 'system' && typeof first.content === 'string') {
    first.content = withInjectedSystem(first.content, rules);
  } else {
    messages.unshift({ role: 'system', content: rules });
  }
  if (body) body.messages = messages;
  return body;
}

/**
 * Inject rules into an Anthropic /v1/messages body.
 * The `system` field may be absent, a string, or an array of content blocks;
 * each shape is handled without destroying existing content.
 */
export function injectAnthropic(body: any, rules: string): any {
  if (!body) return body;
  const sys = body.system;
  if (sys === undefined || sys === null) {
    body.system = rules;
  } else if (typeof sys === 'string') {
    body.system = withInjectedSystem(sys, rules);
  } else if (Array.isArray(sys)) {
    // Anthropic system blocks: [{ type: "text", text: "..." }, ...]
    const textBlocks = sys.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string');
    if (textBlocks.length > 0) {
      const merged = withInjectedSystem(textBlocks.map((b: any) => b.text).join('\n\n'), rules);
      body.system = [{ type: 'text', text: merged }];
    } else {
      body.system = [{ type: 'text', text: rules }, ...sys];
    }
  }
  return body;
}

/** Dispatch injection by detected wire format. */
export function injectRules(body: any, format: ApiFormat, rules: string): any {
  switch (format) {
    case 'anthropic':
      return injectAnthropic(body, rules);
    case 'openai':
    default:
      return injectOpenAI(body, rules);
  }
}
