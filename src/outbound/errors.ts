/**
 * Live `QQBotGateway` instances are registered only in the OpenClaw gateway
 * process. A CLI or other helper process has an empty `gateways` map even
 * when the bot is connected.
 */
export function botNotRunningMessage(accountId: string): string {
  return (
    `Bot "${accountId}" has no live QQ connection in this process. ` +
    `The WebSocket is owned by the OpenClaw gateway — ensure the gateway is running ` +
    `and qqbot account "${accountId}" is started (channels status / gateway logs).`
  );
}
