# Payments with Stripe

## 1. Upload to GitHub
| File | Where |
| --- | --- |
| `api/account.js` | inside `api` (replace the old one) |
| `stripe-prices.json` | top level |
| `pricing.html`, `vault.html`, `index.html`, `auth.js` | top level (auth.js: use `ready/auth.js`, it has your Clerk key) |

Delete `paypal-plans.json` and `lemon-variants.json` if they are on GitHub.

## 2. Stripe: key and products
1. Use a **regular Stripe account** with API keys (Developers, API keys shows a Secret key). A WooPayments account will not work.
2. Practice first: switch to **Sandbox/Test mode** if your Stripe offers it (account name at top left, Sandboxes). It gives a `sk_test_` key and needs no live checks.
3. Product catalog, make three **monthly recurring** products: Personal $12, Family $22.50, Creator add-on $7.50.
4. Copy each **Price ID** (starts with `price_`, not `prod_`) into `stripe-prices.json` on GitHub.

## 3. Vercel
Settings, Environment Variables: `STRIPE_SECRET_KEY` (the `sk_` key, never in GitHub or chat) and `CLERK_SECRET_KEY`. Remove any PayPal or Lemon Squeezy variables.

## 4. Billing page
Stripe, Settings, Billing, Customer portal: turn on. Allow cancelling and plan switching.

## 5. Redeploy and test
Redeploy in Vercel. Sign in with an account that is not `jaxon`, open `/pricing`, click Choose Personal. In test mode pay with `4242 4242 4242 4242`, any future date, any CVC.

## Before real money
Use live products, live Price IDs and the `sk_live_` key. Roll any key that was ever posted in chat. Upgrade Vercel to Pro.
