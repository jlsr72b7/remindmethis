# Special Date Reminder Backend (Postgres + Prisma)

This backend gives your app persistent account and reminder storage in PostgreSQL and is designed to port cleanly to AWS or Azure.

## Stack

- Node.js + Express
- PostgreSQL
- Prisma ORM
- bcrypt password hashing

## 1) Setup

1. Copy `.env.example` to `.env`.
2. Install backend dependencies:

```bash
cd backend
npm install
```

## 2) Start local PostgreSQL (Docker)

```bash
npm run db:up
```

## 3) Create DB schema

```bash
npm run prisma:migrate -- --name init
npm run prisma:generate
```

## 4) Run backend

```bash
npm run dev
```

Health check:

- `GET http://localhost:4000/health`
- `GET http://localhost:4000/legal/user-agreement`
- `GET http://localhost:4000/admin/user-count`
- `GET http://localhost:4000/admin/event-reminder-counts`

## User agreement hosting

The backend serves the signup agreement from a fixed route:

- `GET /legal/user-agreement`

Place the agreement file in:

- `backend/public/legal/`

Accepted file names:

- `Remind_Me_This_EULA_August_5_2026.pdf`
- `Remind_Me_This_EULA_August_5_2026.docx`
- `user-agreement.pdf`
- `user-agreement.docx`
- `user-agreement.html`
- `user-agreement.txt`

If `EXPO_PUBLIC_USER_AGREEMENT_URL` is not set in the frontend, the signup link defaults to the backend route above.

## Email verification setup

The backend can send verification emails during signup.

Required `.env` fields:

- `EMAIL_VERIFICATION_BASE_URL` (usually `http://localhost:4000`)
- `EMAIL_FROM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_SECURE`

If SMTP is not configured, the backend will log the verification link for local development.

## SMS setup (Twilio provider interface)

The backend includes an SMS provider interface with two modes:

- `SMS_PROVIDER=noop` (default): safe fallback, logs SMS payload and does not send
- `SMS_PROVIDER=twilio`: sends via Twilio

Required `.env` fields for Twilio:

- `SMS_PROVIDER=twilio`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

When Twilio is not configured, SMS requests are handled by the no-op provider so your reminder flow does not crash.

## Google Places address autocomplete setup

Address autofill endpoints require a server-side Google API key.

Set one of these `.env` fields:

- `GOOGLE_PLACES_API_KEY` (preferred)
- `GOOGLE_MAPS_API_KEY` (legacy fallback)

Required Google API enablement:

- Places API (New)

Related endpoints:

- `GET /google/places/autocomplete?input=...`
- `GET /google/places/details?placeId=...`

If the key is missing, the backend returns HTTP 500 with:

- `{"error":"Google Places API key is not configured. Set GOOGLE_PLACES_API_KEY (or GOOGLE_MAPS_API_KEY)."}`

## API endpoints

- `POST /auth/signup`
- `POST /auth/signin`
- `GET /auth/verify-email?token=...`
- `POST /notifications/reminder-email`
- `POST /notifications/reminder-sms`
- `POST /admin/test-reminder-sms`
- `GET /admin/user-count`
- `GET /admin/event-reminder-counts`
- `GET /users/:userId/events`
- `PUT /users/:userId/events`

Example body for SMS test endpoint:

```json
{
	"userId": "your-user-id"
}
```

or

```json
{
	"phoneNumber": "+15551234567",
	"message": "Custom test SMS from Special Date Reminder"
}
```

## Cloud porting

When you're ready for AWS/Azure:

1. Provision managed Postgres (AWS RDS or Azure Database for PostgreSQL).
2. Update `DATABASE_URL` to the managed database.
3. Run migrations:

```bash
npm run prisma:deploy
```

No schema code changes should be required.

## Security note

This backend hashes passwords. Do not keep plaintext passwords in app storage.
