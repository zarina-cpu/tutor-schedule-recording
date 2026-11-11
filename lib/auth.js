const crypto = require("crypto");
const { SEED_TEACHERS, teacherPassword } = require("./teachers");

const COOKIE_NAME = "tutorbook_admin";

function adminSecret() {
  return process.env.ADMIN_PASSWORD || "";
}

function signingSecret() {
  const admin = adminSecret();
  if (admin) return admin;
  return SEED_TEACHERS.map(teacherPassword).join("|") || "tutorbook-session";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function signPayload(payload) {
  return crypto.createHmac("sha256", signingSecret()).update(payload).digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function isValidAdminPassword(password) {
  const secret = adminSecret();
  if (!secret) return false;
  return safeEqual(password, secret);
}

function matchSeedByPassword(password) {
  let found = null;
  SEED_TEACHERS.forEach((teacher) => {
    const secret = teacherPassword(teacher);
    if (secret && safeEqual(password, secret)) found = teacher;
  });
  return found;
}

function resolveLogin(password, teachers) {
  const value = String(password || "");
  if (isValidAdminPassword(value)) {
    return { role: "school" };
  }
  const seed = matchSeedByPassword(value);
  if (!seed) return null;
  const rows = Array.isArray(teachers) ? teachers : [];
  const teacher =
    rows.find((item) => item.language === seed.language && item.name === seed.name) ||
    rows.find((item) => item.language === seed.language);
  if (!teacher) return null;
  return {
    role: "teacher",
    teacherId: teacher.id,
    language: teacher.language,
    teacherName: teacher.name,
  };
}

function encodeSession(session) {
  const payload =
    session.role === "school" ? "school" : `teacher:${session.teacherId}`;
  return `${payload}.${signPayload(payload)}`;
}

function getSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token || !token.includes(".")) return null;
  const idx = token.lastIndexOf(".");
  const payload = token.slice(0, idx);
  const signature = token.slice(idx + 1);
  if (!safeEqual(signature, signPayload(payload))) return null;
  if (payload === "school") return { role: "school" };
  if (payload.startsWith("teacher:")) {
    const teacherId = Number(payload.slice("teacher:".length));
    if (!teacherId) return null;
    return { role: "teacher", teacherId };
  }
  return null;
}

function setSessionCookie(res, session) {
  const token = encodeSession(session);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`
  );
}

function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

module.exports = {
  resolveLogin,
  getSession,
  setSessionCookie,
  clearAdminCookie,
};
