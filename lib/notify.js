const { serviceLabel } = require("./catalog");

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
  ].join("\n");
}

async function notifyTutor(bot, booking, source) {
  const chatId = process.env.TELEGRAM_TUTOR_CHAT_ID;
  if (!bot || !chatId) return;
  try {
    await bot.api.sendMessage(chatId, bookingText(booking, source));
  } catch (error) {
    console.error("Tutor notify failed:", error.message);
  }
}

module.exports = { notifyTutor, bookingText };
