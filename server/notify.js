import { config } from './config.js';

// Уведомления в Telegram — самый простой способ получить пуш на телефон без магазина приложений
export async function notify(text) {
  console.log(`[notify] ${text}`);
  const { token, chatId } = config.telegram;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.warn(`telegram: ${err.message}`);
  }
}
