// src/skills/plugin-skill-wrapper.ts — Generate synthetic skills from Claude Code plugins
//
// Wraps Claude Code plugins as clawd skills, making them visible to the agent
// and documenting their capabilities in the system prompt.

import type { Skill } from "../skills.js";
import type { ClaudePlugin, ClaudePluginManifest } from "./claude-plugin-bridge.js";
import { getLatestInstallation } from "./claude-plugin-bridge.js";

/**
 * Generate synthetic Skill from Claude Code plugin.
 *
 * Creates a skill wrapper that:
 * - Documents the plugin's capabilities
 * - Makes it visible in skill listings
 * - Provides usage instructions for MCP plugins
 *
 * @param plugin Plugin metadata
 * @param manifest Plugin manifest
 * @returns Synthetic skill object
 */
export function wrapPluginAsSkill(
  plugin: ClaudePlugin,
  manifest: ClaudePluginManifest
): Skill {

  const installation = getLatestInstallation(plugin);
  const skillDir = installation.installPath;

  // Generate skill name (prefixed to avoid conflicts)
  const skillName = `claude-plugin-${plugin.name}`;

  // Generate body content
  const body = generateSkillBody(plugin, manifest);

  // Construct raw SKILL.md (synthetic frontmatter + body)
  const raw = `---
name: ${skillName}
description: ${manifest.description}
version: ${manifest.version}
metadata:
  openclaw:
    skillKey: ${skillName}
    always: true
    source: claude-code-plugin
---

${body}`;

  return {
    name: skillName,
    description: manifest.description,
    version: manifest.version,
    location: skillDir,
    skillDir,
    modelVisible: true,        // Show in system prompt
    userInvocable: false,      // Plugins are not directly invocable (use tools instead)
    skillMeta: {
      skillKey: skillName,
      always: true            // Skip gate checks (assume plugin is properly installed)
    },
    raw,
    body,
    configKey: skillName
  };
}

/**
 * Generate skill body content from plugin manifest.
 *
 * Includes:
 * - Plugin description and metadata
 * - Plugin type (MCP, custom)
 * - Usage instructions
 * - Available tools (if documented)
 *
 * @param plugin Plugin metadata
 * @param manifest Plugin manifest
 * @returns Markdown body content
 */
function generateSkillBody(
  plugin: ClaudePlugin,
  manifest: ClaudePluginManifest
): string {

  let body = '';

  // Header
  const displayName = manifest.displayName || plugin.name;
  body += `# ${displayName}\n\n`;
  body += `${manifest.description}\n\n`;

  // Metadata
  body += `**Version:** ${manifest.version}\n`;
  body += `**Source:** Claude Code Plugin (${plugin.marketplace})\n`;

  if (manifest.author) {
    body += `**Author:** ${manifest.author}\n`;
  }

  if (manifest.homepage) {
    body += `**Homepage:** ${manifest.homepage}\n`;
  }

  body += `\n`;

  // Plugin type and usage instructions
  if (manifest.mcp) {
    body += `## Plugin Type\n\n`;
    body += `This plugin provides tools via the **Model Context Protocol (MCP)**.\n\n`;
    body += `**MCP Server Name:** \`claude-plugin-${plugin.name}\`\n\n`;

    body += `## Usage\n\n`;
    body += `To use this plugin's tools:\n\n`;
    body += `1. **List available tools:**\n`;
    body += `   \`\`\`\n`;
    body += `   list_mcp_resources(serverName: "claude-plugin-${plugin.name}")\n`;
    body += `   \`\`\`\n\n`;

    body += `2. **Call a tool:**\n`;
    body += `   \`\`\`\n`;
    body += `   call_mcp_tool(\n`;
    body += `     serverName: "claude-plugin-${plugin.name}",\n`;
    body += `     toolName: "...",\n`;
    body += `     args: { ... }\n`;
    body += `   )\n`;
    body += `   \`\`\`\n\n`;
  } else if (manifest.tools && manifest.tools.length > 0) {
    body += `## Plugin Type\n\n`;
    body += `This plugin provides **custom tools** (non-MCP).\n\n`;
  }

  // Document available tools (if listed in manifest)
  if (manifest.tools && manifest.tools.length > 0) {
    body += `## Available Tools\n\n`;

    for (const tool of manifest.tools) {
      body += `### ${tool.name}\n\n`;
      body += `${tool.description}\n\n`;

      if (tool.parameters) {
        body += `**Parameters:**\n`;
        body += `\`\`\`json\n`;
        body += JSON.stringify(tool.parameters, null, 2);
        body += `\n\`\`\`\n\n`;
      }
    }
  }

  // Installation info
  const installation = getLatestInstallation(plugin);
  body += `## Installation\n\n`;
  body += `**Installed:** ${new Date(installation.installedAt).toLocaleDateString()}\n`;
  body += `**Last Updated:** ${new Date(installation.lastUpdated).toLocaleDateString()}\n`;
  body += `**Version:** ${installation.version}\n`;

  if (installation.gitCommitSha) {
    body += `**Commit:** ${installation.gitCommitSha.substring(0, 7)}\n`;
  }

  body += `**Location:** \`${installation.installPath}\`\n`;

  return body;
}

/**
 * Generate skill name from plugin.
 *
 * Uses consistent naming: claude-plugin-{name}
 *
 * @param plugin Plugin metadata
 * @returns Skill name
 */
export function getPluginSkillName(plugin: ClaudePlugin): string {
  return `claude-plugin-${plugin.name}`;
}
