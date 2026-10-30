// Vercel serverless function: POST /api/waitlist
// 1. Emails you the new signup (this is your record of it).
// 2. Emails the visitor "You are on the waitlist!".
//
// Needs three environment variables (set them in Vercel, see README.md):
//   RESEND_API_KEY  your Resend API key
//   FROM_EMAIL      e.g.  Lifeboat <hello@yourdomain.com>   (a domain verified in Resend)
//   NOTIFY_EMAIL    the inbox where you want to receive signups

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendEmail(apiKey, payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.ok;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Use POST.' });
  }

  const { RESEND_API_KEY, FROM_EMAIL, NOTIFY_EMAIL } = process.env;
  if (!RESEND_API_KEY || !FROM_EMAIL || !NOTIFY_EMAIL) {
    return res.status(500).json({ ok: false, error: 'Signups are not set up yet.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Hidden field that real visitors never fill in. Bots do. Pretend it worked.
  if (body.company) return res.status(200).json({ ok: true, confirmed: false });

  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
  }

  try {
    // 1. Your notification. If this fails, the signup is not recorded, so report an error.
    const recorded = await sendEmail(RESEND_API_KEY, {
      from: FROM_EMAIL,
      to: [NOTIFY_EMAIL],
      reply_to: email,
      subject: 'New Lifeboat waitlist signup',
      text: 'New waitlist signup: ' + email,
      html: '<p>New waitlist signup:</p><p><strong>' + escapeHtml(email) + '</strong></p>',
    });
    if (!recorded) {
      return res.status(502).json({ ok: false, error: 'Could not save your signup. Try again in a minute.' });
    }

    // 2. The visitor's confirmation. Best effort: the signup already counts.
    const confirmed = await sendEmail(RESEND_API_KEY, {
      from: FROM_EMAIL,
      to: [email],
      subject: 'You are on the waitlist!',
      text:
        'You are on the Lifeboat waitlist!\n\n' +
        "We'll email you the moment early access opens.\n\n" +
        'If you did not sign up, you can ignore this email.\n\nThe Lifeboat team',
      html:
        '<div style="font-family:Arial,sans-serif;max-width:480px;color:#0A3340">' +
        '<h2 style="margin:0 0 12px">You are on the waitlist!</h2>' +
        '<p>Thanks for joining Lifeboat. We will email you the moment early access opens.</p>' +
        '<p style="color:#4A6B74;font-size:14px">If you did not sign up, you can ignore this email.</p>' +
        '</div>',
    });

    return res.status(200).json({ ok: true, confirmed });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Something went wrong. Try again in a minute.' });
  }
};
