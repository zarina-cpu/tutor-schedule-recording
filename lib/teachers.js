const SEED_TEACHERS = [
  {
    language: "Английский",
    name: "Анна Уорд",
    role: "CELTA, 12 лет практики, подготовка к IELTS и разговорная речь",
    envKey: "TEACHER_PASSWORD_EN",
  },
  {
    language: "Немецкий",
    name: "Мартин Келлер",
    role: "Преподаватель Goethe-Institut, уровень C2, экзамены TestDaF",
    envKey: "TEACHER_PASSWORD_DE",
  },
  {
    language: "Французский",
    name: "Камиль Дюпон",
    role: "Sorbonne, DALF C1, литература и живой парижский французский",
    envKey: "TEACHER_PASSWORD_FR",
  },
  {
    language: "Испанский",
    name: "Лусия Эррера",
    role: "Носитель из Мадрида, экзаменатор DELE, разговорная практика",
    envKey: "TEACHER_PASSWORD_ES",
  },
  {
    language: "Итальянский",
    name: "Марко Беллини",
    role: "CILS, произношение и культура, занятия без учебника-шаблона",
    envKey: "TEACHER_PASSWORD_IT",
  },
  {
    language: "Китайский",
    name: "Ли Вэй",
    role: "Носитель, HSK 1–6, иероглифика и деловой китайский",
    envKey: "TEACHER_PASSWORD_ZH",
  },
  {
    language: "Корейский",
    name: "Пак Минджи",
    role: "TOPIK 6, хангыль с нуля и разговор для K-culture",
    envKey: "TEACHER_PASSWORD_KO",
  },
  {
    language: "Японский",
    name: "Юки Танака",
    role: "JLPT N1, кейго и спокойный темп для начинающих",
    envKey: "TEACHER_PASSWORD_JA",
  },
  {
    language: "Турецкий",
    name: "Элиф Йылмаз",
    role: "TÖMER, носитель, разговор для путешествий и учёбы",
    envKey: "TEACHER_PASSWORD_TR",
  },
  {
    language: "Арабский",
    name: "Амир Хасан",
    role: "Носитель, фусха и разговорный диалект, чтение с огласовками",
    envKey: "TEACHER_PASSWORD_AR",
  },
];

function teacherPassword(teacher) {
  return String(process.env[teacher.envKey] || "").trim();
}

function seedTeacherRows() {
  return SEED_TEACHERS.map((item, index) => ({
    id: index + 1,
    name: item.name,
    role: item.role,
    language: item.language,
    work_days: "пн,вт,ср,чт,пт",
    start_time: "10:00",
    end_time: "20:00",
    is_active: true,
  }));
}

function publicTeacher(teacher) {
  if (!teacher) return null;
  return {
    id: teacher.id,
    name: teacher.name,
    role: teacher.role || "",
    title: teacher.role || "",
    language: teacher.language,
    work_days: teacher.work_days,
    start_time: teacher.start_time,
    end_time: teacher.end_time,
    is_active: teacher.is_active !== false,
  };
}

module.exports = {
  SEED_TEACHERS,
  TEACHERS: SEED_TEACHERS,
  teacherPassword,
  seedTeacherRows,
  publicTeacher,
};
