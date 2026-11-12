const { Bot, InlineKeyboard, Keyboard, webhookCallback } = require("grammy");
const {
  SERVICES,
  LANGUAGES,
  todayISO,
  isValidDate,
  serviceLabel,
  serviceAmount,
  formatSum,
} = require("../lib/catalog");
const { generateSlots, isWorkDay } = require("../lib/schedule");
const {
  DuplicateSlotError,
  getBookedSlots,
  createBooking,
  getBookingById,
  updateBookingPayment,
  getTelegramSession,
  saveTelegramSession,
  clearTelegramSession,
  listTeachers,
  getTeacherById,
} = require("../lib/db");
const { notifyTutor, sendReceiptToAdmin } = require("../lib/notify");
const {
  cardNumber,
  payOrigin,
  createStripeCheckout,
  paymeCheckoutUrl,
  parseDataUrl,
} = require("../lib/payment");

function upcomingDates() {
  const start = todayISO();
  const dates = [];
  const cursor = new Date(`${start}T12:00:00`);
  for (let i = 0; i < 14; i += 1) {
    const copy = new Date(cursor);
    copy.setDate(cursor.getDate() + i);
    dates.push(copy.toISOString().split("T")[0]);
  }
  return dates;
}

function languageKeyboard() {
  const keyboard = new InlineKeyboard();
  LANGUAGES.forEach((language, index) => {
    keyboard.text(language, `lang:${index}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard;
}

function teacherKeyboard(teachers) {
  const keyboard = new InlineKeyboard();
  teachers.forEach((teacher) => {
    keyboard.text(teacher.name, `tch:${teacher.id}`).row();
  });
  return keyboard;
}

function serviceKeyboard() {
  const keyboard = new InlineKeyboard();
  SERVICES.forEach((service, index) => {
    const shortName = service.name.replace(/\s*\([^)]+\)\s*$/, "");
    keyboard.text(`${shortName} · ${service.price}`, `svc:${index}`).row();
  });
  return keyboard;
}

function dateKeyboard() {
  const keyboard = new InlineKeyboard();
  upcomingDates().forEach((date, index) => {
    keyboard.text(date, `date:${date}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard;
}

function paymentKeyboard() {
  return new InlineKeyboard()
    .text("💳 Оплатить картой (Stripe)", "pay:stripe")
    .row()
    .text("💠 Оплатить через Payme", "pay:payme")
    .row()
    .text("🧾 Перевод на карту (отправить чек)", "pay:receipt");
}

async function resolveTeacher(payload) {
  if (payload && payload.teacher_id) {
    return getTeacherById(payload.teacher_id);
  }
  if (!payload || !payload.language) return null;
  const list = await listTeachers({ language: payload.language, active: true });
  return list[0] || null;
}

async function timeKeyboard(date, payload) {
  const teacher = await resolveTeacher(payload);
  if (!teacher || !isWorkDay(teacher, date)) return null;
  const booked = await getBookedSlots(date, teacher.id);
  const free = generateSlots(teacher.start_time, teacher.end_time).filter(
    (slot) => !booked.includes(slot)
  );
  if (!free.length) return null;
  const keyboard = new InlineKeyboard();
  free.forEach((slot, index) => {
    keyboard.text(slot, `time:${slot}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard;
}

function confirmKeyboard() {
  return new InlineKeyboard().text("Подтвердить", "ok:1").text("Отмена", "ok:0");
}

function contactKeyboard() {
  return new Keyboard().requestContact("Отправить номер").resized().oneTime();
}

function sessionKey(ctx) {
  return String((ctx.from && ctx.from.id) || ctx.chat.id);
}

function payloadReady(payload) {
  return Boolean(
    payload &&
      payload.student_name &&
      payload.contact &&
      payload.language &&
      payload.service &&
      payload.date &&
      payload.time_slot
  );
}

async function sessionOf(ctx) {
  return (
    (await getTelegramSession(sessionKey(ctx))) || {
      step: "idle",
      payload: {},
    }
  );
}

async function askLanguage(ctx) {
  await saveTelegramSession(sessionKey(ctx), "language", {});
  await ctx.reply("Выберите язык занятий.", {
    reply_markup: languageKeyboard(),
  });
}

async function summaryText(payload) {
  const teacher = await resolveTeacher(payload);
  const amount = serviceAmount(payload.service);
  return [
    "Проверьте заявку:",
    `Имя: ${payload.student_name}`,
    `Контакт: ${payload.contact}`,
    `Язык: ${payload.language}`,
    `Преподаватель: ${(teacher && teacher.name) || "—"}`,
    `Услуга: ${serviceLabel(payload.service)}`,
    `Дата: ${payload.date}`,
    `Время: ${payload.time_slot}`,
    `Сумма: ${formatSum(amount)}`,
  ].join("\n");
}

async function finishBooking(ctx, bot, payload) {
  const teacher = await resolveTeacher(payload);
  const amount = serviceAmount(payload.service);
  const chatId = String(ctx.chat.id);
  const booking = await createBooking({
    student_name: payload.student_name,
    contact: payload.contact,
    language: payload.language,
    service: payload.service,
    date: payload.date,
    time_slot: payload.time_slot,
    teacher_id: teacher ? teacher.id : undefined,
    source: "Telegram",
    tg_chat_id: chatId,
    amount,
    payment_method: amount === 0 ? "free" : "stripe",
    payment_status: amount === 0 ? "Бесплатно" : "Ожидает оплаты",
  });
  console.log("Telegram booking saved", booking.id, booking.student_name);

  if (amount === 0) {
    await clearTelegramSession(sessionKey(ctx));
    await notifyTutor(bot, booking, "Telegram");
    await ctx.reply(
      `Готово. ${payload.student_name}, ${payload.date} в ${payload.time_slot}. Пробный урок бесплатный — запись подтверждена.`,
      { reply_markup: { remove_keyboard: true } }
    );
    return;
  }

  payload.booking_id = booking.id;
  await saveTelegramSession(sessionKey(ctx), "payment", payload);
  await ctx.reply(
    `Слот забронирован. К оплате: ${formatSum(amount)}\nВыберите способ оплаты.`,
    { reply_markup: paymentKeyboard() }
  );
}

async function sendPayLink(ctx, bot, method) {
  const session = await sessionOf(ctx);
  const bookingId = session.payload && session.payload.booking_id;
  if (!bookingId) {
    await ctx.reply("Сессия устарела. Нажмите /start и запишитесь ещё раз.");
    return;
  }
  const booking = await getBookingById(bookingId);
  if (!booking) {
    await ctx.reply("Запись не найдена. /start");
    return;
  }
  const origin = payOrigin();
  let url;
  let externalId = null;
  if (method === "payme") {
    await updateBookingPayment(booking.id, { payment_method: "payme" });
    url = paymeCheckoutUrl(booking, origin);
  } else {
    const checkout = await createStripeCheckout(booking, origin, require("stripe")(process.env.STRIPE_SECRET_KEY));
    url = checkout.url;
    externalId = checkout.id;
    await updateBookingPayment(booking.id, {
      payment_method: "stripe",
      external_payment_id: externalId || booking.external_payment_id,
    });
  }
  if (!url || !/^https:\/\//i.test(url)) {
    await ctx.reply("Ссылка на оплату недоступна. Откройте сайт TutorBook и оплатите там.");
    return;
  }
  await ctx.reply(`Оплата через ${method === "payme" ? "Payme" : "Stripe"}. Нажмите кнопку ниже.`, {
    reply_markup: new InlineKeyboard().url(
      method === "payme" ? "💠 Открыть Payme" : "💳 Оплатить картой",
      url
    ),
  });
}

async function downloadTelegramFile(bot, fileId) {
  const file = await bot.api.getFile(fileId);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 4 * 1024 * 1024) {
    throw new Error("file too large");
  }
  const ext = (file.file_path || "").split(".").pop() || "jpg";
  const mime = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg";
  return { buffer, mime };
}

function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  const bot = new Bot(token);

  bot.command("id", async (ctx) => {
    await ctx.reply(`Ваш chat_id: ${ctx.chat.id}`);
  });

  bot.command("cancel", async (ctx) => {
    await clearTelegramSession(sessionKey(ctx));
    await ctx.reply("Запись отменена. /start — начать заново.");
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "TutorBook — запись к репетитору иностранных языков.\n/cancel — сбросить диалог.\n/id — узнать свой chat_id."
    );
    await askLanguage(ctx);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    const session = await sessionOf(ctx);
    const payload = { ...session.payload };

    if (data.startsWith("lang:") && session.step === "language") {
      const language = LANGUAGES[Number(data.slice(5))];
      if (!language) return ctx.answerCallbackQuery();
      payload.language = language;
      const teachers = await listTeachers({ language, active: true });
      await ctx.answerCallbackQuery();
      if (!teachers.length) {
        await saveTelegramSession(sessionKey(ctx), "language", payload);
        await ctx.reply("На этот язык пока нет активного преподавателя. Выберите другой язык.", {
          reply_markup: languageKeyboard(),
        });
        return;
      }
      if (teachers.length === 1) {
        payload.teacher_id = teachers[0].id;
        payload.teacher_name = teachers[0].name;
        await askService(ctx, payload);
        return;
      }
      await saveTelegramSession(sessionKey(ctx), "teacher", payload);
      await ctx.reply(`Язык: ${language}\nВыберите преподавателя.`, {
        reply_markup: teacherKeyboard(teachers),
      });
      return;
    }

    if (data.startsWith("tch:") && session.step === "teacher") {
      const teacher = await getTeacherById(Number(data.slice(4)));
      if (!teacher || teacher.language !== payload.language) {
        return ctx.answerCallbackQuery({ text: "Преподаватель недоступен." });
      }
      payload.teacher_id = teacher.id;
      payload.teacher_name = teacher.name;
      await ctx.answerCallbackQuery();
      await askService(ctx, payload);
      return;
    }

    if (data.startsWith("svc:") && session.step === "service") {
      const service = SERVICES[Number(data.slice(4))];
      if (!service) return ctx.answerCallbackQuery();
      payload.service = service.name;
      await saveTelegramSession(sessionKey(ctx), "date", payload);
      await ctx.answerCallbackQuery();
      await ctx.reply(`Услуга: ${serviceLabel(service.name)}\nВыберите дату.`, {
        reply_markup: dateKeyboard(),
      });
      return;
    }

    if (data.startsWith("date:") && session.step === "date") {
      const date = data.slice(5);
      if (!isValidDate(date) || date < todayISO()) {
        await ctx.answerCallbackQuery({ text: "Эта дата недоступна." });
        return;
      }
      payload.date = date;
      const keyboard = await timeKeyboard(date, payload);
      if (!keyboard) {
        await ctx.answerCallbackQuery();
        await ctx.reply("На эту дату свободных слотов нет. Выберите другую.", {
          reply_markup: dateKeyboard(),
        });
        return;
      }
      await saveTelegramSession(sessionKey(ctx), "time", payload);
      await ctx.answerCallbackQuery();
      await ctx.reply(`Дата: ${date}\nВыберите время.`, { reply_markup: keyboard });
      return;
    }

    if (data.startsWith("time:") && session.step === "time") {
      const timeSlot = data.slice(5);
      const teacher = await resolveTeacher(payload);
      const allowed = teacher ? generateSlots(teacher.start_time, teacher.end_time) : [];
      if (!allowed.includes(timeSlot)) return ctx.answerCallbackQuery();
      const booked = await getBookedSlots(payload.date, teacher && teacher.id);
      if (booked.includes(timeSlot)) {
        await ctx.answerCallbackQuery({ text: "Слот уже занят." });
        const keyboard = await timeKeyboard(payload.date, payload);
        if (keyboard) {
          await ctx.reply("Этот слот только что заняли. Выберите другое время.", {
            reply_markup: keyboard,
          });
        } else {
          await saveTelegramSession(sessionKey(ctx), "date", payload);
          await ctx.reply("Свободных слотов не осталось. Выберите другую дату.", {
            reply_markup: dateKeyboard(),
          });
        }
        return;
      }
      payload.time_slot = timeSlot;
      await saveTelegramSession(sessionKey(ctx), "name", payload);
      await ctx.answerCallbackQuery();
      await ctx.reply(`Время: ${timeSlot}\nНапишите имя ученика.`);
      return;
    }

    if (data.startsWith("pay:") && (session.step === "payment" || session.step === "awaiting_receipt")) {
      await ctx.answerCallbackQuery();
      const method = data.slice(4);
      if (method === "receipt") {
        const bookingId = payload.booking_id;
        if (bookingId) {
          const booking = await updateBookingPayment(bookingId, { payment_method: "receipt" });
          if (booking) await notifyTutor(bot, booking, "Telegram");
        }
        await saveTelegramSession(sessionKey(ctx), "awaiting_receipt", payload);
        await ctx.reply(
          [
            `Переведите ${formatSum(serviceAmount(payload.service))} на карту:`,
            cardNumber(),
            "",
            "Переведите указанную сумму и отправьте скриншот или PDF-файл чека ответным сообщением в этот чат.",
          ].join("\n")
        );
        return;
      }
      if (method === "stripe" || method === "payme") {
        try {
          await sendPayLink(ctx, bot, method);
        } catch (error) {
          console.error("Telegram pay link failed:", error);
          await ctx.reply("Не удалось создать ссылку на оплату. Попробуйте ещё раз.");
        }
      }
      return;
    }

    if (data.startsWith("ok:")) {
      await ctx.answerCallbackQuery();
      if (data === "ok:0") {
        await clearTelegramSession(sessionKey(ctx));
        await ctx.reply("Запись не сохранена. /start — начать заново.", {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      if (!payloadReady(payload)) {
        await ctx.reply("Сессия устарела. Нажмите /start и запишитесь ещё раз.");
        return;
      }
      try {
        await finishBooking(ctx, bot, payload);
      } catch (error) {
        if (error instanceof DuplicateSlotError || error.code === "23505") {
          await saveTelegramSession(sessionKey(ctx), "time", payload);
          const keyboard = await timeKeyboard(payload.date, payload);
          await ctx.reply(
            "Этот слот уже занят. Выберите другое время.",
            keyboard ? { reply_markup: keyboard } : { reply_markup: dateKeyboard() }
          );
          return;
        }
        console.error("Telegram booking failed:", error);
        await ctx.reply("Не удалось сохранить запись. Нажмите /start и попробуйте ещё раз.");
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });

  async function handleReceiptFile(ctx, fileId, fallbackMime) {
    const session = await sessionOf(ctx);
    if (session.step !== "awaiting_receipt") return false;
    const bookingId = session.payload && session.payload.booking_id;
    if (!bookingId) {
      await ctx.reply("Сессия устарела. /start");
      return true;
    }
    try {
      const file = await downloadTelegramFile(bot, fileId);
      const mime = file.mime || fallbackMime;
      const dataUrl = `data:${mime};base64,${file.buffer.toString("base64")}`;
      if (!parseDataUrl(dataUrl)) {
        await ctx.reply("Файл слишком большой. Пришлите чек до 4 МБ.");
        return true;
      }
      const booking = await updateBookingPayment(bookingId, {
        payment_method: "receipt",
        payment_status: "На проверке (чек)",
        receipt_data: dataUrl,
      });
      await sendReceiptToAdmin(booking, "Telegram");
      await clearTelegramSession(sessionKey(ctx));
      await ctx.reply(
        "⏳ Чек получен и отправлен преподавателю на проверку. Мы уведомим вас после подтверждения."
      );
    } catch (error) {
      console.error("Receipt upload failed:", error);
      await ctx.reply("Не удалось обработать файл. Пришлите скриншот или PDF до 4 МБ.");
    }
    return true;
  }

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];
    if (!best) return;
    await handleReceiptFile(ctx, best.file_id, "image/jpeg");
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc) return;
    await handleReceiptFile(ctx, doc.file_id, doc.mime_type || "application/pdf");
  });

  bot.on("message:contact", async (ctx) => {
    const session = await sessionOf(ctx);
    if (session.step !== "contact" && session.step !== "confirm") return;
    const payload = { ...session.payload };
    payload.contact = ctx.message.contact.phone_number;
    await saveTelegramSession(sessionKey(ctx), "confirm", payload);
    await ctx.reply(await summaryText(payload), { reply_markup: confirmKeyboard() });
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    const session = await sessionOf(ctx);
    const payload = { ...session.payload };

    if (session.step === "name") {
      const name = ctx.message.text.trim().slice(0, 100);
      if (!name) {
        await ctx.reply("Напишите имя ученика.");
        return;
      }
      payload.student_name = name;
      await saveTelegramSession(sessionKey(ctx), "contact", payload);
      await ctx.reply("Отправьте номер кнопкой или напишите контакт текстом.", {
        reply_markup: contactKeyboard(),
      });
      return;
    }

    if (session.step === "contact") {
      const contact = ctx.message.text.trim().slice(0, 100);
      if (!contact) {
        await ctx.reply("Напишите телефон или @username.");
        return;
      }
      payload.contact = contact;
      await saveTelegramSession(sessionKey(ctx), "confirm", payload);
      await ctx.reply(await summaryText(payload), { reply_markup: confirmKeyboard() });
      return;
    }

    if (session.step === "awaiting_receipt") {
      await ctx.reply("Пришлите скриншот или PDF чека файлом, не текстом.");
      return;
    }

    if (session.step === "confirm") {
      await ctx.reply("Нажмите «Подтвердить» под карточкой заявки, чтобы сохранить запись.");
    }

    if (session.step === "payment") {
      await ctx.reply("Выберите способ оплаты кнопками выше.");
    }
  });

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  return bot;
}

async function askService(ctx, payload) {
  const teacher = await resolveTeacher(payload);
  const teacherLine = teacher ? `Преподаватель: ${teacher.name}\n${teacher.role || ""}\n\n` : "";
  await saveTelegramSession(sessionKey(ctx), "service", payload);
  await ctx.reply(`${teacherLine}Язык: ${payload.language}\nВыберите услугу.`, {
    reply_markup: serviceKeyboard(),
  });
}

function telegramWebhook(bot) {
  if (!bot) return null;
  return webhookCallback(bot, "express");
}

module.exports = { createBot, telegramWebhook };
