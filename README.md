# Lifeboat site

A landing page plus a small signup tool. When someone joins the waitlist:

1. You get an email with their address.
2. They get an email that says "You are on the waitlist!"

Files:

- `index.html`: the page
- `api/waitlist.js`: the signup tool (runs on Vercel, no setup beyond the steps below)
- `package.json`: lets Vercel recognize the project

## Setup (about 15 minutes)

### 1. Get a Resend account (free)

1. Sign up at resend.com. The free plan allows 3,000 emails a month and 100 a day.
2. Go to Domains, click Add Domain, and enter your domain.
3. Resend shows a few DNS records (usually 2 to 3 TXT and MX records). In Spaceship, open
   Domain List, click Manage on your domain, go to DNS, and add each record exactly as shown.
4. Back in Resend, click Verify. This can take a few minutes up to a few hours.
5. Go to API Keys, create a key, and copy it. You only see it once.

The domain check matters: until it is verified, Resend only lets you send test emails to
yourself, and visitors would not get confirmations.

### 2. Put the files on GitHub

1. Create a new repository on github.com.
2. Upload everything in this folder, keeping the `api` folder as it is.

### 3. Deploy on Vercel

1. At vercel.com, click Add New, then Project, pick your repo, and click Deploy.
2. Open the project, then Settings, then Environment Variables. Add these three:

| Name | Value |
| --- | --- |
| `RESEND_API_KEY` | the key from step 1 |
| `FROM_EMAIL` | `Lifeboat <hello@yourdomain.com>` (any address on your verified domain) |
| `NOTIFY_EMAIL` | the inbox where you want to receive signups |

3. Go to Deployments, open the latest one, and choose Redeploy so the variables take effect.

### 4. Point your domain at the site

Follow the Vercel domain steps: Settings, then Domains, add your domain, and enter the A and
CNAME records Vercel shows into Spaceship's DNS section.

### 5. Test it

Open your live site, sign up with a second email address you own, and check that:

- you receive the "New Lifeboat waitlist signup" email
- the second address receives "You are on the waitlist!" (check spam the first time)

## Notes

- The tool must run on Vercel. Opening `index.html` from your computer will show an error
  when you submit, because `/api/waitlist` only exists once deployed.
- Signups live in your notification emails. When the list grows, ask Claude to add a
  spreadsheet or database so you can export it.
- A hidden field catches basic bots. For heavier spam, add a CAPTCHA later.
- To change the confirmation email, edit the `subject`, `text`, and `html` in the second
  `sendEmail` call in `api/waitlist.js`.
