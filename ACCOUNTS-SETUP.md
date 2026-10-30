# Lifeboat accounts with Clerk: setup guide

Clerk runs the logins, so people can create an account with a username, email and password, or with Google. New email accounts get a 6-digit code to verify. Forgot-password is built in.

This adds:

- `account.html`: the account page (log in, create account, see your plan, log out)
- `api/account.js`: tells the page which plan the person has
- `plans.json`: where you give out plans by username
- `package.json`: tells Vercel to install Clerk's helper code

Time: about 25 minutes.

## 1. Create your Clerk app

1. Sign up at clerk.com (free).
2. Click Create application. Name it `Lifeboat`.
3. Under sign-in options, turn on **Email**, **Username**, and **Google**. Then click Create application.

## 2. Check the sign-up settings

In the Clerk dashboard, open Configure, then User & authentication (the page for email, phone, and username).

1. **Email address:** on, required, and set to verify with an **email verification code**.
2. **Username:** on and required. This makes Google sign-ups pick a username too, which is what your plans match on.
3. **Password:** on.
4. Save.

Then open Configure, then Paths (also called Application paths), and set the Home URL and the after sign-in and after sign-up URLs to `https://YOUR-DOMAIN.com/account.html`.

## 3. Copy your keys

Open the API keys page in Clerk. You'll see two keys:

- **Publishable key** (starts with `pk_`): safe to put in the page.
- **Secret key** (starts with `sk_`): SECRET. It only goes into Vercel.

## 4. Put the keys in place

1. Open `account.html` in Notepad or TextEdit and find this line near the bottom:
   `var PUBLISHABLE_KEY = 'PASTE_YOUR_CLERK_PUBLISHABLE_KEY_HERE';`
   Replace the placeholder text with your publishable key, keeping the quotes.
2. In Vercel, open your project, then Settings, then Environment Variables, and add:

| Key | Value |
| --- | --- |
| `CLERK_SECRET_KEY` | your Clerk secret key |

## 5. Upload to GitHub

1. Add file, then Upload files: `account.html`, `plans.json`, and `package.json`. If GitHub says package.json already exists, upload it anyway so it replaces the old one.
2. Add file, then Create new file. Type `api/account.js` as the file name, paste in the contents of `api/account.js`, and commit.
3. In Vercel, open Deployments and Redeploy so the new settings take effect.

## 6. Test it

1. Open `https://YOUR-DOMAIN.com/account.html`.
2. Click Create account, make an account (the page will send you to Clerk's sign-up page), and check you get a 6-digit code by email.
3. You should land back on your account page, showing your username, email, and Free plan.
4. Log out, then log in again. Then try Google.
5. Try Forgot password on the login page.

## Giving someone a plan

Open `plans.json` on GitHub, click the pencil icon, and add the username under `assignments`. For example:

```
"assignments": {
  "jaxon": "personal",
  "kai": "family"
}
```

- Write usernames in lowercase.
- Plan names are `free`, `personal`, `family`, or `creator`. Anyone not listed, or with a misspelled plan, is on `free`.
- Every line except the last ends with a comma, and all the quotation marks stay. A missing comma breaks the file.
- Click Commit changes. Vercel updates the site in about a minute, and the person's account page shows their plan.
- You can change the storage amounts or add plans in the `plans` part of the same file.

This file only decides what plan the account page shows. Storage limits get enforced when we build the vault, and paid plans from Stripe will set plans automatically later. You can keep using the file to give plans for free.

## What's not included yet

- **Authenticator app and backup codes:** Clerk's free plan doesn't include multi-factor login. It comes with their Pro plan, $25 a month ($20 if billed yearly). Check Clerk's pricing page before you upgrade, and confirm backup codes are included. When you upgrade, you turn it on in the Clerk dashboard under multi-factor authentication, and your account page's "Manage account and security" button will show it. No new code is needed.

## Before real customers

- The keys you're using are **development** keys, meant for testing, and they show a "development mode" banner. For a live site, create a **production** instance in Clerk. It will ask you to add a few DNS records for your domain in Spaceship, and it will ask you to set up your own Google login keys in Google Cloud. Clerk shows you each step.
- Add a privacy policy and terms of service.
- The secret key must never go on GitHub or into the page.
