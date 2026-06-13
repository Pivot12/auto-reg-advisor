# Usage analytics → Google Sheets (free, real-time)

Every question logs one row to your sheet: **timestamp, country, region, city, the question, which sources were used, status, answer length, device**. It's live (each query appends instantly), so there's nothing to run "once a day" — the sheet is always current.

**What you CAN see:** how much it's used (rows/day), where (country/region/city, from the network edge), what people ask, and which agencies get hit most.
**What you CANNOT see:** *who* individually — there's no login, so no names/emails. Coarse geo + device is the ceiling for an anonymous public tool. (Adding "who" would mean adding sign-in, which kills casual usage.)

## Setup (5 minutes, one time)
1. Create a Google Sheet (any name). Copy its ID from the URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
2. In that sheet: **Extensions → Apps Script**. Delete the sample code, paste the contents of `Code.gs`, and replace `PASTE_YOUR_GOOGLE_SHEET_ID_HERE` with the ID from step 1. Save.
3. **Deploy → New deployment → type: Web app.** Execute as: **Me**. Who has access: **Anyone**. Deploy, authorize, and copy the **Web app URL** (ends in `/exec`).
4. In Vercel → your project → **Settings → Environment Variables**, add:
   `SHEETS_WEBHOOK_URL = https://script.google.com/macros/s/.../exec` → **Redeploy**.

Done. Ask the live app a question, then check the sheet — a row appears. Build charts in the sheet (a pivot on `country` and a count by day) if you want a dashboard.

> Note: this URL is a write-only logger. If you ever want to stop logging, just delete the env var and redeploy.
