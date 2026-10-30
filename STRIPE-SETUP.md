# Adding Stripe (test mode first)

## 1. Upload these files to GitHub
Replace the old ones. Use `ready/auth.js` (it already has your Clerk key).

| File | Where |
| --- | --- |
| `pricing.html`, `vault.html`, `auth.js`, `stripe-prices.json` | top level |
| `api/account.js` | inside `api` (replace the old one) |

## 2. Make the 3 products in Stripe
Turn on **Test mode** (top right of the Stripe dashboard). Product catalog, Add product, three times:

| Name | Price | Billing |
| --- | --- | --- |
| Lifeboat Personal | $12.00 | Recurring, monthly |
| Lifeboat Family | $22.50 | Recurring, monthly |
| Lifeboat Creator add-on | $7.50 | Recurring, monthly |

Open each product and copy its **Price ID** (starts with `price_`). It is safe to put in GitHub.

## 3. Paste the Price IDs
Edit `stripe-prices.json` on GitHub and replace the three PASTE lines with your IDs. Keep the quotes and commas.

## 4. Add the secret key in Vercel
Stripe, Developers, API keys: copy the **Secret key** (`sk_test_...`).
Vercel, your project, Settings, Environment Variables: add `STRIPE_SECRET_KEY` with that value. Make sure `CLERK_SECRET_KEY` is there too. Never paste a secret key into GitHub or chat.

## 5. Turn on the billing page
Stripe, Settings, Billing, Customer portal: turn it on. Allow customers to cancel and update payment methods. Under subscriptions, allow switching plans and add your Personal and Family products.

## 6. Redeploy and test
Vercel, Deployments, Redeploy. Then sign in, open `/pricing`, click Choose Personal, and pay with test card `4242 4242 4242 4242`, any future date, any CVC. You should land on `/vault` with a thank-you banner and your plan shown. "Manage billing" opens Stripe's page.

Plans you give by hand in `plans.json` always win over Stripe.

## Before real money
Switch Stripe out of test mode (new live Price IDs and `sk_live_` key), and upgrade Vercel to Pro, since Hobby is non-commercial.
