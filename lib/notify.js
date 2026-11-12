const { serviceLabel, formatSum } = require("./catalog");
const { adminChatId, parseDataUrl } = require("./payment");

function bookingText(booking, source) {
  return [
    "Новая запись",
    `Источник: ${source}`,
    `Имя: ${booking.student_name}`,
    `Контакт: ${booking.contact}`,
    `Язык: ${booking.language}`,
    `Преподаватель: ${booking.teacher_name || booking.teacher || "—"}`,
    `Услуга: ${serviceLabel(booking.service)}`,
    `Дата: ${booking.date}`,
    `Время: ${booking.time_slot}`,
    `Оплата: ${booking.payment_status || "—"} · ${formatSum(booking.amount)}`,
  ].join("\n");
}

function receiptCaption(booking, source) {
  return [
    "⏳ Требуется проверка чека в админке",
    `Источник: ${source}`,
    `Имя: ${booking.student_name}`,
    `Контакт: ${booking.contact}`,
    `Язык: ${booking.language}`,
    `Преподаватель: ${booking.teacher_name || booking.teacher || "—"}`,
    `Дата: ${booking.date} ${booking.time_slot}`,
    `Сумма: ${formatSum(booking.amount)}`,
  ].join("\n");
}

async function telegramApi(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => null);
}

async function notifyTutor(bot, booking, source) {
  const chatId = adminChatId();
  if (!chatId) return;
  const text = bookingText(booking, source);
  try {
    if (bot) {
      await bot.api.sendMessage(chatId, text);
      return;
    }
    await telegramApi("sendMessage", { chat_id: chatId, text });
  } catch (error) {
    console.error("Tutor notify failed:", error.message);
  }
}

async function notifyStudentTelegram(chatId, text) {
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    await telegramApi("sendMessage", { chat_id: chatId, text });
  } catch (error) {
    console.error("Student notify failed:", error.message);
  }
}

async function sendReceiptToAdmin(booking, source) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = adminChatId();
  const parsed = parseDataUrl(booking.receipt_data);
  if (!token || !chatId || !parsed) return;

  const isImage = parsed.mime.startsWith("image/");
  const filename = isImage ? "receipt.jpg" : "receipt.pdf";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", receiptCaption(booking, source).slice(0, 1024));
  const blob = new Blob([parsed.buffer], { type: parsed.mime });
  form.append(isImage ? "photo" : "document", blob, filename);

  const method = isImage ? "sendPhoto" : "sendDocument";
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      console.error("Receipt telegram failed:", await response.text());
    }
  } catch (error) {
    console.error("Receipt telegram failed:", error.message);
  }
}

async function notifyPaidIfTelegram(booking) {
  if (!booking || !booking.tg_chat_id) return;
  await notifyStudentTelegram(
    booking.tg_chat_id,
    "✅ Оплата прошла успешно! Ваша запись подтверждена"
  );
}

module.exports = {
  notifyTutor,
  bookingText,
  notifyStudentTelegram,
  sendReceiptToAdmin,
  notifyPaidIfTelegram,
  receiptCaption,
};
