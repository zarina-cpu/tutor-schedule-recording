require("dotenv").config();

const path = require("path");
const express = require("express");
const {
  SERVICES,
  LANGUAGES,
  STATUSES,
  todayISO,
  isValidDate,
} = require("../lib/catalog");
const { publicTeacher } = require("../lib/teachers");
const {
  WEEK_DAYS,
  generateSlots,
  isWorkDay,
  mondayOf,
  addDays,
  weekDates,
  formatRange,
  formatDay,
  normalizeWorkDays,
  normalizeTime,
} = require("../lib/schedule");
const {
  DuplicateSlotError,
  ensureReady,
  listTeachers,
  getTeacherById,
  createTeacher,
  getBookedSlots,
  listBookings,
  getBookingById,
  createBooking,
  updateBookingStatus,
  updateBookingPayment,
} = require("../lib/db");
const storage = require("../lib/storage");
const {
  resolveLogin,
  getSession,
  setSessionCookie,
  clearAdminCookie,
} = require("../lib/auth");
const { notifyTutor, sendReceiptToAdmin, notifyPaidIfTelegram, notifyStudentTelegram } = require("../lib/notify");
const {
  cardNumber,
  normalizePayment,
  parseDataUrl,
  createStripeCheckout,
  paymeCheckoutUrl,
  paymentBadge,
  formatSum,
} = require("../lib/payment");
const { handlePaymeRpc } = require("../lib/payme");
const { createBot, telegramWebhook } = require("../lib/telegram");

const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const app = express();
const bot = createBot();

app.set("views", path.join(process.cwd(), "views"));
app.set("view engine", "ejs");

