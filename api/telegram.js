const { Bot, InlineKeyboard, Keyboard } = require("grammy");
const {
  SERVICES,
  LANGUAGES,
  todayISO,
  isValidDate,
  serviceLabel,
} = require("../lib/catalog");
const { generateSlots, isWorkDay } = require("../lib/schedule");
const {
  DuplicateSlotError,
  getBookedSlots,
  createBooking,
  getTelegramSession,
  saveTelegramSession,
  clearTelegramSession,
  listTeachers,
  getTeacherById,
} = require("../lib/db");
const { notifyTutor } = require("../lib/notify");

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
  return new InlineKeyboard()
    .text("Подтвердить", "ok:1")
    .text("Отмена", "ok:0");
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
  return [
    "Проверьте заявку:",
    `Имя: ${payload.student_name}`,
    `Контакт: ${payload.contact}`,
    `Язык: ${payload.language}`,
    `Преподаватель: ${(teacher && teacher.name) || "—"}`,
    `Услуга: ${serviceLabel(payload.service)}`,
    `Дата: ${payload.date}`,
    `Время: ${payload.time_slot}`,
  ].join("\n");
}

async function finishBooking(ctx, bot, payload) {
  const teacher = await resolveTeacher(payload);
  const booking = await createBooking({
    student_name: payload.student_name,
    contact: payload.contact,
    language: payload.language,
    service: payload.service,
    date: payload.date,
    time_slot: payload.time_slot,
    teacher_id: teacher ? teacher.id : undefined,
    source: "Telegram",
  });
  await clearTelegramSession(sessionKey(ctx));
  console.log("Telegram booking saved", booking.id, booking.student_name);
  await notifyTutor(bot, booking, "Telegram");
  await ctx.reply(
    `Готово. ${payload.student_name}, ${payload.date} в ${payload.time_slot}. Заявка уже в расписании.`,
    { reply_markup: { remove_keyboard: true } }
  );
}

async function askService(ctx, payload) {
  const teacher = await resolveTeacher(payload);
  const teacherLine = teacher
    ? `Преподаватель: ${teacher.name}\n${teacher.role || ""}\n\n`
    : "";
  await saveTelegramSession(sessionKey(ctx), "service", payload);
  await ctx.reply(`${teacherLine}Язык: ${payload.language}\nВыберите услугу.`, {
    reply_markup: serviceKeyboard(),
  });
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
      const allowed = teacher
        ? generateSlots(teacher.start_time, teacher.end_time)
        : [];
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
        if (error.code === "23505") {
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

    if (session.step === "confirm") {
      await ctx.reply("Нажмите «Подтвердить» под карточкой заявки, чтобы сохранить запись.");
    }
  });

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  return bot;
}

module.exports = { createBot };
