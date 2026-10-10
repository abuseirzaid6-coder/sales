# Sales Course Enrollment

A small website for your admin to enroll candidates in the Sales Course and pay the
**$150.92 certificate fee per candidate** with Stripe.

How it works:

1. The admin opens the site and signs in with the admin password.
2. They set the number of candidates (1–40 per payment), then type each candidate's
   full name and age. Anyone under 18 is rejected, both in the form and on the server.
3. **Continue to payment** opens Stripe Checkout. Each candidate appears as their own
   $150.92 line item, so the admin can double-check names before paying.
4. After paying, the admin lands on a confirmation page listing the enrolled candidates.
   If they cancel, they return to the form with everything they typed still filled in.

Every payment in your Stripe Dashboard carries the candidate names and ages in its
metadata (`candidate_01: Jane Doe (24)`, …), so Stripe is your record of who enrolled.

## 1. Get your Stripe keys

1. Sign in at <https://dashboard.stripe.com>.
2. Turn on **Test mode** (top right) while you try things out.
3. Go to **Developers → API keys** and copy the **Secret key** (`sk_test_…`).

Never put the secret key in the website code or share it. It only goes in the server's
environment variables (see below).

## 2. Run it on your computer (optional)

Requires [Node.js 22+](https://nodejs.org).

```bash
npm install
cp .env.example .env      # then paste your sk_test_ key into .env
npm start                 # open http://localhost:3000
```

Pay with Stripe's test card `4242 4242 4242 4242`, any future expiry date, and any CVC.

## 3. Put it online (Render, free)

1. Create an account at <https://render.com> and connect your GitHub.
2. Click **New → Blueprint** and pick this repository. Render reads `render.yaml`.
3. When asked, fill in:
   - `STRIPE_SECRET_KEY`: your `sk_test_…` key (switch to `sk_live_…` when you go live)
   - `ADMIN_PASSWORD`: the password you'll give your admin
   - `PUBLIC_URL`: the address Render gives the site, e.g. `https://sales-course-enrollment.onrender.com`
   - `STRIPE_WEBHOOK_SECRET`: leave empty for now, fill it in after step 4
4. Deploy, then send your admin the link and the password. The browser asks for a
   username and password; the username can be anything.

On Render's free plan the site goes to sleep when unused, so the first visit after a
while takes about a minute to load. A paid plan keeps it awake.

## 4. Connect the Stripe webhook (recommended)

The webhook tells the server when a payment actually succeeds, even if the admin closes
the tab before the confirmation page loads.

1. In Stripe, go to **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://YOUR-SITE/api/webhook`
3. Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Copy the **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` on Render and redeploy.

Paid enrollments are then written to the server log and to `data/enrollments.jsonl`.
Render's free disk is wiped on each deploy, so treat the Stripe Dashboard as the
permanent record.

## 5. Go live

1. Finish activating your Stripe account (business details and bank account).
2. Switch the Dashboard out of test mode, copy the **live** secret key (`sk_live_…`),
   and put it in `STRIPE_SECRET_KEY`.
3. Create the webhook again in live mode and update `STRIPE_WEBHOOK_SECRET`.
4. Optional: in **Settings → Branding**, upload the logo (`public/logo.png`) and set the
   brand color to `#0057d9` so Stripe's checkout page matches the site.

## Changing the fee or rules

Edit `public/shared.js`. Both the form and the server read from it:

- `feeCents`: the fee in cents (`15092` = $150.92)
- `minAge`: the minimum age (18)
- `maxCandidates`: the most candidates per payment (40; Stripe metadata limits it to 48)

## Development

```bash
npm test          # runs the server and validation tests (no Stripe account needed)
npm run dev       # restarts the server when files change
```

| Path | What it is |
| --- | --- |
| `server.js` | Reads the settings from the environment and starts the server |
| `src/app.js` | Routes: create checkout, look up a payment, Stripe webhook, admin password |
| `public/` | The website: enrollment form, confirmation page, logo, styles |
| `public/shared.js` | Fee and validation rules shared by the browser and the server |
| `test/` | Automated tests |
