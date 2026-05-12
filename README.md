# PayVerify Backend

Node.js + Express + PostgreSQL backend for PayVerify.

## Setup

1. Copy environment file and edit values:
   ```bash
   cp .env.example .env
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create the PostgreSQL database (one time):
   ```bash
   createdb payverify
   ```
   Or via psql:
   ```sql
   CREATE DATABASE payverify;
   ```

4. Run migrations:
   ```bash
   npm run migrate
   ```

5. Seed default admin (`admin / admin@123` — change in `.env` first):
   ```bash
   npm run seed
   ```

6. Start the server:
   ```bash
   npm run dev
   ```

Backend will be live at `http://localhost:4000`.

## API Endpoints

### Health
- `GET /health`

### Merchant
- `POST /api/merchant/register` — body: `{ name, password, mobile, domain, industry, country, state }`
- `POST /api/merchant/login` — body: `{ username, password }`
- `GET  /api/merchant/me` — auth required (Bearer token)

### Admin
- `POST /api/admin/login` — body: `{ username, password }`
- `GET  /api/admin/merchants` — auth required, keys returned masked
- `GET  /api/admin/merchants/:id` — auth required, keys returned masked
- `POST /api/admin/merchants` — auth required, body same as merchant register

## Notes

- Username is auto-generated from `name` (lowercase + underscore, numeric suffix on collision).
- Auth keys returned to admin are **masked except last 4 chars** (e.g. `••••••K9`).
- Wallet balance defaults to `0`.
