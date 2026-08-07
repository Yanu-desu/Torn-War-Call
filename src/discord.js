import fetch from 'node-fetch';

/**
 * Sends a message to a Discord webhook. Content is the "@mention / plain text"
 * line (shows above the embed and is what triggers push notifications/pings).
 */
export async function sendDiscordAlert(webhookUrl, { content, embed }) {
  const body = {
    content,
    embeds: embed ? [embed] : [],
    allowed_mentions: { parse: ['roles', 'users'] },
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[discord] webhook failed: ${res.status} ${text}`);
  }
}

export function buildEnemyEmbed(member, secondsLeft) {
  return {
    title: `🎯 ${member.name} [${member.id}] is coming out of hospital`,
    description: `Landing in ~${secondsLeft}s. Level ${member.level}.`,
    url: `https://www.torn.com/profiles.php?XID=${member.id}`,
    color: 0xe74c3c,
    footer: { text: 'Torn War Call' },
    timestamp: new Date().toISOString(),
  };
}

export function buildAllyEmbed(member, secondsLeft) {
  return {
    title: `🏥 You're almost out, ${member.name}`,
    description: `~${secondsLeft}s left in hospital. Get ready to move.`,
    url: `https://www.torn.com/profiles.php?XID=${member.id}`,
    color: 0x2ecc71,
    footer: { text: 'Torn War Call' },
    timestamp: new Date().toISOString(),
  };
}
