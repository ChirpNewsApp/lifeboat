# Turning on file storage (Backblaze B2)

Each person gets a private area in one Backblaze bucket. Files go from their browser straight to Backblaze. Your plan limits (1 GB, 100 GB, 1 TB, +250 GB) are enforced by the server.

## 1. Upload to GitHub (one commit if you can)
| File | Where |
| --- | --- |
| `api/files.js` | inside `api` (new) |
| `api/account.js` | inside `api` (replace) |
| `package.json` | top level (replace, it adds the storage libraries) |
| `vault.html` | top level (replace) |
| `auth.js` | top level (use `ready/auth.js`, it has your Clerk key) |

## 2. Make a Backblaze account and bucket
1. Sign up at backblaze.com (B2 Cloud Storage). It asks for an email and a card. The first 10 GB are free.
2. Buckets, **Create a Bucket**. Name it something unique like `lifeboat-vault-yourname`. Set **Files in Bucket are: Private**. Turn on **Default Encryption**.
3. Open the bucket's **Lifecycle Settings** and choose **Keep only the last version of the file**. Without this, deleted files are kept as hidden old versions and still cost money.
4. Note the bucket's **Endpoint** (shown on the bucket page, like `s3.us-west-004.backblazeb2.com`).

## 3. Application key
App Keys, **Add a New Application Key**. Name it `lifeboat`, allow access to **only your bucket**, type **Read and Write**. Copy the **keyID** and the **applicationKey** straight away. The key is shown once. Never put it on GitHub or in chat.

## 4. Let your website upload (CORS)
Open the bucket, **CORS Rules**, and choose **Share everything in this bucket with this one origin**. Enter `https://www.lifeboatrecovery.com`, save, and add the version without `www` if you use it. Without this, uploads fail in the browser.

## 5. Vercel variables
Settings, Environment Variables. Add:
- `B2_KEY_ID` = the keyID
- `B2_APP_KEY` = the applicationKey (secret)
- `B2_BUCKET` = the bucket name
- `B2_ENDPOINT` = `https://` + the endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`

`CLERK_SECRET_KEY` and `STRIPE_SECRET_KEY` stay as they are. Commit the files after you set the variables and Vercel deploys with them.

## 6. Test
Open `/vault` and sign in. Press Upload files, pick a small file, and it should appear in the list with the storage ring moving. Make a folder, open it, upload inside it, download a file, delete one.

## What to know
- One file can be up to 4 GB. Uploads fail with a clear message when the plan is full.
- Files are protected by Backblaze's server-side encryption and are only reachable through short-lived signed links for the signed-in owner. They are not end-to-end encrypted yet, so Backblaze could technically read them.
- Storage cost is about $6.95 per TB per month at Backblaze (check their current price).
