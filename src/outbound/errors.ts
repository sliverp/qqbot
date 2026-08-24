/**
 * Live `QQBotGateway` instances are registered only in the OpenClaw gateway
 * process. A CLI or other helper process has an empty `gateways` map even
 * when the bot is connected.
 */
export function botNotRunningMessage(accountId: string): string {
  return (
    `Bot "${accountId}" has no live connection in this process. ` +
    `The WebSocket is owned by the OpenClaw gateway; send from that process ` +
    `(or via \`openclaw gateway call send\`).`
  );
}
