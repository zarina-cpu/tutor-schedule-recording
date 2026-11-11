CREATE TABLE IF NOT EXISTS teachers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    role VARCHAR(150),
    language VARCHAR(50) NOT NULL,
    work_days VARCHAR(50) DEFAULT 'пн,вт,ср,чт,пт',
    start_time VARCHAR(5) DEFAULT '10:00',
    end_time VARCHAR(5) DEFAULT '20:00',
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    student_name VARCHAR(100) NOT NULL,
    contact VARCHAR(100) NOT NULL,
    language VARCHAR(50) NOT NULL,
    service VARCHAR(150) NOT NULL,
    date VARCHAR(10) NOT NULL,
    time_slot VARCHAR(5) NOT NULL,
    teacher_id INTEGER,
    teacher_name VARCHAR(100),
    teacher VARCHAR(100),
    source VARCHAR(50) DEFAULT 'сайт',
    status VARCHAR(20) DEFAULT 'Новая',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS telegram_sessions (
    chat_id VARCHAR(50) PRIMARY KEY,
    step VARCHAR(50),
    payload JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS teacher VARCHAR(100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS teacher_id INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS teacher_name VARCHAR(100);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS source VARCHAR(50);

INSERT INTO teachers (name, role, language, work_days, start_time, end_time, is_active)
SELECT seed.name, seed.role, seed.language, 'пн,вт,ср,чт,пт', '10:00', '20:00', TRUE
FROM (VALUES
    ('Анна Уорд', 'CELTA, 12 лет практики, подготовка к IELTS и разговорная речь', 'Английский'),
    ('Мартин Келлер', 'Преподаватель Goethe-Institut, уровень C2, экзамены TestDaF', 'Немецкий'),
    ('Камиль Дюпон', 'Sorbonne, DALF C1, литература и живой парижский французский', 'Французский'),
    ('Лусия Эррера', 'Носитель из Мадрида, экзаменатор DELE, разговорная практика', 'Испанский'),
    ('Марко Беллини', 'CILS, произношение и культура, занятия без учебника-шаблона', 'Итальянский'),
    ('Ли Вэй', 'Носитель, HSK 1–6, иероглифика и деловой китайский', 'Китайский'),
    ('Пак Минджи', 'TOPIK 6, хангыль с нуля и разговор для K-culture', 'Корейский'),
    ('Юки Танака', 'JLPT N1, кейго и спокойный темп для начинающих', 'Японский'),
    ('Элиф Йылмаз', 'TÖMER, носитель, разговор для путешествий и учёбы', 'Турецкий'),
    ('Амир Хасан', 'Носитель, фусха и разговорный диалект, чтение с огласовками', 'Арабский')
) AS seed(name, role, language)
WHERE NOT EXISTS (SELECT 1 FROM teachers);

UPDATE bookings b
SET teacher_id = t.id,
    teacher_name = t.name,
    teacher = t.name
FROM teachers t
WHERE b.teacher_id IS NULL
  AND (
    b.teacher = t.name
    OR b.teacher_name = t.name
    OR (COALESCE(b.teacher, '') = '' AND b.language = t.language)
  );

UPDATE bookings
SET teacher_name = COALESCE(NULLIF(teacher_name, ''), NULLIF(teacher, ''), language),
    teacher = COALESCE(NULLIF(teacher, ''), NULLIF(teacher_name, ''), language)
WHERE teacher_name IS NULL OR teacher_name = '' OR teacher IS NULL OR teacher = '';

DROP INDEX IF EXISTS unique_active_booking;

CREATE UNIQUE INDEX IF NOT EXISTS unique_active_booking
ON bookings (date, time_slot, teacher_id)
WHERE status != 'Отменена';
