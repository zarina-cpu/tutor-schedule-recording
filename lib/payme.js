const {
  getBookingById,
  getBookingByExternalId,
  updateBookingPayment,
} = require("./db");
const { notifyPaidIfTelegram, notifyStudentTelegram } = require("./notify");

function paymeError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, data: data || "booking_id" },
  };
}

function paymeResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function expectedAmount(booking) {
  return Number(booking.amount) * 100;
}

function isPaid(booking) {
  return booking && booking.payment_status === "Оплачено";
}

function isCanceled(booking) {
  return booking && (booking.payment_status === "Отклонено" || booking.status === "Отменена");
}

function paymeAuthorized(req) {
  const key = process.env.PAYME_SECRET_KEY || process.env.PAYME_KEY || "";
  const header = String(req.headers.authorization || "");
  if (!key || !header.toLowerCase().startsWith("basic ")) return false;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const password = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
  return password === key;
}

async function findAccount(account) {
  const bookingId = account && (account.booking_id || account.bookingId || account.order_id);
  if (!bookingId) return null;
  return getBookingById(bookingId);
}

function transactionView(booking) {
  const state = Number(booking.payme_state) || (isPaid(booking) ? 2 : isCanceled(booking) ? -1 : 1);
  return {
    create_time: Number(booking.payme_create_time) || Date.parse(booking.created_at) || Date.now(),
    perform_time: Number(booking.payme_perform_time) || 0,
    cancel_time: Number(booking.payme_cancel_time) || 0,
    transaction: String(booking.external_payment_id || booking.id),
    state,
    reason: state < 0 ? 5 : null,
  };
}

async function checkPerformTransaction(id, params) {
  const booking = await findAccount(params.account);
  if (!booking) return paymeError(id, -31050, "Booking not found");
  if (isPaid(booking) || isCanceled(booking) || booking.status === "Отменена") {
    return paymeError(id, -31008, "Unable to perform operation");
  }
  if (Number(params.amount) !== expectedAmount(booking)) {
    return paymeError(id, -31001, "Invalid amount");
  }
  return paymeResult(id, { allow: true });
}

async function createTransaction(id, params) {
  const booking = await findAccount(params.account);
  if (!booking) return paymeError(id, -31050, "Booking not found");
  if (Number(params.amount) !== expectedAmount(booking)) {
    return paymeError(id, -31001, "Invalid amount");
  }
  if (isPaid(booking)) {
    if (String(booking.external_payment_id) === String(params.id)) {
      return paymeResult(id, transactionView(booking));
    }
    return paymeError(id, -31008, "Unable to perform operation");
  }
  if (isCanceled(booking)) {
    return paymeError(id, -31008, "Unable to perform operation");
  }
  if (booking.external_payment_id && String(booking.external_payment_id) !== String(params.id) && Number(booking.payme_state) === 1) {
    return paymeError(id, -31008, "Transaction already exists");
  }
  const createTime = Number(booking.payme_create_time) || Number(params.time) || Date.now();
  const updated = await updateBookingPayment(booking.id, {
    payment_method: "payme",
    payment_status: "Ожидает оплаты",
    external_payment_id: String(params.id),
    payme_state: 1,
    payme_create_time: createTime,
    payme_perform_time: 0,
    payme_cancel_time: 0,
  });
  return paymeResult(id, transactionView(updated));
}

async function performTransaction(id, params) {
  const booking = await getBookingByExternalId(params.id);
  if (!booking) return paymeError(id, -31003, "Transaction not found");
  if (Number(booking.payme_state) === 2 || isPaid(booking)) {
    return paymeResult(id, transactionView(booking));
  }
  if (Number(booking.payme_state) < 0 || isCanceled(booking)) {
    return paymeError(id, -31008, "Unable to perform operation");
  }
  const performTime = Date.now();
  const updated = await updateBookingPayment(booking.id, {
    payment_method: "payme",
    payment_status: "Оплачено",
    payme_state: 2,
    payme_perform_time: performTime,
  });
  await notifyPaidIfTelegram(updated);
  return paymeResult(id, transactionView(updated));
}

async function cancelTransaction(id, params) {
  const booking = await getBookingByExternalId(params.id);
  if (!booking) return paymeError(id, -31003, "Transaction not found");
  const now = Date.now();
  if (Number(booking.payme_state) < 0 || booking.payment_status === "Отклонено") {
    return paymeResult(id, transactionView(booking));
  }
  const nextState = Number(booking.payme_state) === 2 || isPaid(booking) ? -2 : -1;
  const updated = await updateBookingPayment(booking.id, {
    payment_status: "Отклонено",
    payme_state: nextState,
    payme_cancel_time: now,
  });
  if (updated && updated.tg_chat_id) {
    await notifyStudentTelegram(
      updated.tg_chat_id,
      "❌ Оплата Payme отменена. Выберите другой способ или запишитесь заново: /start"
    );
  }
  return paymeResult(id, transactionView(updated));
}

async function checkTransaction(id, params) {
  const booking = await getBookingByExternalId(params.id);
  if (!booking) return paymeError(id, -31003, "Transaction not found");
  return paymeResult(id, transactionView(booking));
}

async function handlePaymeRpc(req) {
  const body = req.body || {};
  const id = body.id;
  if (!paymeAuthorized(req)) {
    return paymeError(id, -32504, "Insufficient privilege");
  }
  const method = body.method;
  const params = body.params || {};
  if (method === "CheckPerformTransaction") return checkPerformTransaction(id, params);
  if (method === "CreateTransaction") return createTransaction(id, params);
  if (method === "PerformTransaction") return performTransaction(id, params);
  if (method === "CancelTransaction") return cancelTransaction(id, params);
  if (method === "CheckTransaction") return checkTransaction(id, params);
  if (method === "GetStatement") return paymeResult(id, { transactions: [] });
  return paymeError(id, -32601, "Method not found");
}

module.exports = { handlePaymeRpc };
