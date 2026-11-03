# Cosmic Vibez Creations site

One small Node server (no npm packages) that serves the site, takes quote requests with file uploads, emails alerts, runs a password-protected admin page at `/admin`, and creates Stripe payment links.

- `server.js`: the server
- `public/index.html`, `public/policies.html`: the site
- `public/admin.html`: the quotes admin
- `public/paid.html`: where customers land after paying

No secrets live in this repo. Every key is set as an environment variable on Render.

## Environment variables (set on Render)

| Name | What it is |
|---|---|
| `DATA_DIR` | Folder on the Render disk, for example `/var/data`. Quotes and uploads are saved here. The server refuses to start on Render without it. |
| `ADMIN_PASSWORD` | One shared password for `/admin`. At least 10 characters. |
| `RESEND_API_KEY` | Resend API key (Sending access). |
| `STRIPE_SECRET_KEY` | Stripe secret key. Starts with `sk_test_` or `sk_live_`. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret. Starts with `whsec_`. |
| `ALERT_TO` | Optional. Where new-quote alerts go. Defaults to `Cosmicvibezcreations@gmail.com`. |
| `MAIL_FROM` | Optional. Defaults to `Cosmic Vibez Creations <quotes@cosmicvibezcreations.com>`. |
| `SITE_DOMAIN` | Optional. Defaults to `cosmicvibezcreations.com`. |

## 1. Render

1. Sign in at render.com. Go to New, then Web Service, and pick this repo.
2. Branch `main`. Runtime Node. Build Command `npm install`. Start Command `node server.js`.
3. Instance type: a paid one. Render only allows disks on paid services. Under Advanced, set Health Check Path to `/healthz`.
4. Under Advanced, add a Disk: mount path `/var/data`, size 1 GB is plenty to start (it can grow but not shrink). Check Render's pricing page for the current disk price.
5. Add the environment variables above. Start with `DATA_DIR=/var/data`, `ADMIN_PASSWORD`, `RESEND_API_KEY`, and the Stripe test keys.
6. Create the service. Open the `onrender.com` address Render gives you and test everything there before touching DNS.

A service with a disk is down for a few seconds on every deploy. That is normal.

## 2. Resend (email)

1. Sign up at resend.com with the same email that receives alerts (`Cosmicvibezcreations@gmail.com`).
2. API Keys, then Create, with Sending access. Paste it straight into Render as `RESEND_API_KEY`. Never paste it into a chat.
3. Domains, then Add Domain, `cosmicvibezcreations.com`. Resend shows a few DNS records. Add them in Wix (section 4, step 6) and click Verify.
4. Until the domain is verified, Resend can only send to the account owner. Alerts still arrive. Customer confirmation emails do not.

## 3. Stripe (payment links)

1. Create or sign in to your Stripe account. Stay in test mode for now.
2. Developers, then API keys. Copy the secret key (`sk_test_...`) into Render as `STRIPE_SECRET_KEY`. A restricted key also works if it can write Products, Prices and Payment Links.
3. Developers, then Webhooks, then Add endpoint. URL: `https://YOUR-SERVICE.onrender.com/api/stripe/webhook` for now. Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Copy the endpoint's signing secret (`whsec_...`) into Render as `STRIPE_WEBHOOK_SECRET`.
5. Test: submit a quote on the site, open `/admin`, open the quote, enter an amount, and click Create Payment Link. Pay it with test card `4242 4242 4242 4242`, any future date, any CVC. The quote should flip to Paid and you should get a "Payment received" email.
6. Go live: switch Stripe to live mode, copy the live secret key into `STRIPE_SECRET_KEY`, create a new webhook endpoint in live mode with the final URL `https://cosmicvibezcreations.com/api/stripe/webhook`, and put its new signing secret into `STRIPE_WEBHOOK_SECRET`. Test keys and live keys do not mix.

## 4. Point the domain from Wix to Render

Pointing the domain at Render takes the Wix site offline. Do this last, after everything works on the `onrender.com` address.

1. In Render, open the service, then Settings, then Custom Domains. Add `cosmicvibezcreations.com` and `www.cosmicvibezcreations.com`. Render shows the records you need. Use the values Render shows.
2. In Wix, go to Domains, click the Domain Actions icon next to the domain, and pick Manage DNS Records.
3. A records: click Add Record in the A (Host) section. Leave Host Name blank (that means @). Value is the IP address Render shows. Save.
4. Delete the old A records that point to Wix (More Actions, then Delete). Leftover A records cause conflicts and certificate errors.
5. CNAME: click Add Record in the CNAME (Aliases) section. Host Name `www`. Value is the address Render shows (it looks like `YOUR-SERVICE.onrender.com`). Save. Delete the old `www` CNAME that points to Wix.
6. Add the DNS records Resend gave you (section 2). Add them exactly as shown.
7. Do not touch MX records for the main domain. If the business email runs through Google, Wix or anyone else, those records keep it working.
8. Back in Render, click Verify. When the certificate is issued, the site is live at `https://cosmicvibezcreations.com`. Wix says DNS changes can take up to 48 hours to reach everyone.
9. If the Wix DNS page does not show those records because the domain is connected by pointing or uses custom nameservers, make the same changes at the provider that manages the DNS.
10. Move the Stripe webhook to the real domain (section 3, step 6) once the domain works.

## 5. Day to day

- New quote: you get an email with Text, Email and Call buttons, plus a link to `/admin`.
- In `/admin`: set the status, add notes, download customer files, and create a payment link for a deposit or the full amount. The customer gets the link by email, or you can copy it and text it.
- Quotes and uploaded files live on the Render disk. Download anything you need to keep before using Delete All Finished.
- Rotating `ADMIN_PASSWORD` signs everyone out.