app.post("/payment/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) {
    return res.status(400).send("Stripe webhook is not configured");
  }
  try {
    await ensureReady();
    const event = Stripe(key).webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      secret
    );
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      const bookingId = session.metadata && session.metadata.booking_id;
      if (bookingId) {
        await markPaid(bookingId, "stripe", session.id);
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook:", error.message);
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(express.urlencoded({ extended: false, limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));

let boot;
app.use(async (req, res, next) => {
  try {
    boot = boot || ensureReady();
    await boot;
    next();
  } catch (error) {
    console.error(error);
    res.status(503).send("База данных недоступна");
  }
});

app.get("/api/health", async (req, res) => {
  try {
    const teachers = await listTeachers();
    const bookings = await listBookings();
    const backup = await storage.getJson("backups/latest.json");
    res.json({
      ok: true,
      postgres: { teachers: teachers.length, bookings: bookings.length },
      storage: {
        bucket: storage.BUCKET,
        backup_at: backup.saved_at,
        backup_bookings: (backup.bookings || []).length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function telegramLink() {
  const username = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "");
  return username ? `https://t.me/${username}` : "";
}

function pageLocals(extra) {
  return {
    services: SERVICES,
    languages: LANGUAGES,
    today: todayISO(),
    telegramLink: telegramLink(),
    cardNumber: cardNumber(),
    success: false,
    paid: false,
    canceled: false,
    receipt: false,
    error: false,
    ...extra,
  };
}

function readBookingFields(body) {
  const student_name = String(body.student_name || "").trim().slice(0, 100);
  const contact = String(body.contact || "").trim().slice(0, 100);
  const language = String(body.language || "").trim();
  const service = String(body.service || "").trim();
  const date = String(body.date || "").trim();
  const time_slot = String(body.time_slot || "").trim();
  const teacher_id = Number(body.teacher_id || 0) || null;
  return { student_name, contact, language, service, date, time_slot, teacher_id };
}

async function resolveBookingTeacher(fields) {
  if (fields.teacher_id) {
    const teacher = await getTeacherById(fields.teacher_id);
    if (teacher && teacher.language === fields.language) return teacher;
  }
  const list = await listTeachers({ language: fields.language, active: true });
  return list[0] || null;
}

async function validateBooking(fields) {
  if (!fields.student_name || !fields.contact) return false;
  if (!LANGUAGES.includes(fields.language)) return false;
  if (!SERVICES.some((item) => item.name === fields.service)) return false;
  if (!isValidDate(fields.date) || fields.date < todayISO()) return false;
  const teacher = await resolveBookingTeacher(fields);
  if (!teacher || teacher.is_active === false) return false;
  if (!isWorkDay(teacher, fields.date)) return false;
  if (!generateSlots(teacher.start_time, teacher.end_time).includes(fields.time_slot)) {
    return false;
  }
  return teacher;
}

function adminQuery(params) {
  const query = new URLSearchParams();
  if (params.week) query.set("week", params.week);
  if (params.language) query.set("language", params.language);
  if (params.teacher_id) query.set("teacher_id", String(params.teacher_id));
  const text = query.toString();
  return text ? `?${text}` : "";
}

function weekLoad(teacher, dates, bookings) {
  return dates.map((date) => {
    if (!isWorkDay(teacher, date)) {
      return { date, key: WEEK_DAYS[dates.indexOf(date)], off: true, booked: 0, total: 0, percent: 0 };
    }
    const total = generateSlots(teacher.start_time, teacher.end_time).length;
    const booked = bookings.filter(
      (item) =>
        item.date === date &&
        item.status !== "Отменена" &&
        Number(item.teacher_id) === Number(teacher.id)
    ).length;
    return {
      date,
      key: WEEK_DAYS[dates.indexOf(date)],
      off: false,
      booked,
      total,
      percent: total ? Math.round((booked / total) * 100) : 0,
    };
  });
}

app.get("/", async (req, res) => {
  const teachers = (await listTeachers({ active: true })).map(publicTeacher);
  res.render(
    "index",
    pageLocals({
      success: req.query.success === "1",
      paid: req.query.paid === "1",
      canceled: req.query.payment_canceled === "1",
      receipt: req.query.receipt === "1",
      error: req.query.error === "1",
      teachers,
    })
  );
});

app.get("/api/teachers", async (req, res) => {
  const language = String(req.query.language || "");
  const teachers = (await listTeachers({ language, active: true })).map(publicTeacher);
  res.json({ teachers });
});

app.get("/api/slots", async (req, res) => {
  const date = String(req.query.date || "");
  const language = String(req.query.language || "");
  const teacherId = Number(req.query.teacher_id || 0) || null;
  if (!isValidDate(date) || date < todayISO() || !LANGUAGES.includes(language)) {
    return res.json({ available_slots: [] });
  }
  const teacher = await resolveBookingTeacher({ language, teacher_id: teacherId });
  if (!teacher || !isWorkDay(teacher, date)) {
    return res.json({ available_slots: [] });
  }
  const booked = await getBookedSlots(date, teacher.id);
  const available_slots = generateSlots(teacher.start_time, teacher.end_time).filter(
    (slot) => !booked.includes(slot)
  );
  res.json({ available_slots, teacher: publicTeacher(teacher) });
});

app.post("/book", async (req, res) => {
  const fields = readBookingFields(req.body);
  const teacher = await validateBooking(fields);
  if (!teacher) {
    return res.redirect("/?error=1");
  }
  const method = String(req.body.payment_method || "").trim();
  const receiptRaw = String(req.body.receipt_data || "").trim();
  const payment = normalizePayment(fields.service, method, receiptRaw || null);
  if (payment.payment_method === "receipt") {
    if (!parseDataUrl(payment.receipt_data)) {
      return res.redirect("/?error=1");
    }
  }
  try {
    const booking = await createBooking({
      ...fields,
      ...payment,
      teacher_id: teacher.id,
      source: "сайт",
    });
    await notifyTutor(bot, booking, "сайт");
    if (booking.payment_method === "receipt") {
      await sendReceiptToAdmin(booking, "сайт");
      return res.redirect("/?receipt=1");
    }
    if (booking.payment_method === "free") {
      return res.redirect("/?success=1");
    }
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    if (booking.payment_method === "payme") {
      return res.redirect(paymeCheckoutUrl(booking, baseUrl));
    }
    if (!stripe) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    const checkout = await createStripeCheckout(booking, baseUrl, stripe);
    await updateBookingPayment(booking.id, { external_payment_id: checkout.id });
    return res.redirect(checkout.url);
  } catch (error) {
    if (error instanceof DuplicateSlotError || error.code === "23505") {
      return res.redirect("/?error=1");
    }
    console.error(error);
    res.redirect("/?error=1");
  }
});

async function markPaid(bookingId, method, externalId) {
  const current = await getBookingById(bookingId);
  if (!current) return null;
  const booking = await updateBookingPayment(bookingId, {
    payment_method: method || current.payment_method,
    payment_status: "Оплачено",
    external_payment_id: externalId || current.external_payment_id,
  });
  await notifyPaidIfTelegram(booking);
  return booking;
}

app.get("/payment/stripe/success", async (req, res) => {
  const sessionId = String(req.query.session_id || "");
  const bookingId = String(req.query.booking_id || "");
  if (!sessionId || !stripe) {
    return res.redirect("/?error=1");
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") {
      return res.redirect("/?error=1");
    }
    const id = (session.metadata && session.metadata.booking_id) || bookingId;
    await markPaid(id, "stripe", session.id);
    return res.redirect("/?success=1&paid=1");
  } catch (error) {
    console.error("Stripe success:", error.message);
    return res.redirect("/?error=1");
  }
});

app.get("/payment/success", (req, res) => {
  const sessionId = String(req.query.session_id || "");
  const bookingId = String(req.query.booking_id || "");
  if (sessionId) {
    return res.redirect(
      `/payment/stripe/success?session_id=${encodeURIComponent(sessionId)}&booking_id=${encodeURIComponent(bookingId)}`
    );
  }
  return res.redirect("/?success=1");
});

async function paymeWebhook(req, res) {
  try {
    const payload = await handlePaymeRpc(req);
    res.json(payload);
  } catch (error) {
    console.error("Payme webhook:", error);
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body && req.body.id,
      error: { code: -32400, message: "Internal error" },
    });
  }
}

app.post("/api/payme/webhook", paymeWebhook);
app.post("/payme/webhook", paymeWebhook);

app.get("/payment/payme/stub", async (req, res) => {
  const booking = await getBookingById(req.query.booking_id);
  if (!booking) return res.redirect("/?error=1");
  res.render("payment-payme-stub", {
    booking,
    amountLabel: formatSum(booking.amount),
  });
});

app.post("/payment/payme/stub", async (req, res) => {
  const booking = await markPaid(req.body.booking_id, "payme", `payme_stub_${Date.now()}`);
  if (!booking) return res.redirect("/?error=1");
  res.redirect("/?success=1&paid=1");
});

app.get("/admin", async (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.render("admin", {
      authorized: false,
      loginError: req.query.auth === "0",
      telegramLink: telegramLink(),
      bookings: [],
      statuses: STATUSES,
      session: null,
      teachers: [],
      teacherCards: [],
      filterLanguage: "",
      filterTeacherId: "",
      weekMonday: mondayOf(todayISO()),
      weekLabel: "",
      weekDates: [],
      weekDays: WEEK_DAYS,
      languages: LANGUAGES,
      adminQuery: "",
      prevWeek: "",
      nextWeek: "",
    currentWeek: mondayOf(todayISO()),
    paymentBadge,
    formatSum,
  });
}

  const allTeachers = await listTeachers();
  let sessionView = session;
  if (session.role === "teacher") {
    const teacher = allTeachers.find((item) => item.id === Number(session.teacherId));
    if (!teacher) {
      clearAdminCookie(res);
      return res.redirect("/admin");
    }
    sessionView = {
      role: "teacher",
      teacherId: teacher.id,
      language: teacher.language,
      teacherName: teacher.name,
    };
  }

  const requestedWeek = String(req.query.week || "");
  const weekMonday = mondayOf(isValidDate(requestedWeek) ? requestedWeek : todayISO());
  const dates = weekDates(weekMonday);
  const filterLanguage =
    sessionView.role === "school" ? String(req.query.language || "") : sessionView.language;
  const filterTeacherId =
    sessionView.role === "teacher"
      ? Number(sessionView.teacherId)
      : Number(req.query.teacher_id || 0) || "";

  const visibleTeachers =
    sessionView.role === "teacher"
      ? allTeachers.filter((item) => item.id === Number(sessionView.teacherId))
      : allTeachers;

  const weekAllBookings = await listBookings({
    from: dates[0],
    to: dates[6],
    teacherId: sessionView.role === "teacher" ? sessionView.teacherId : undefined,
  });
  const weekBookings = weekAllBookings.filter((item) => {
    if (sessionView.role === "school" && filterLanguage && item.language !== filterLanguage) {
      return false;
    }
    if (sessionView.role === "school" && filterTeacherId && Number(item.teacher_id) !== Number(filterTeacherId)) {
      return false;
    }
    return true;
  });

  const teacherCards = visibleTeachers.map((teacher) => ({
    ...publicTeacher(teacher),
    hours: `${teacher.start_time}–${teacher.end_time}`,
    days: weekLoad(teacher, dates, weekAllBookings),
  }));

  const query = adminQuery({
    week: weekMonday,
    language: sessionView.role === "school" ? filterLanguage : "",
    teacher_id: sessionView.role === "school" ? filterTeacherId : "",
  });

  res.render("admin", {
    authorized: true,
    loginError: false,
    telegramLink: telegramLink(),
    bookings: weekBookings,
    statuses: STATUSES,
    session: sessionView,
    teachers: visibleTeachers.map(publicTeacher),
    teacherCards,
    filterLanguage,
    filterTeacherId: filterTeacherId ? String(filterTeacherId) : "",
    weekMonday,
    weekLabel: formatRange(weekMonday),
    weekDates: dates.map((date, index) => ({
      date,
      key: WEEK_DAYS[index],
      label: formatDay(date),
    })),
    weekDays: WEEK_DAYS,
    languages: LANGUAGES,
    adminQuery: query,
    prevWeek: addDays(weekMonday, -7),
    nextWeek: addDays(weekMonday, 7),
    currentWeek: mondayOf(todayISO()),
    paymentBadge,
    formatSum,
  });
});

app.post("/admin/login", async (req, res) => {
  const teachers = await listTeachers();
  const session = resolveLogin(req.body.password || "", teachers);
  if (!session) {
    return res.redirect("/admin?auth=0");
  }
  setSessionCookie(res, session);
  res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  clearAdminCookie(res);
  res.redirect("/admin");
});

app.post("/admin/status/:id", async (req, res) => {
  const session = getSession(req);
  if (!session) {
    return res.redirect("/admin");
  }
  const status = String(req.body.status || "");
  if (!STATUSES.includes(status)) {
    return res.redirect("/admin");
  }
  try {
    await updateBookingStatus(req.params.id, status, {
      teacherId: session.role === "teacher" ? session.teacherId : undefined,
    });
  } catch (error) {
    if (!(error instanceof DuplicateSlotError)) {
      console.error(error);
    }
  }
  const week = String(req.body.week || "");
  const language = String(req.body.language || "");
  const teacher_id = String(req.body.teacher_id || "");
  res.redirect(
    `/admin${adminQuery({
      week: isValidDate(week) ? week : mondayOf(todayISO()),
      language: session.role === "school" ? language : "",
      teacher_id: session.role === "school" ? teacher_id : "",
    })}`
  );
});

app.get("/admin/receipt/:id", async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false });
  const booking = await getBookingById(req.params.id);
  if (!booking) return res.status(404).json({ ok: false });
  if (session.role === "teacher" && Number(booking.teacher_id) !== Number(session.teacherId)) {
    return res.status(403).json({ ok: false });
  }
  res.json({ ok: true, receipt_data: booking.receipt_data || null, id: booking.id });
});

