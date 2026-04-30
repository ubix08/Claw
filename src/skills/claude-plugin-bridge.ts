// src/skills/claude-plugin-bridge.ts — Claude Code plugin discovery and integration
//
// Discovers installed Claude Code plugins from ~/.claude/plugins/ and makes them
// available in clawd. MCP-based plugins are registered as MCP servers.
//
// Plugin Discovery Flow:
//   1. Read ~/.claude/plugins/installed_plugins.json
//   2. Load manifest.json from each plugin installation
//   3. Identify plugin type (MCP, custom, UI-only)
//   4. Generate skill wrapper for eligible plugins
//
// Compatible with Claude Code plugin format v2.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { logger } from "../core/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClaudePluginInstallation {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

export interface ClaudePlugin {
  id: string;              // e.g., "figma@claude-plugins-official"
  name: string;            // e.g., "figma"
  marketplace: string;     // e.g., "claude-plugins-official"
  installations: ClaudePluginInstallation[];
}

export interface ClaudePluginManifest {
  name: string;
  displayName?: string;
  description: string;
  version: string;
  author?: string;
  license?: string;

  // MCP configuration (stdio transport)
  mcp?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  // HTTP MCP configuration (remote transport)
  httpMcp?: {
    url: string;
    headers?: Record<string, string>;
  };

  // Custom tool configuration (non-MCP plugins)
  tools?: Array<{
    name: string;
    description: string;
    parameters?: any;
  }>;

  // Plugin metadata
  icon?: string;
  homepage?: string;
  repository?: string;
}

export interface ClaudePluginsData {
  version: number;
  plugins: Record<string, ClaudePluginInstallation[]>;
}

// ── Plugin Discovery ──────────────────────────────────────────────────────────

/**
 * Discover all installed Claude Code plugins.
 *
 * Reads ~/.claude/plugins/installed_plugins.json and returns a list of
 * installed plugins with their installation metadata.
 *
 * @param pluginsPath Optional custom path to plugins directory (default: ~/.claude/plugins)
 * @returns Array of discovered plugins
 */
export function discoverClaudePlugins(pluginsPath?: string): ClaudePlugin[] {
  const pluginsDir = pluginsPath || getClaudePluginsDir();
  const installedPath = path.join(pluginsDir, 'installed_plugins.json');

  if (!fs.existsSync(installedPath)) {
    logger.debug('[PluginBridge] No Claude Code plugins found (installed_plugins.json missing)');
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(installedPath, 'utf8')) as ClaudePluginsData;

    if (data.version !== 2) {
      logger.warn(`[PluginBridge] Unsupported plugin format version: ${data.version}`);
      return [];
    }

    const plugins: ClaudePlugin[] = [];

    for (const [pluginId, installations] of Object.entries(data.plugins)) {
      const [name, marketplace] = pluginId.split('@');

      // Filter out invalid installations
      const validInstallations = installations.filter(install =>
        fs.existsSync(install.installPath)
      );

      if (validInstallations.length === 0) {
        logger.warn(`[PluginBridge] Skipping ${pluginId}: no valid installations found`);
        continue;
      }

      plugins.push({
        id: pluginId,
        name,
        marketplace,
        installations: validInstallations
      });
    }

    logger.info(`[PluginBridge] Discovered ${plugins.length} Claude Code plugins`);
    return plugins;

  } catch (error: any) {
    logger.error(`[PluginBridge] Failed to parse installed_plugins.json: ${error.message}`);
    return [];
  }
}

/**
 * Load plugin manifest from installation directory.
 *
 * Tries multiple manifest formats in priority order:
 *   1. .mcp.json - MCP server configuration (HTTP or stdio)
 *   2. server.json - MCP server metadata
 *   3. gemini-extension.json - Google extension format
 *   4. manifest.json - Standard plugin manifest
 *
 * @param installPath Path to plugin installation directory
 * @returns Parsed manifest or null if not found/invalid
 */
export function loadPluginManifest(installPath: string): ClaudePluginManifest | null {
  const formats = [
    { file: '.mcp.json', parser: parseMcpJson },
    { file: 'server.json', parser: parseServerJson },
    { file: 'gemini-extension.json', parser: parseGeminiExtension },
    { file: 'manifest.json', parser: parseManifestJson }
  ];

  for (const { file, parser } of formats) {
    const filePath = path.join(installPath, file);

    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const manifest = parser(raw, installPath);

        if (manifest) {
          logger.debug(`[PluginBridge] Loaded manifest from ${file}`);
          return manifest;
        }
      } catch (error: any) {
        logger.warn(`[PluginBridge] Failed to parse ${file}: ${error.message}`);
      }
    }
  }

  logger.warn(`[PluginBridge] No valid manifest found at ${installPath}`);
  return null;
}

/**
 * Get Claude Code plugins directory.
 *
 * @returns Path to ~/.claude/plugins/
 */
export function getClaudePluginsDir(): string {
  return path.join(os.homedir(), '.claude', 'plugins');
}

