// ─────────────────────────────────────────────────────────────────────────────
// src/channels/channel.ts — Channel interface
//
// A Channel receives a live agent reference and manages its own
// transport lifecycle (HTTP, Telegram, WhatsApp, Discord, etc.).
//
// hf-clawd ships with one channel implementation:
//   - ApiChannel      (src/channels/api.ts)  — HTTP/SSE
//
// TerminalChannel has been removed — this is an API-only cloud build.
// Team support has been removed — agents only.
//
// ── Adding a new channel (e.g. Telegram) ─────────────────────────────────────
//
//   1. Create src/channels/telegram.ts implementing Channel:
//
//      import { Agent } from "../agent/agent.js";
//      import { getDefaultBus } from "../core/event-bus.js";
//      import type { Channel } from "./channel.js";
//
//      export class TelegramChannel implements Channel {
//        readonly id   = "telegram";
//        readonly name = "Telegram Bot";
//
//        constructor(private readonly token: string) {}
//
//        async run(agent: Agent): Promise<void> {
//          // Set up polling or webhook with node-telegram-bot-api or grammy.
//          // On each incoming message:
//          //   const result = await agent.prompt(text, sessionId);
//          //   await bot.sendMessage(chatId, result.output);
//          //
//          // For streaming, subscribe to the event bus:
//          //   const bus = getDefaultBus();
//          //   bus.subscribe(ev => {
//          //     if (ev.type === "agent_token") { ... }
//          //   });
//
//          await new Promise<void>(() => {}); // keep alive
//        }
//
//        dispose(): void { /* shut down bot */ }
//      }
//
//   2. In gateway.ts, instantiate alongside ApiChannel:
//
//      if (process.env["TELEGRAM_BOT_TOKEN"]) {
//        const tg = new TelegramChannel(process.env["TELEGRAM_BOT_TOKEN"]);
//        tg.run(agent).catch(err => logger.error(`[Telegram] ${err.message}`));
//      }
//
//   3. That's it — no other changes needed.
//
// ─────────────────────────────────────────────────────────────────────────────

import type { Agent } from "../agent/agent.js";

export interface Channel {
  /** Unique channel identifier (used in logs) */
  readonly id:   string;
  /** Human-readable name */
  readonly name: string;
  /**
   * Start the channel. Resolves when the channel is done (or never for
   * long-lived channels like HTTP servers). Called once at gateway startup.
   */
  run(agent: Agent): Promise<void>;
  /** Clean up resources. Called on SIGTERM/SIGINT. */
  dispose(): void;
}