app.post("/admin/payment/:id", async (req, res) => {
  const session = getSession(req);
  if (!session) return res.redirect("/admin");
  const current = await getBookingById(req.params.id);
  if (!current) return res.redirect("/admin");
  if (session.role === "teacher" && Number(current.teacher_id) !== Number(session.teacherId)) {
    return res.redirect("/admin");
  }
  const action = String(req.body.action || "");
  const payment_status = action === "reject" ? "Отклонено" : "Оплачено";
  const booking = await updateBookingPayment(req.params.id, { payment_status });
  if (booking && booking.tg_chat_id) {
    const text =
      payment_status === "Оплачено"
        ? "✅ Оплата по чеку подтверждена. Ваша запись активна."
        : "❌ Чек отклонён. Напишите преподавателю или запишитесь заново: /start";
    await notifyStudentTelegram(booking.tg_chat_id, text);
  }
  const week = String(req.body.week || "");
  const language = String(req.body.language || "");
  const teacher_id = String(req.body.teacher_id || "");
  res.redirect(
    `/admin${adminQuery({
      week: isValidDate(week) ? week : mondayOf(todayISO()),
      language: session.role === "school" ? language : "",
      teacher_id: session.role === "school" ? teacher_id : "",
    })}`
  );
});

app.post("/admin/teachers", async (req, res) => {
  const session = getSession(req);
  if (!session || session.role !== "school") {
    return res.redirect("/admin");
  }
  const name = String(req.body.name || "").trim().slice(0, 100);
  const role = String(req.body.role || "").trim().slice(0, 150);
  const language = String(req.body.language || "").trim();
  const work_days = normalizeWorkDays(req.body.work_days);
  const start_time = normalizeTime(req.body.start_time, "10:00");
  const end_time = normalizeTime(req.body.end_time, "20:00");
  const is_active = req.body.is_active === "on" || req.body.is_active === "true";
  if (!name || !LANGUAGES.includes(language)) {
    return res.redirect("/admin");
  }
  await createTeacher({
    name,
    role,
    language,
    work_days,
    start_time,
    end_time,
    is_active,
  });
  const week = String(req.body.week || "");
  res.redirect(`/admin${adminQuery({ week: isValidDate(week) ? week : mondayOf(todayISO()) })}`);
});

