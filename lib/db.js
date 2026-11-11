const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");
const { seedTeacherRows } = require("./teachers");
const { isWorkDay, generateSlots } = require("./schedule");
const storage = require("./storage");

const STORE_PATH = path.join(process.cwd(), "data", "store.json");
const SCHEMA_PATH = path.join(process.cwd(), "schema.sql");

class DuplicateSlotError extends Error {
  constructor() {
    super("Slot already booked");
    this.code = "23505";
    this.name = "DuplicateSlotError";
  }
}

let appPool;
let migratePool;
let readyPromise;

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Run neon deploy or neon env pull.");
  }
  return url;
}

function getAppPool() {
  if (!appPool) {
    appPool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 10,
    });
  }
  return appPool;
}

function getMigratePool() {
  if (!migratePool) {
    migratePool = new Pool({
      connectionString: process.env.DATABASE_URL_UNPOOLED || requireDatabaseUrl(),
      max: 1,
    });
  }
  return migratePool;
}

function mapTeacher(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    role: row.role || "",
    language: row.language,
    work_days: row.work_days,
    start_time: row.start_time,
    end_time: row.end_time,
    is_active: row.is_active !== false,
  };
}

function mapBooking(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    student_name: row.student_name,
    contact: row.contact,
    language: row.language,
    service: row.service,
    date: row.date,
    time_slot: row.time_slot,
    teacher_id: row.teacher_id ? Number(row.teacher_id) : null,
    teacher_name: row.teacher_name || row.teacher || "",
    teacher: row.teacher || row.teacher_name || "",
    source: row.source || "сайт",
    status: row.status,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function isPgDuplicate(error) {
  return error && error.code === "23505";
}

async function query(sql, params) {
  const result = await getAppPool().query(sql, params);
  return result;
}

async function ensureSchema() {
  const sql = await fs.readFile(SCHEMA_PATH, "utf8");
  await getMigratePool().query(sql);
}

async function readLocalStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      teachers: Array.isArray(parsed.teachers) ? parsed.teachers : [],
      bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [],
      telegram_sessions: Array.isArray(parsed.telegram_sessions)
        ? parsed.telegram_sessions
        : [],
    };
  } catch {
    return { teachers: [], bookings: [], telegram_sessions: [] };
  }
}

