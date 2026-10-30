# Lifeboat site update: home, pricing, sign in, vault

What changed:

- **Home page (`/`)** explains what Lifeboat does, with **Sign in** and **Get started** buttons.
- **Pricing page (`/pricing`)** shows the plans. You have to sign in before choosing one. Payments are not set up yet, so choosing a plan says "Payments open soon."
- **Vault page (`/vault`)** is where people land after signing in. It shows their storage ring, plan, and account, and previews where their folders will go. Uploading is not built yet, and the page says so.
- Logins run on Clerk. Plans are given out by username in `plans.json`.

## Files and where they go

Upload everything in this folder to your GitHub repo, at the top level next to `index.html`, except `api/account.js`:

| File | Where |
| --- | --- |
| `index.html`, `pricing.html`, `vault.html`, `account.html` | top level (replace the old ones) |
| `auth.js`, `site.css`, `plans.json`, `package.json`, `vercel.json` | top level |
| `api/account.js` | inside the `api` folder, next to `waitlist.js` |

To make `api/account.js`: Add file, Create new file, type `api/account.js` as the name, paste in the code, and commit. If you already made it earlier, open it, replace everything with the new code, and commit.

Keep `api/waitlist.js` as it is, since the waitlist form on the home page still uses it.

## Put your Clerk key in one place

Open `auth.js` and find the line near the top:

`var PUBLISHABLE_KEY = 'PASTE_YOUR_CLERK_PUBLISHABLE_KEY_HERE';`

Replace the placeholder with your Clerk publishable key (starts with `pk_test_`), keeping the quotes. Every page uses this one key. You don't need to put a key in any other file.

Your secret key (`sk_test_...`) stays in Vercel only, as `CLERK_SECRET_KEY` under Settings, Environment Variables.

## Tell Clerk where to send people after sign-in

In the Clerk dashboard, open Configure, then Paths (also called Application paths). Set the Home URL and the after sign-in and after sign-up URLs to:

`https://YOUR-DOMAIN.com/vault`

## Redeploy and test

1. In Vercel, open Deployments and Redeploy.
2. Open your home page. You should see Pricing, Sign in, and Get started at the top.
3. Click Get started, create an account, and check you land on `/vault`.
4. Open `/pricing`. Your plan should say "Your plan." Log out and check that choosing a plan asks you to sign in.
5. Open `/account`. It should send you to `/vault`.

## Giving someone a plan

Open `plans.json` on GitHub, click the pencil icon, and add the username under `assignments`:

```
"assignments": {
  "jaxon": "personal",
  "kai": "family"
}
```

- Usernames are lowercase.
- Plan names are `free`, `personal`, `family`, or `creator`. Anyone not listed is on `free`.
- Every line except the last ends with a comma, and the quotation marks stay. A missing comma breaks the file.
- Click Commit changes. Vercel updates in about a minute.
- You can change storage amounts or add plans in the `plans` part of the same file.

This file decides which plan the vault and pricing pages show. It does not charge anyone. Storage limits get enforced when we build uploads, and Stripe will set paid plans later.

## Not built yet

- Uploading, folders, and restoring files (the vault page is a preview)
- Payments (the pricing page says "Payments open soon")
- Authenticator app and backup codes, which need Clerk's Pro plan

## Before real customers

- Switch from Clerk's test keys to a production setup, with your domain's DNS records in Spaceship and your own Google login keys. Clerk shows you each step.
- Add a privacy policy and terms of service.