if (process.env.VERCEL) {
  const webhook = telegramWebhook(bot);
  if (webhook) {
    app.post("/telegram/webhook", webhook);
  }
}

if (process.env.VERCEL && bot) {
  const hookBase = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (hookBase) {
    bot.api.setWebhook(`${hookBase.replace(/\/$/, "")}/telegram/webhook`).catch((error) => {
      console.error("Telegram setWebhook:", error.message);
    });
  }
}

if (process.env.NODE_ENV !== "production") {
  const port = process.env.PORT || 3000;
  ensureReady()
    .then(() => {
      app.listen(port, () => {
        console.log(`TutorBook: http://localhost:${port}`);
        if (bot) {
          bot.api
            .deleteWebhook({ drop_pending_updates: false })
            .catch((error) => console.error("Telegram webhook:", error.message))
            .finally(() => {
              try {
                const started = bot.start({
                  onStart: (info) => {
                    console.log(`Telegram-бот @${info.username} запущен (polling)`);
                  },
                });
                if (started && typeof started.catch === "function") {
                  started.catch((error) => {
                    console.error("Telegram polling:", error.message);
                  });
                }
              } catch (error) {
                console.error("Telegram polling:", error.message);
              }
            });
        } else {
          console.log("TELEGRAM_BOT_TOKEN не задан — бот не запущен.");
        }
      });
    })
    .catch((error) => {
      console.error("Neon startup failed:", error);
      process.exit(1);
    });
}

module.exports = app;
