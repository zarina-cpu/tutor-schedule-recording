# Product Requirements Document (PRD): TutorBook

**Проект:** Система онлайн-записи для репетитора иностранных языков  
**Версия:** 1.0 (Cloud MVP)  
**Стек:** Node.js (Express), EJS, Tailwind CSS, Neon (Serverless PostgreSQL), Vercel  

---

## 1. Контекст и цель проекта (Context & Goals)
Необходимо разработать легкое веб-приложение для автоматизации записи учеников на языковые занятия. Система должна работать в serverless-среде Vercel с использованием облачной базы данных Neon PostgreSQL.

**Ключевые цели:**
* Исключить ручное согласование времени в мессенджерах.
* Гарантировать отсутствие двойного бронирования на один временной слот на уровне базы данных.
* Обеспечить простое управление расписанием и статусами заявок для преподавателя.

---

## 2. Структура проекта (Project Structure)
Для корректной сборки и маршрутизации на Vercel проект должен строго соответствовать следующей файловой структуре:

```text
/
├── api/
│   └── index.js          # Основной сервер Express (точка входа для Vercel)
├── views/
│   ├── index.ejs         # Публичная форма записи для учеников
│   └── admin.ejs         # Панель управления расписанием для репетитора
├── .env                  # Локальные переменные окружения (добавить в .gitignore)
├── .gitignore            # Исключение node_modules и .env
├── package.json          # Зависимости и скрипты запуска
└── vercel.json           # Конфигурация маршрутизации Vercel Serverless
```

---

## 3. Технический стек и зависимости (Tech Stack)
* **Runtime:** Node.js v18+
* **Web Framework:** `express`
* **Template Engine:** `ejs`
* **Styling:** Tailwind CSS (подключается через CDN в шаблонах `.ejs`)
* **Database Driver:** `@neondatabase/serverless` (HTTP-драйвер для работы с Neon PostgreSQL без исчерпания пула соединений)
* **Environment Management:** `dotenv`

**Команда установки зависимостей:**
```bash
npm install express ejs @neondatabase/serverless dotenv
```

---

## 4. Схема базы данных (Database Schema — Neon PostgreSQL)
Перед запуском приложения в консоли **Neon SQL Editor** выполняется следующий скрипт инициализации:

```sql
CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    student_name VARCHAR(100) NOT NULL,
    contact VARCHAR(100) NOT NULL,
    language VARCHAR(50) NOT NULL,
    service VARCHAR(150) NOT NULL,
    date VARCHAR(10) NOT NULL,
    time_slot VARCHAR(5) NOT NULL,
    status VARCHAR(20) DEFAULT 'Новая',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Частичный уникальный индекс для защиты от двойного бронирования
CREATE UNIQUE INDEX IF NOT EXISTS unique_active_booking 
ON bookings (date, time_slot) 
WHERE status != 'Отменена';
```

**Правила работы с БД:**
* Код ошибки PostgreSQL `23505` (unique_violation) при вставке означает, что слот уже занят. Приложение должно перехватывать эту ошибку и делать редирект на `/?error=1`.
* При смене статуса заявки на `Отменена` уникальный индекс перестает действовать на эту строку, и слот автоматически возвращается в список свободных.

---

## 5. Спецификация маршрутов и API (Endpoints)

| Метод | Маршрут | Описание и логика работы |
| :--- | :--- | :--- |
| `GET` | `/` | Рендерит `views/index.ejs`. Передает массив услуг `SERVICES`, а также флаги `success` (`req.query.success === '1'`) и `error` (`req.query.error === '1'`). |
| `GET` | `/api/slots` | Принимает query-параметр `date` (`YYYY-MM-DD`). Выбирает из БД все `time_slot` на эту дату, где `status != 'Отменена'`. Возвращает JSON: `{ "available_slots": [...] }`. |
| `POST` | `/book` | Принимает `student_name`, `contact`, `language`, `service`, `date`, `time_slot`. Выполняет `INSERT` в таблицу `bookings`. При успехе редирект на `/?success=1`, при ошибке `23505` — на `/?error=1`. |
| `GET` | `/admin` | Запрашивает все записи из `bookings` с сортировкой `ORDER BY date DESC, time_slot ASC`. Рендерит `views/admin.ejs`. |
| `POST` | `/admin/status/:id` | Принимает `id` из параметров URL и `status` из тела запроса. Обновляет статус записи в БД и делает редирект на `/admin`. |

---

## 6. Бизнес-логика и справочники (Business Logic)

### 6.1. Справочник услуг (`SERVICES`)
Задается в коде `api/index.js`:
* `Пробный урок + определение уровня (30 мин)` — Бесплатно
* `Индивидуальное занятие (60 мин)` — 150 000 сум / 1500 ₽
* `Подготовка к IELTS / TOEFL / ЕГЭ (60 мин)` — 200 000 сум / 2000 ₽
* `Разговорная практика (45 мин)` — 120 000 сум / 1200 ₽

### 6.2. Сетка рабочих часов (`ALL_SLOTS`)
Базовый массив времени: `['10:00', '11:30', '14:00', '15:30', '17:00', '18:30', '20:00']`.

### 6.3. Статусы заявок
Допустимые значения поля `status`:
* `Новая` (по умолчанию при создании, синий индикатор)
* `Подтверждена` (зеленый индикатор)
* `Проведена` (нейтральный индикатор)
* `Отменена` (красный индикатор, освобождает слот)

---

## 7. Требования к фронтенду (Frontend Specifications)

### 7.1. Страница записи (`views/index.ejs`)
* Поле выбора даты (`<input type="date">`) должно иметь атрибут `min`, установленный на текущую дату (`new Date().toISOString().split("T")[0]`).
* При событии `change` на поле даты выполняется асинхронный `fetch('/api/slots?date=...')`.
* Пока идет загрузка или если свободных слотов нет, `<select name="time_slot">` блокируется (`disabled`).
* Все поля формы обязательны (`required`).

### 7.2. Панель администратора (`views/admin.ejs`)
* Адаптивная таблица со списком всех записей.
* В колонке «Статус» находится `<form action="/admin/status/<%= b.id %>" method="POST">` с выпадающим списком `<select name="status" onchange="this.form.submit()">` для мгновенного обновления статуса.

---

## 8. Конфигурация Vercel и окружения (Deployment Rules)

1. **Файл `vercel.json`:**
```json
{
  "version": 2,
  "rewrites": [
    { "source": "/(.*)", "destination": "/api/index.js" }
  ]
}
```

2. **Правила для `api/index.js`:**
* Путь к шаблонам должен задаваться через `path.join(process.cwd(), 'views')`.
* Локальный запуск сервера (`app.listen(3000)`) должен выполняться только при условии `process.env.NODE_ENV !== 'production'`.
* В конце файла обязателен экспорт: `module.exports = app;`.

3. **Переменные окружения (Environment Variables):**
* `DATABASE_URL` — строка подключения к Neon PostgreSQL (`postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`).

---

## 9. Инструкция для AI-ассистента (Cursor Rules)
При генерации и модификации кода в рамках этого проекта придерживаться следующих правил:
1. Использовать исключительно параметризованные шаблонные запросы драйвера `@neondatabase/serverless` (например, ``await sql`SELECT * FROM bookings WHERE date = ${date}` ``) для защиты от SQL-инъекций.
2. Не использовать локальную файловую систему для хранения данных или логов (совместимость с Read-Only FS на Vercel).
3. Сохранять чистый, минималистичный UI на базе стандартных классов Tailwind CSS без подключения сторонних UI-фреймворков.
