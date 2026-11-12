const { formatSum, serviceAmount, PAYMENT_METHODS } = require("./catalog");

function adminChatId() {
  return process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_TUTOR_CHAT_ID || "";
}

function cardNumber() {
  return process.env.CARD_NUMBER || "8600 •••• •••• 1234";
}

function httpsOrigin(value) {
  const text = String(value || "").trim().replace(/\/$/, "");
  if (!text) return "";
  if (/^https:\/\//i.test(text)) return text;
  if (/^http:\/\//i.test(text)) return text.replace(/^http:\/\//i, "https://");
  return `https://${text.replace(/^\/+/, "")}`;
}

function requestBaseUrl(req) {
  if (!req) return "";
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = req.get("host");
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/$/, "");
}

function publicBaseUrl(req) {
  const fromEnv = httpsOrigin(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_URL);
  if (fromEnv) return fromEnv;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return httpsOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  }
  if (process.env.VERCEL_URL) return httpsOrigin(process.env.VERCEL_URL);
  const fromReq = requestBaseUrl(req);
  if (fromReq) return fromReq;
  return "http://localhost:3001";
}

function payOrigin(req) {
  const origin = publicBaseUrl(req);
  if (/^https:\/\//i.test(origin)) return origin;
  return httpsOrigin("tutor-schedule-recording.vercel.app");
}

function normalizePayment(service, method, receiptData) {
  const amount = serviceAmount(service);
  if (amount <= 0) {
    return {
      amount: 0,
      payment_method: "free",
      payment_status: "Бесплатно",
      receipt_data: null,
    };
  }
  const payment_method = PAYMENT_METHODS.includes(method) && method !== "free" ? method : "stripe";
  if (payment_method === "receipt") {
    return {
      amount,
      payment_method,
      payment_status: "На проверке (чек)",
      receipt_data: receiptData || null,
    };
  }
  return {
    amount,
    payment_method,
    payment_status: "Ожидает оплаты",
    receipt_data: null,
  };
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 4 * 1024 * 1024) return null;
  return { mime, buffer };
}

async function createStripeCheckout(booking, origin, stripeClient) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  const stripe = stripeClient || require("stripe")(secret);
  const host = (origin && /^https?:\/\//i.test(origin) ? origin : payOrigin()).replace(/\/$/, "");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "uzs",
          unit_amount: Number(booking.amount) * 100,
          product_data: {
            name: booking.service,
            description: `${booking.language} · ${booking.date} в ${booking.time_slot}`,
          },
        },
      },
    ],
    metadata: {
      booking_id: String(booking.id),
      tg_chat_id: String(booking.tg_chat_id || ""),
    },
    success_url: `${host}/payment/stripe/success?session_id={CHECKOUT_SESSION_ID}&booking_id=${booking.id}`,
    cancel_url: `${host}/?payment_canceled=1`,
  });
  return { url: session.url, id: session.id };
}

function paymeCheckoutUrl(booking, origin) {
  const host = (origin && /^https?:\/\//i.test(origin) ? origin : payOrigin()).replace(/\/$/, "");
  const merchant = process.env.PAYME_MERCHANT_ID;
  if (!merchant) {
    return `${host}/payment/payme/stub?booking_id=${booking.id}`;
  }
  const amountTiyin = Number(booking.amount) * 100;
  const params = `m=${merchant};ac.booking_id=${booking.id};a=${amountTiyin};c=${encodeURIComponent(
    `${host}/?success=1`
  )}`;
  const base64Params = Buffer.from(params).toString("base64");
  const gateway =
    process.env.PAYME_TEST_MODE === "true" ? "https://checkout.test.paycom.uz" : "https://checkout.paycom.uz";
  return `${gateway}/${base64Params}`;
}

function paymentBadge(booking) {
  const status = booking.payment_status || "Бесплатно";
  const method = booking.payment_method || "free";
  const methodLabel =
    method === "stripe" ? "Stripe" : method === "payme" ? "Payme" : method === "receipt" ? "Чек" : "";
  if (status === "Оплачено") {
    return { text: methodLabel ? `Оплачено · ${methodLabel}` : "Оплачено", tone: "paid" };
  }
  if (status === "На проверке (чек)") return { text: "На проверке · Чек", tone: "review" };
  if (status === "Ожидает оплаты") return { text: "Ожидает оплаты", tone: "wait" };
  if (status === "Отклонено") return { text: "Отклонено", tone: "reject" };
  return { text: "Бесплатно", tone: "free" };
}

module.exports = {
  adminChatId,
  cardNumber,
  publicBaseUrl,
  requestBaseUrl,
  payOrigin,
  normalizePayment,
  parseDataUrl,
  createStripeCheckout,
  paymeCheckoutUrl,
  paymentBadge,
  formatSum,
};