/**
 * Check if plugin is MCP-based.
 *
 * MCP plugins provide tools via the Model Context Protocol and can be
 * registered as MCP servers in clawd.
 *
 * @param manifest Plugin manifest
 * @returns True if plugin has MCP configuration (stdio or HTTP)
 */
export function isMcpPlugin(manifest: ClaudePluginManifest): boolean {
  return !!(manifest.mcp || manifest.httpMcp);
}

/**
 * Check if plugin uses HTTP MCP transport.
 *
 * @param manifest Plugin manifest
 * @returns True if plugin uses HTTP MCP
 */
export function isHttpMcpPlugin(manifest: ClaudePluginManifest): boolean {
  return !!manifest.httpMcp;
}

/**
 * Check if plugin uses stdio MCP transport.
 *
 * @param manifest Plugin manifest
 * @returns True if plugin uses stdio MCP
 */
export function isStdioMcpPlugin(manifest: ClaudePluginManifest): boolean {
  return !!manifest.mcp;
}

/**
 * Get the latest installation for a plugin.
 *
 * Returns the most recently updated installation, which is typically
 * the active one.
 *
 * @param plugin Plugin with one or more installations
 * @returns Latest installation
 */
export function getLatestInstallation(plugin: ClaudePlugin): ClaudePluginInstallation {
  const sorted = [...plugin.installations].sort((a, b) =>
    new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
  );
  return sorted[0];
}

/**
 * Check if plugin directory exists and is accessible.
 *
 * @param installPath Path to plugin installation
 * @returns True if directory exists and contains any valid manifest format
 */
export function validatePluginInstallation(installPath: string): boolean {
  if (!fs.existsSync(installPath)) {
    return false;
  }

  // Check for any supported manifest format
  const formats = ['.mcp.json', 'server.json', 'gemini-extension.json', 'manifest.json'];
  return formats.some(file => fs.existsSync(path.join(installPath, file)));
}

/**
 * Get plugin display name with fallback.
 *
 * @param manifest Plugin manifest
 * @returns Display name or name field
 */
export function getPluginDisplayName(manifest: ClaudePluginManifest): string {
  return manifest.displayName || manifest.name;
}

// ── Manifest Parsers ──────────────────────────────────────────────────────────

/**
 * Parse .mcp.json format (MCP server configuration).
 *
 * Format:
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "type": "http" | "stdio",
 *       "url": "https://...",      // HTTP only
 *       "command": "node",         // stdio only
 *       "args": ["server.js"],     // stdio only
 *       "env": {...}
 *     }
 *   }
 * }
 *
 * NOTE: This format has minimal metadata. We try to augment it by reading
 * server.json or gemini-extension.json for richer metadata.
 */
function parseMcpJson(raw: any, installPath: string): ClaudePluginManifest | null {
  if (!raw.mcpServers || typeof raw.mcpServers !== 'object') {
    return null;
  }

  // Get first server configuration
  const serverName = Object.keys(raw.mcpServers)[0];
  if (!serverName) return null;

  const server = raw.mcpServers[serverName];

  // Try to load richer metadata from other files
  let metadata = {
    name: serverName,
    displayName: serverName,
    description: server.description || `MCP plugin: ${serverName}`,
    version: server.version || '1.0.0',
    author: undefined as string | undefined,
    homepage: undefined as string | undefined
  };

  // Check for server.json for richer metadata
  const serverJsonPath = path.join(installPath, 'server.json');
  if (fs.existsSync(serverJsonPath)) {
    try {
      const serverData = JSON.parse(fs.readFileSync(serverJsonPath, 'utf8'));
      if (serverData.title) metadata.displayName = serverData.title;
      if (serverData.description) metadata.description = serverData.description;
      if (serverData.version) metadata.version = serverData.version;
      if (serverData.author) metadata.author = serverData.author;
      if (serverData.repository?.url) metadata.homepage = serverData.repository.url;
    } catch {
      // Ignore parse errors
    }
  }

  // Check for gemini-extension.json for additional metadata
  const geminiPath = path.join(installPath, 'gemini-extension.json');
  if (fs.existsSync(geminiPath)) {
    try {
      const geminiData = JSON.parse(fs.readFileSync(geminiPath, 'utf8'));
      if (geminiData.name && !metadata.displayName) metadata.displayName = geminiData.name;
      if (geminiData.description && metadata.description.startsWith('MCP plugin:')) {
        metadata.description = geminiData.description;
      }
      if (geminiData.version && metadata.version === '1.0.0') metadata.version = geminiData.version;
    } catch {
      // Ignore parse errors
    }
  }

  // Determine transport type
  if (server.type === 'http' && server.url) {
    return {
      name: metadata.name,
      displayName: metadata.displayName,
      description: metadata.description,
      version: metadata.version,
      author: metadata.author,
      homepage: metadata.homepage,
      httpMcp: {
        url: server.url,
        headers: server.headers
      }
    };
  } else if (server.command && Array.isArray(server.args)) {
    return {
      name: metadata.name,
      displayName: metadata.displayName,
      description: metadata.description,
      version: metadata.version,
      author: metadata.author,
      homepage: metadata.homepage,
      mcp: {
        command: server.command,
        args: server.args,
        env: server.env
      }
    };
  }

  return null;
}

