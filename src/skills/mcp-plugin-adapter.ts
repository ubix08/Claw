// src/skills/mcp-plugin-adapter.ts — Convert Claude Code MCP plugins to clawd MCP servers
//
// Adapts Claude Code plugin manifests to clawd's MCP server configuration format.
// Handles command resolution, argument interpolation, and environment variable mapping.

import * as path from "path";
import { logger } from "../core/logger.js";
import type { McpServerConfig, McpHttpServerConfig } from "../mcp/client.js";
import type { ClaudePlugin, ClaudePluginManifest } from "./claude-plugin-bridge.js";

/**
 * Convert Claude Code MCP plugin to clawd MCP server config.
 *
 * Transforms the plugin's MCP configuration into a format compatible with
 * clawd's MCP client. Resolves placeholders like {installPath} and {env:VAR}.
 *
 * @param plugin Plugin metadata
 * @param manifest Plugin manifest with MCP configuration
 * @returns MCP server config or null if not MCP-based
 */
export function pluginToMcpConfig(
  plugin: ClaudePlugin,
  manifest: ClaudePluginManifest
): McpServerConfig | null {

  if (!manifest.mcp) {
    logger.warn(`[PluginBridge] Plugin ${plugin.name} is not MCP-based`);
    return null;
  }

  // Use latest installation
  const installation = plugin.installations[0];
  const installPath = installation.installPath;

  // Validate required fields
  if (!manifest.mcp.command || !Array.isArray(manifest.mcp.args)) {
    logger.error(`[PluginBridge] Invalid MCP config for ${plugin.name}: missing command or args`);
    return null;
  }

  // Resolve command (may be absolute path or command name)
  const command = resolveCommand(manifest.mcp.command, installPath);

  // Resolve arguments (interpolate {installPath} and other placeholders)
  const args = manifest.mcp.args.map(arg => resolveArgument(arg, installPath));

  // Resolve environment variables (interpolate {env:VAR_NAME})
  const env: Record<string, string> = {};
  if (manifest.mcp.env) {
    for (const [key, value] of Object.entries(manifest.mcp.env)) {
      env[key] = resolveEnvValue(value);
    }
  }

  return {
    command,
    args,
    env
  };
}

/**
 * Generate MCP server name for plugin.
 *
 * Uses a consistent naming scheme: claude-plugin-{name}
 *
 * @param plugin Plugin metadata
 * @returns Server name for MCP registration
 */
export function getPluginServerName(plugin: ClaudePlugin): string {
  return `claude-plugin-${plugin.name}`;
}

/**
 * Resolve command path.
 *
 * If command is relative, resolves it against install path.
 * Absolute paths and command names (node, python) are returned as-is.
 *
 * @param command Command from manifest
 * @param installPath Plugin installation directory
 * @returns Resolved command path
 */
function resolveCommand(command: string, installPath: string): string {
  // Absolute path or command name - use as-is
  if (path.isAbsolute(command) || !command.includes('/')) {
    return command;
  }

  // Relative path - resolve against install path
  return path.resolve(installPath, command);
}

/**
 * Resolve argument with placeholder interpolation.
 *
 * Supports:
 *   {installPath} - Plugin installation directory
 *   {baseDir}     - Alias for {installPath}
 *
 * @param arg Argument template
 * @param installPath Plugin installation directory
 * @returns Resolved argument
 */
function resolveArgument(arg: string, installPath: string): string {
  return arg
    .replace(/\{installPath\}/g, installPath)
    .replace(/\{baseDir\}/g, installPath);
}

/**
 * Resolve environment variable value with placeholder interpolation.
 *
 * Supports:
 *   {env:VAR_NAME} - Process environment variable
 *   Literal values - Used as-is
 *
 * @param value Environment variable value template
 * @returns Resolved value
 */
function resolveEnvValue(value: string): string {
  return value.replace(/\{env:(\w+)\}/g, (_, envVar) => {
    const resolved = process.env[envVar];
    if (!resolved) {
      logger.warn(`[PluginBridge] Environment variable ${envVar} not found`);
      return '';
    }
    return resolved;
  });
}

/**
 * Convert Claude Code HTTP MCP plugin to clawd HTTP MCP server config.
 *
 * Transforms the plugin's HTTP MCP configuration into a format compatible with
 * clawd's HTTP MCP client.
 *
 * @param plugin Plugin metadata
 * @param manifest Plugin manifest with HTTP MCP configuration
 * @returns HTTP MCP server config or null if not HTTP-based
 */
export function pluginToHttpMcpConfig(
  plugin: ClaudePlugin,
  manifest: ClaudePluginManifest
): McpHttpServerConfig | null {

  if (!manifest.httpMcp) {
    logger.warn(`[PluginBridge] Plugin ${plugin.name} is not HTTP MCP-based`);
    return null;
  }

  // Validate required fields
  if (!manifest.httpMcp.url) {
    logger.error(`[PluginBridge] Invalid HTTP MCP config for ${plugin.name}: missing url`);
    return null;
  }

  return {
    url: manifest.httpMcp.url,
    headers: manifest.httpMcp.headers || {}
  };
}

/**
 * Validate MCP configuration (stdio).
 *
 * Checks if the MCP config is valid and complete.
 *
 * @param config MCP server config
 * @returns True if valid
 */
export function validateMcpConfig(config: McpServerConfig): boolean {
  if (!config.command) {
    logger.error('[PluginBridge] MCP config missing command');
    return false;
  }

  if (!Array.isArray(config.args)) {
    logger.error('[PluginBridge] MCP config args must be array');
    return false;
  }

  return true;
}

/**
 * Validate HTTP MCP configuration.
 *
 * Checks if the HTTP MCP config is valid and complete.
 *
 * @param config HTTP MCP server config
 * @returns True if valid
 */
export function validateHttpMcpConfig(config: McpHttpServerConfig): boolean {
  if (!config.url) {
    logger.error('[PluginBridge] HTTP MCP config missing url');
    return false;
  }

  try {
    new URL(config.url);
  } catch {
    logger.error(`[PluginBridge] HTTP MCP config has invalid url: ${config.url}`);
    return false;
  }

  return true;
}
