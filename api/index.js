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
  createBooking,
  updateBookingStatus,
} = require("../lib/db");
const storage = require("../lib/storage");
const {
  resolveLogin,
  getSession,
  setSessionCookie,
  clearAdminCookie,
} = require("../lib/auth");
const { notifyTutor } = require("../lib/notify");
const { createBot } = require("./telegram");

const app = express();
const bot = createBot();

app.set("views", path.join(process.cwd(), "views"));
app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: false }));

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
  try {
    const booking = await createBooking({
      ...fields,
      teacher_id: teacher.id,
      source: "сайт",
    });
    await notifyTutor(bot, booking, "сайт");
    res.redirect("/?success=1");
  } catch (error) {
    if (error instanceof DuplicateSlotError || error.code === "23505") {
      return res.redirect("/?error=1");
    }
    console.error(error);
    res.redirect("/?error=1");
  }
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
              bot.start({
                onStart: (info) => {
                  console.log(`Telegram-бот @${info.username} запущен (polling)`);
                },
              });
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
