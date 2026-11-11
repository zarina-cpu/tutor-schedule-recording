const SERVICES = [
  { name: "Пробный урок + определение уровня (30 мин)", price: "Бесплатно" },
  { name: "Индивидуальное занятие (60 мин)", price: "150 000 сум" },
  { name: "Подготовка к IELTS / TOEFL / ЕГЭ (60 мин)", price: "200 000 сум" },
  { name: "Разговорная практика (45 мин)", price: "120 000 сум" },
];

const ALL_SLOTS = ["10:00", "11:30", "14:00", "15:30", "17:00", "18:30", "20:00"];

const LANGUAGES = [
  "Английский",
  "Немецкий",
  "Французский",
  "Испанский",
  "Итальянский",
  "Китайский",
  "Корейский",
  "Японский",
  "Турецкий",
  "Арабский",
];

const STATUSES = ["Новая", "Подтверждена", "Проведена", "Отменена"];

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function serviceLabel(service) {
  const found = SERVICES.find((item) => item.name === service);
  if (!found) return service;
  return `${found.name} — ${found.price}`;
}

module.exports = {
  SERVICES,
  ALL_SLOTS,
  LANGUAGES,
  STATUSES,
  todayISO,
  isValidDate,
  serviceLabel,
};
