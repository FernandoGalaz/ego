import { loadEgoConfig } from "../config.js";
import { logger } from "../utils/logger.js";

export interface TaskNotification {
  taskId: string;
  project: string;
  title: string;
  status: "started" | "completed" | "failed";
  branch?: string;
  failedPhase?: string;
  turnsUsed?: number;
  duration?: string;
}

export async function notify(notification: TaskNotification): Promise<void> {
  const config = loadEgoConfig();

  const emoji = notification.status === "completed" ? "✅" : notification.status === "failed" ? "❌" : "🔄";
  const message = formatMessage(emoji, notification);

  const promises: Promise<void>[] = [];

  if (config.notifications.slack?.webhookUrl) {
    promises.push(sendSlack(config.notifications.slack.webhookUrl, message));
  }

  if (config.notifications.telegram) {
    promises.push(
      sendTelegram(config.notifications.telegram.botToken, config.notifications.telegram.chatId, message)
    );
  }

  await Promise.allSettled(promises);
}

function formatMessage(emoji: string, n: TaskNotification): string {
  let msg = `${emoji} **Ego** — ${n.status.toUpperCase()}\n`;
  msg += `Project: ${n.project}\n`;
  msg += `Task: ${n.title}\n`;
  if (n.branch) msg += `Branch: \`${n.branch}\`\n`;
  if (n.failedPhase) msg += `Failed at: ${n.failedPhase}\n`;
  if (n.turnsUsed) msg += `Turns: ${n.turnsUsed}\n`;
  if (n.duration) msg += `Duration: ${n.duration}\n`;
  return msg;
}

async function sendSlack(webhookUrl: string, text: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to send Slack notification");
  }
}

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to send Telegram notification");
  }
}
