import type { LogLevel } from "./core/logger.js";
export declare function getClawdHome(): string;
export declare function getClawdDir(): string;
export declare function getAgentsDir(): string;
export declare function getTeamsDir(): string;
export declare function getStagedDir(): string;
export declare function getSkillsDir(): string;
export declare function getConfigPath(): string;
export declare function getEnvPath(): string;
export declare function getModelsPath(): string;
export declare function getPiAuthPath(): string;
export declare function getPiModelsPath(): string;
export declare const CLAWD_DIR: string;
export declare const CLAWD_AGENTS_DIR: string;
export declare const CLAWD_TEAMS_DIR: string;
export declare const CLAWD_STAGED_DIR: string;
export declare const CLAWD_SKILLS_DIR: string;
export declare const CONFIG_PATH: string;
export declare const ENV_PATH: string;
export declare const CLAWD_MODELS_PATH: string;
export declare const PI_AUTH_PATH: string;
export declare const PI_MODELS_PATH: string;
export declare const DEFAULT_AGENT_ID = "clawd";
export declare function agentDir(agentId: string): string;
export declare function agentConfigPath(agentId: string): string;
export declare function agentSessionsDir(agentId: string): string;
export declare function teamDir(teamId: string): string;
export declare function teamConfigPath(teamId: string): string;
export declare function teamSharedDir(teamId: string): string;
export declare function teamAgentDir(teamId: string, agentId: string): string;
export interface GlobalConfig {
    activeAgent: string;
    activeTeam: string | null;
    defaults: {
        model: string;
        provider: string;
        maxTurns: number;
        timeoutSeconds: number;
        thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
    };
    api: {
        enabled: boolean;
        port: number;
        host: string;
        auth?: {
            token: string;
        };
    };
    skills: {
        extraDirs: string[];
        watch: boolean;
        watchDebounceMs?: number;
        entries: Record<string, {
            enabled?: boolean;
            apiKey?: string;
            env?: Record<string, string>;
        }>;
    };
    log: {
        level: LogLevel;
    };
}
export declare function loadConfig(configPath?: string): GlobalConfig;
export declare function saveConfig(c: GlobalConfig, configPath?: string): void;
export declare function resetConfig(): void;
export declare function overrideApiPort(port: number): void;
export declare function loadEnv(envPath?: string): void;
export declare function ensureAuthJson(authPath?: string, modelsPath?: string): void;
export declare function ensureModelsJson(clawdModelsPath?: string, piModelsPath?: string): void;
