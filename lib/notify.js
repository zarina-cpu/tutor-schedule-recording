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

function telegramChatFromContact(contact) {
  const text = String(contact || "").trim();
  if (/^-?\d{5,}$/.test(text)) return text;
  const mention = text.match(/@([A-Za-z0-9_]{4,})/i);
  return mention ? `@${mention[1]}` : "";
}

function telegramChatFromBooking(booking) {
  if (booking && booking.tg_chat_id) return String(booking.tg_chat_id).trim();
  return telegramChatFromContact(booking && booking.contact);
}

function paidBookingText(booking, source) {
  const method =
    booking.payment_method === "payme" ? "Payme" : booking.payment_method === "stripe" ? "Stripe" : "карта";
  return [
    "✅ Оплата прошла успешно",
    "Новая оплаченная запись",
    `Источник: ${source || booking.source || "сайт"}`,
    `Имя: ${booking.student_name}`,
    `Контакт: ${booking.contact}`,
    `Язык: ${booking.language}`,
    `Преподаватель: ${booking.teacher_name || booking.teacher || "—"}`,
    `Услуга: ${serviceLabel(booking.service)}`,
    `Дата: ${booking.date}`,
    `Время: ${booking.time_slot}`,
    `Оплата: Оплачено (${method}) · ${formatSum(booking.amount)}`,
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

async function sendTelegramText(chatId, text) {
  const id = String(chatId || "").trim();
  if (!id || !text || !process.env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const result = await telegramApi("sendMessage", { chat_id: id, text });
    if (result && result.ok === false) {
      console.error("Telegram send failed:", result.description || result);
      return false;
    }
    return Boolean(result && result.ok !== false);
  } catch (error) {
    console.error("Telegram send failed:", error.message);
    return false;
  }
}

async function sendAdminText(bot, text) {
  const chatId = String(adminChatId() || "").trim();
  if (!chatId || !text) {
    console.error("Tutor notify skipped: TELEGRAM_CHAT_ID is empty");
    return;
  }
  const sent = await sendTelegramText(chatId, text);
  if (sent || !bot) return;
  try {
    await bot.api.sendMessage(chatId, text);
  } catch (error) {
    console.error("Tutor notify failed:", error.message);
  }
}

async function notifyTutor(bot, booking, source) {
  const method = booking && booking.payment_method;
  const status = booking && booking.payment_status;
  if ((method === "stripe" || method === "payme") && status !== "Оплачено") {
    return;
  }
  await sendAdminText(bot, bookingText(booking, source));
}

async function notifyTutorPaid(bot, booking, source) {
  await sendAdminText(bot, paidBookingText(booking, source));
}

async function notifyStudentTelegram(chatId, text) {
  await sendTelegramText(chatId, text);
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
  const chatId = telegramChatFromBooking(booking);
  if (!chatId) return;
  await notifyStudentTelegram(
    chatId,
    "✅ Оплата прошла успешно! Ваша запись подтверждена."
  );
}

module.exports = {
  notifyTutor,
  notifyTutorPaid,
  bookingText,
  notifyStudentTelegram,
  sendReceiptToAdmin,
  notifyPaidIfTelegram,
  receiptCaption,
  telegramChatFromContact,
  telegramChatFromBooking,
};
