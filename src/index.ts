#!/usr/bin/env node
/**
 * Omni-Skill-Proxy - CLI entry point
 *
 * 装载 skills、启动网关、热重载监听。纯 Node.js，零原生依赖。
 * Loads skills, boots the gateway, watches for skill changes.
 */

import { loadConfig } from './types';
import { loadSkills, watchSkills } from './skill_loader';
import { buildSystemText } from './injector';
import { startProxy } from './proxy_server';

function main(): void {
  const config = loadConfig();
  const skillsDir = config.skillsDir;

  const loaded = loadSkills(skillsDir);
  let systemText = buildSystemText(loaded.text);
  if (loaded.skills.length > 0) {
    console.log(`[skills] loaded ${loaded.skills.length} skill(s): ${loaded.skills.map((s) => s.name).join(', ')}`);
  } else {
    console.log(`[skills] no *.skill.md found in "${skillsDir}" - core rules only`);
  }

  // Skills hot-reload: the system prompt is rebuilt live, in place.
  const stopWatch = watchSkills(skillsDir, (next) => {
    systemText = buildSystemText(next.text);
    console.log('[skills] system prompt rebuilt');
  });

  const server = startProxy({ config, getSystemText: () => systemText });

  const shutdown = (sig: string) => {
    console.log(`\n[proxy] ${sig} received, shutting down`);
    stopWatch();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
