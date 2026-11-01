/**
 * Omni-Skill-Proxy - skill_loader （动态 SKILL.md 注入）
 *
 * 读取本地目录下的 *.skill.md 文件，把预设的 Prompt 规则合并成一份系统提示，
 * 并在文件变化时热重载。
 *
 * Loads *.skill.md from a local directory, merges the preset prompt rules into
 * a single system prompt, and hot-reloads on change. Zero dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SkillFile } from './types';

const SKILL_EXT = '.skill.md';

function parseSkill(name: string, raw: string, filePath: string): SkillFile {
  let body = raw;
  let priority = 0;
  // Minimal front-matter: an optional leading "---\nkey: value\n---\n" block.
  // 极简 front-matter：可选的 "---\nkey: value\n---\n" 头部。
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const head = raw.slice(3, end);
      body = raw.slice(end + 4).replace(/^\r?\n/, '');
      for (const line of head.split(/\r?\n/)) {
        const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (m && m[1].toLowerCase() === 'priority') {
          priority = Number(m[2]) || 0;
        }
      }
    }
  }
  return { name, priority, body: body.trim(), path: filePath };
}

function listSkillFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(SKILL_EXT))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    // Missing skills dir is a soft error: gateway still runs with core rules.
    // 目录不存在是软错误：网关仍以核心规则运行。
    console.warn(`[skills] cannot read skills dir "${dir}": ${(err as Error).message}`);
  }
  return entries;
}

/**
 * Load every *.skill.md file from `dir` and merge them into one text block.
 * Higher `priority` in front-matter sorts first; ties fall back to file name.
 * Returns an object with the merged text and the list of parsed skills.
 */
export function loadSkills(dir: string): { text: string; skills: SkillFile[] } {
  const skills: SkillFile[] = listSkillFiles(dir).map((file) => {
    const full = path.join(dir, file);
    let raw = '';
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (err) {
      console.warn(`[skills] failed to read "${file}": ${(err as Error).message}`);
    }
    return parseSkill(file.slice(0, -SKILL_EXT.length), raw, full);
  });

  skills.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  const text = skills
    .map((s) => `## Skill: ${s.name}\n${s.body}`)
    .join('\n\n');

  return { text, skills };
}

/**
 * Watch the skills directory and reload on any change (debounced).
 * Returns a stop function. Uses fs.watch - no external dependencies.
 * 监视 skills 目录，变化时防抖重载；返回停止函数。
 */
export function watchSkills(
  dir: string,
  onChange: (loaded: { text: string; skills: SkillFile[] }) => void,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const loaded = loadSkills(dir);
        console.log(`[skills] hot-reloaded ${loaded.skills.length} skill(s) from ${dir}`);
        onChange(loaded);
      }, 300);
    });
  } catch (err) {
    console.warn(`[skills] watch unavailable for "${dir}": ${(err as Error).message}`);
  }

  return () => {
    if (timer) clearTimeout(timer);
    if (watcher) watcher.close();
  };
}
