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

const MONTH_TITLES = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

function monthStart(dateISO) {
  const iso = isIsoDate(dateISO) ? dateISO : new Date().toISOString().split("T")[0];
  return `${iso.slice(0, 7)}-01`;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function addMonths(dateISO, amount) {
  const start = monthStart(dateISO);
  const date = new Date(`${start}T12:00:00`);
  date.setMonth(date.getMonth() + Number(amount || 0));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthEnd(dateISO) {
  return addDays(addMonths(dateISO, 1), -1);
}

function monthDates(dateISO) {
  const start = monthStart(dateISO);
  const end = monthEnd(start);
  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(cursor);
  }
  return dates;
}

function formatMonthLabel(dateISO) {
  const start = monthStart(dateISO);
  const month = Number(start.slice(5, 7));
  return `${MONTH_TITLES[month - 1]} ${start.slice(0, 4)}`;
}

function offJsWeekdays(teacher) {
  const work = new Set(workDayList(teacher && teacher.work_days));
  return [0, 1, 2, 3, 4, 5, 6].filter((jsDay) => !work.has(WEEK_DAYS[(jsDay + 6) % 7]));
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
  monthStart,
  addMonths,
  monthEnd,
  monthDates,
  formatMonthLabel,
  offJsWeekdays,
  normalizeWorkDays,
  normalizeTime,
};