async function importLocalIfEmpty() {
  const teachersCount = await query("SELECT COUNT(*)::int AS n FROM teachers");
  const bookingsCount = await query("SELECT COUNT(*)::int AS n FROM bookings");
  const local = await readLocalStore();

  if (teachersCount.rows[0].n === 0 && local.teachers.length) {
    for (const teacher of local.teachers) {
      await query(
        `INSERT INTO teachers (id, name, role, language, work_days, start_time, end_time, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [
          teacher.id,
          teacher.name,
          teacher.role || "",
          teacher.language,
          teacher.work_days || "пн,вт,ср,чт,пт",
          teacher.start_time || "10:00",
          teacher.end_time || "20:00",
          teacher.is_active !== false,
        ]
      );
    }
  }

  if (bookingsCount.rows[0].n === 0 && local.bookings.length) {
    for (const booking of local.bookings) {
      await query(
        `INSERT INTO bookings (
            id, student_name, contact, language, service, date, time_slot,
            teacher_id, teacher_name, teacher, source, status, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING`,
        [
          booking.id,
          booking.student_name,
          booking.contact,
          booking.language,
          booking.service,
          booking.date,
          booking.time_slot,
          booking.teacher_id || null,
          booking.teacher_name || booking.teacher || "",
          booking.teacher || booking.teacher_name || "",
          booking.source || "сайт",
          booking.status || "Новая",
          booking.created_at || new Date().toISOString(),
        ]
      );
    }
  }

  if (local.telegram_sessions.length) {
    for (const session of local.telegram_sessions) {
      await query(
        `INSERT INTO telegram_sessions (chat_id, step, payload, updated_at)
         VALUES ($1,$2,$3::jsonb,$4)
         ON CONFLICT (chat_id) DO NOTHING`,
        [
          String(session.chat_id),
          session.step || "idle",
          JSON.stringify(session.payload || {}),
          session.updated_at || new Date().toISOString(),
        ]
      );
    }
  }

  await query(
    `SELECT setval(pg_get_serial_sequence('teachers', 'id'), COALESCE((SELECT MAX(id) FROM teachers), 1), true)`
  );
  await query(
    `SELECT setval(pg_get_serial_sequence('bookings', 'id'), COALESCE((SELECT MAX(id) FROM bookings), 1), true)`
  );
}

async function snapshotToStorage() {
  const teachers = await listTeachers({}, { skipReady: true });
  const bookings = await listBookings({}, { skipReady: true });
  await storage.putJson("backups/latest.json", {
    saved_at: new Date().toISOString(),
    teachers,
    bookings,
  });
}

async function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await ensureSchema();
      await importLocalIfEmpty();
      try {
        await snapshotToStorage();
      } catch (error) {
        console.error("Object storage snapshot failed:", error.message);
      }
    })();
  }
  return readyPromise;
}

async function listTeachers(filters, options) {
  if (!options || !options.skipReady) await ensureReady();
  const clauses = [];
  const params = [];
  if (filters && filters.language) {
    params.push(filters.language);
    clauses.push(`language = $${params.length}`);
  }
  if (filters && filters.active) {
    clauses.push("is_active = TRUE");
  }
  if (filters && filters.id) {
    params.push(Number(filters.id));
    clauses.push(`id = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `SELECT id, name, role, language, work_days, start_time, end_time, is_active
     FROM teachers ${where} ORDER BY id ASC`,
    params
  );
  return result.rows.map(mapTeacher);
}

async function getTeacherById(id) {
  const rows = await listTeachers({ id: Number(id) });
  return rows[0] || null;
}

async function createTeacher(fields) {
  await ensureReady();
  const result = await query(
    `INSERT INTO teachers (name, role, language, work_days, start_time, end_time, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, name, role, language, work_days, start_time, end_time, is_active`,
    [
      fields.name,
      fields.role || "",
      fields.language,
      fields.work_days,
      fields.start_time,
      fields.end_time,
      fields.is_active !== false,
    ]
  );
  const teacher = mapTeacher(result.rows[0]);
  snapshotToStorage().catch((error) => console.error("Object storage snapshot failed:", error.message));
  return teacher;
}

async function getBookedSlots(date, teacherId) {
  await ensureReady();
  const params = [date];
  let sql =
    "SELECT time_slot FROM bookings WHERE date = $1 AND status != 'Отменена'";
  if (teacherId) {
    params.push(Number(teacherId));
    sql += ` AND teacher_id = $${params.length}`;
  }
  const result = await query(sql, params);
  return result.rows.map((row) => row.time_slot);
}

async function listBookings(filters, options) {
  if (!options || !options.skipReady) await ensureReady();
  const clauses = [];
  const params = [];
  if (filters && filters.teacherId) {
    params.push(Number(filters.teacherId));
    clauses.push(`teacher_id = $${params.length}`);
  }
  if (filters && filters.language) {
    params.push(filters.language);
    clauses.push(`language = $${params.length}`);
  }
  if (filters && filters.from) {
    params.push(filters.from);
    clauses.push(`date >= $${params.length}`);
  }
  if (filters && filters.to) {
    params.push(filters.to);
    clauses.push(`date <= $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `SELECT id, student_name, contact, language, service, date, time_slot,
            teacher_id, teacher_name, teacher, source, status, created_at
     FROM bookings ${where}
     ORDER BY date ASC, time_slot ASC`,
    params
  );
  return result.rows.map(mapBooking);
}

async function createBooking(fields) {
  await ensureReady();
  const teacher =
    (fields.teacher_id && (await getTeacherById(fields.teacher_id))) ||
    (await listTeachers({ language: fields.language, active: true }))[0] ||
    null;
  if (!teacher) throw new Error("Teacher not found");
  if (teacher.is_active === false) throw new Error("Teacher inactive");
  if (!isWorkDay(teacher, fields.date)) throw new Error("Teacher day off");
  if (!generateSlots(teacher.start_time, teacher.end_time).includes(fields.time_slot)) {
    throw new Error("Slot outside schedule");
  }

  try {
    const result = await query(
      `INSERT INTO bookings (
          student_name, contact, language, service, date, time_slot,
          teacher_id, teacher_name, teacher, source, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Новая')
       RETURNING id, student_name, contact, language, service, date, time_slot,
                 teacher_id, teacher_name, teacher, source, status, created_at`,
      [
        fields.student_name,
        fields.contact,
        fields.language,
        fields.service,
        fields.date,
        fields.time_slot,
        teacher.id,
        teacher.name,
        teacher.name,
        fields.source || "сайт",
      ]
    );
    const booking = mapBooking(result.rows[0]);
    snapshotToStorage().catch((error) => console.error("Object storage snapshot failed:", error.message));
    return booking;
  } catch (error) {
    if (isPgDuplicate(error)) throw new DuplicateSlotError();
    throw error;
  }
}

async function updateBookingStatus(id, status, options) {
  await ensureReady();
  const params = [status, Number(id)];
  let sql = "UPDATE bookings SET status = $1 WHERE id = $2";
  if (options && options.teacherId) {
    params.push(Number(options.teacherId));
    sql += ` AND teacher_id = $${params.length}`;
  }
  sql += ` RETURNING id, student_name, contact, language, service, date, time_slot,
           teacher_id, teacher_name, teacher, source, status, created_at`;
  try {
    const result = await query(sql, params);
    const booking = mapBooking(result.rows[0]);
    if (booking) {
      snapshotToStorage().catch((error) => console.error("Object storage snapshot failed:", error.message));
    }
    return booking;
  } catch (error) {
    if (isPgDuplicate(error)) throw new DuplicateSlotError();
    throw error;
  }
}

async function getTelegramSession(chatId) {
  await ensureReady();
  const result = await query(
    "SELECT chat_id, step, payload, updated_at FROM telegram_sessions WHERE chat_id = $1",
    [String(chatId)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    chat_id: row.chat_id,
    step: row.step,
    payload: row.payload || {},
    updated_at: row.updated_at,
  };
}

async function saveTelegramSession(chatId, step, payload) {
  await ensureReady();
  const result = await query(
    `INSERT INTO telegram_sessions (chat_id, step, payload, updated_at)
     VALUES ($1,$2,$3::jsonb,NOW())
     ON CONFLICT (chat_id) DO UPDATE SET step = EXCLUDED.step, payload = EXCLUDED.payload, updated_at = NOW()
     RETURNING chat_id, step, payload, updated_at`,
    [String(chatId), step, JSON.stringify(payload || {})]
  );
  const row = result.rows[0];
  return {
    chat_id: row.chat_id,
    step: row.step,
    payload: row.payload || {},
    updated_at: row.updated_at,
  };
}

async function clearTelegramSession(chatId) {
  await ensureReady();
  await query("DELETE FROM telegram_sessions WHERE chat_id = $1", [String(chatId)]);
}

function bookingTeacherName(booking) {
  return booking && (booking.teacher_name || booking.teacher || "");
}

module.exports = {
  DuplicateSlotError,
  bookingTeacherName,
  ensureReady,
  listTeachers,
  getTeacherById,
  createTeacher,
  getBookedSlots,
  listBookings,
  createBooking,
  updateBookingStatus,
  getTelegramSession,
  saveTelegramSession,
  clearTelegramSession,
};
