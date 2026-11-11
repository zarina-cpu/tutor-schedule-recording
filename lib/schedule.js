const WEEK_DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const SLOT_MINUTES = 90;

function parseMinutes(hhmm) {
  const parts = String(hhmm || "10:00")
    .slice(0, 5)
    .split(":")
    .map(Number);
  const hours = Number.isFinite(parts[0]) ? parts[0] : 10;
  const minutes = Number.isFinite(parts[1]) ? parts[1] : 0;
  return hours * 60 + minutes;
}

function formatMinutes(total) {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function generateSlots(startTime, endTime) {
  const start = parseMinutes(startTime || "10:00");
  const end = parseMinutes(endTime || "20:00");
  if (end < start) return [];
  const slots = [];
  for (let time = start; time <= end; time += SLOT_MINUTES) {
    slots.push(formatMinutes(time));
  }
  const endLabel = formatMinutes(end);
  if (!slots.includes(endLabel)) slots.push(endLabel);
  return slots;
}

function workDayList(workDays) {
  const allowed = new Set(WEEK_DAYS);
  return String(workDays || "")
    .split(",")
    .map((day) => day.trim().toLowerCase())
    .filter((day) => allowed.has(day));
}

function weekdayKey(dateISO) {
  const date = new Date(`${dateISO}T12:00:00`);
  return WEEK_DAYS[(date.getDay() + 6) % 7];
}

function isWorkDay(teacher, dateISO) {
  return workDayList(teacher && teacher.work_days).includes(weekdayKey(dateISO));
}

function addDays(dateISO, amount) {
  const date = new Date(`${dateISO}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return date.toISOString().split("T")[0];
}

function mondayOf(dateISO) {
  const date = new Date(`${dateISO}T12:00:00`);
  const day = date.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + offset);
  return date.toISOString().split("T")[0];
}

function weekDates(mondayISO) {
  return WEEK_DAYS.map((_, index) => addDays(mondayISO, index));
}

function formatDay(dateISO) {
  const [, month, day] = dateISO.split("-");
  return `${day}.${month}`;
}

function formatRange(mondayISO) {
  const end = addDays(mondayISO, 6);
  const format = (iso) => {
    const [year, month, day] = iso.split("-");
    return `${day}.${month}.${year}`;
  };
  return `${format(mondayISO)} — ${format(end)}`;
}

function normalizeWorkDays(value) {
  const selected = new Set(workDayList(Array.isArray(value) ? value.join(",") : value));
  return WEEK_DAYS.filter((day) => selected.has(day)).join(",") || "пн,вт,ср,чт,пт";
}

function normalizeTime(value, fallback) {
  const text = String(value || fallback || "10:00").slice(0, 5);
  return /^\d{2}:\d{2}$/.test(text) ? text : fallback || "10:00";
}

module.exports = {
  WEEK_DAYS,
  SLOT_MINUTES,
  generateSlots,
  workDayList,
  weekdayKey,
  isWorkDay,
  addDays,
  mondayOf,
  weekDates,
  formatDay,
  formatRange,
  normalizeWorkDays,
  normalizeTime,
};
