const SERVICES = [
  { name: "Пробный урок + определение уровня (30 мин)", amount: 0 },
  { name: "Индивидуальное занятие (60 мин)", amount: 150000 },
  { name: "Подготовка к IELTS / TOEFL / ЕГЭ (60 мин)", amount: 200000 },
  { name: "Разговорная практика (45 мин)", amount: 120000 },
].map((service) => ({
  ...service,
  price: formatSum(service.amount),
}));

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

const PAYMENT_METHODS = ["free", "stripe", "payme", "receipt"];

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatSum(amount) {
  const n = Number(amount) || 0;
  if (n <= 0) return "Бесплатно";
  return `${n.toLocaleString("ru-RU")} сум`;
}

function serviceAmount(service) {
  const found = SERVICES.find((item) => item.name === service);
  return found ? Number(found.amount) || 0 : 0;
}

function serviceLabel(service) {
  return `${service} — ${formatSum(serviceAmount(service))}`;
}

module.exports = {
  SERVICES,
  ALL_SLOTS,
  LANGUAGES,
  STATUSES,
  PAYMENT_METHODS,
  todayISO,
  isValidDate,
  formatSum,
  serviceAmount,
  serviceLabel,
};