/**
 * Parse server.json format (MCP server metadata).
 *
 * Figma format:
 * {
 *   "name": "com.figma.mcp/mcp",
 *   "title": "Figma MCP Server",
 *   "description": "...",
 *   "version": "2.1.15",
 *   "remotes": [
 *     {
 *       "type": "streamable-http",
 *       "url": "https://mcp.figma.com/mcp"
 *     }
 *   ]
 * }
 */
function parseServerJson(raw: any, installPath: string): ClaudePluginManifest | null {
  if (!raw.name || !raw.version) {
    return null;
  }

  // Extract clean name (e.g., "com.figma.mcp/mcp" → "figma")
  const cleanName = raw.name.split('.').filter((p: string) => p !== 'mcp' && p !== 'com').join('-') || raw.name;

  const manifest: ClaudePluginManifest = {
    name: cleanName,
    displayName: raw.title || raw.displayName || cleanName,
    description: raw.description || `Plugin: ${cleanName}`,
    version: raw.version,
    author: raw.author,
    license: raw.license,
    homepage: raw.homepage,
    repository: raw.repository?.url
  };

  // Parse remotes array (Figma format)
  if (Array.isArray(raw.remotes) && raw.remotes.length > 0) {
    const remote = raw.remotes[0];
    if ((remote.type === 'http' || remote.type === 'streamable-http') && remote.url) {
      manifest.httpMcp = {
        url: remote.url,
        headers: remote.headers
      };
    }
  }

  // Parse transport configuration (alternative format)
  if (raw.transport) {
    if (raw.transport.type === 'http' && raw.transport.url) {
      manifest.httpMcp = {
        url: raw.transport.url,
        headers: raw.transport.headers
      };
    } else if (raw.transport.command && Array.isArray(raw.transport.args)) {
      manifest.mcp = {
        command: raw.transport.command,
        args: raw.transport.args,
        env: raw.transport.env
      };
    }
  }

  return manifest;
}

/**
 * Parse gemini-extension.json format (Google extension).
 *
 * Figma format:
 * {
 *   "name": "Figma",
 *   "version": "2.1.15",
 *   "description": "...",
 *   "mcpServers": {
 *     "figma": {
 *       "httpUrl": "https://mcp.figma.com/mcp",
 *       "oauth": { "enabled": true }
 *     }
 *   }
 * }
 */
function parseGeminiExtension(raw: any, installPath: string): ClaudePluginManifest | null {
  if (!raw.name || !raw.version) {
    return null;
  }

  const manifest: ClaudePluginManifest = {
    name: raw.name.toLowerCase(),
    displayName: raw.name,
    description: raw.description || `Plugin: ${raw.name}`,
    version: raw.version,
    author: raw.author,
    license: raw.license,
    homepage: raw.homepage
  };

  // Parse mcpServers configuration
  if (raw.mcpServers && typeof raw.mcpServers === 'object') {
    const serverName = Object.keys(raw.mcpServers)[0];
    if (serverName) {
      const server = raw.mcpServers[serverName];

      // Check for HTTP MCP (httpUrl field)
      if (server.httpUrl) {
        manifest.httpMcp = {
          url: server.httpUrl,
          headers: server.headers
        };
      }

      // Check for stdio MCP
      if (server.command && Array.isArray(server.args)) {
        manifest.mcp = {
          command: server.command,
          args: server.args,
          env: server.env
        };
      }
    }
  }

  return manifest;
}

/**
 * Parse manifest.json format (standard plugin manifest).
 *
 * Format:
 * {
 *   "name": "plugin-name",
 *   "version": "1.0.0",
 *   "description": "...",
 *   "mcp": {
 *     "command": "node",
 *     "args": ["server.js"],
 *     "env": {...}
 *   }
 * }
 */
function parseManifestJson(raw: any, installPath: string): ClaudePluginManifest | null {
  if (!raw.name || !raw.description || !raw.version) {
    return null;
  }

  const manifest: ClaudePluginManifest = {
    name: raw.name,
    displayName: raw.displayName,
    description: raw.description,
    version: raw.version,
    author: raw.author,
    license: raw.license,
    icon: raw.icon,
    homepage: raw.homepage,
    repository: raw.repository
  };

  // Parse MCP configuration
  if (raw.mcp) {
    if (raw.mcp.url) {
      // HTTP MCP
      manifest.httpMcp = {
        url: raw.mcp.url,
        headers: raw.mcp.headers
      };
    } else if (raw.mcp.command && Array.isArray(raw.mcp.args)) {
      // stdio MCP
      manifest.mcp = {
        command: raw.mcp.command,
        args: raw.mcp.args,
        env: raw.mcp.env
      };
    }
  }

  // Parse custom tools
  if (raw.tools && Array.isArray(raw.tools)) {
    manifest.tools = raw.tools;
  }

  return manifest;
}
