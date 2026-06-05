// netlify/functions/stripe-webhook.js
// Handles three Stripe events:
//   checkout.session.completed  > create pub row + send welcome email
//   invoice.payment_succeeded   > mark plan as active (trial > paid)
//   customer.subscription.deleted > mark plan as inactive (access revoked)
//
// Register all three in your Stripe webhook dashboard.

const Stripe           = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function toSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

exports.handler = async (event) => {
  const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
  console.log('KEY defined:', !!process.env.SUPABASE_SERVICE_ROLE_KEY, '| length:', process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 'MISSING');
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Verify the request actually came from Stripe
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // ── 1. NEW SIGNUP ───────────────────────────────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;

    const pubName = session.custom_fields
      ?.find(f => f.key === 'pub_name')?.text?.value?.trim() || 'New Pub';
    const passkey = session.custom_fields
      ?.find(f => f.key === 'passkey')?.text?.value?.trim() || 'pool';
    const email   = session.customer_details?.email || '';

    const slug   = `${toSlug(pubName)}-${Math.floor(1000 + Math.random() * 9000)}`;
    const pubUrl = `https://whosonnext.uk/pubs/${slug}`;

    const { error: dbError } = await supabase.from('pubs').insert({
      slug,
      name:               pubName,
      passkey,
      email,
      stripe_customer_id: session.customer,
      plan:               'trial',
    });

    if (dbError) {
      console.error('Supabase insert failed:', dbError);
      return { statusCode: 500, body: 'Database error' };
    }

    console.log(`✓ Created pub: ${pubName} → ${pubUrl}`);

    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'WhosOnNext <welcome@whosonnext.uk>',
        to:      email,
        subject: `${pubName} is live on WhosOnNext 🎱`,
        html: `
          <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
            <h2 style="color:#D4A441;">You're on the board, ${pubName}!</h2>
            <p>Your WhosOnNext page is live:</p>
            <p style="margin:24px 0;">
              <a href="${pubUrl}" style="background:#D4A441;color:#0D0800;font-weight:700;
                padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">
                ${pubUrl}
              </a>
            </p>
            <p>Stick this on a QR code and put it on the pool table. Players scan it to join the queue.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p><strong>Admin passkey:</strong>
              <code style="background:#f4f4f4;padding:2px 8px;border-radius:4px;">${passkey}</code>
            </p>
            <p style="font-size:13px;color:#666;">Keep this safe — bar staff use it to manage the queue.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
            <p style="font-size:13px;color:#666;">Questions? Just reply to this email.<br>— The WhosOnNext team</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      console.warn('Welcome email failed:', await emailRes.text());
    }
  }

  // ── 2. TRIAL → PAID ─────────────────────────────────────────────────────────
  // Fires when the first real charge succeeds after the trial ends
  if (stripeEvent.type === 'invoice.payment_succeeded') {
    const invoice = stripeEvent.data.object;
    if (
      invoice.billing_reason === 'subscription_cycle' ||
      invoice.billing_reason === 'subscription_update'
    ) {
      await supabase.from('pubs')
        .update({ plan: 'active' })
        .eq('stripe_customer_id', invoice.customer);
      console.log(`✓ Plan → active for customer ${invoice.customer}`);
    }
  }

  // ── 3. SUBSCRIPTION ENDED ───────────────────────────────────────────────────
  // Fires when the billing period lapses after cancellation — not immediately on cancel.
  // This preserves access until the end of the period the pub already paid for.
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const sub = stripeEvent.data.object;
    await supabase.from('pubs')
      .update({ plan: 'inactive' })
      .eq('stripe_customer_id', sub.customer);
    console.log(`✓ Plan → inactive for customer ${sub.customer}`);
  }

  return { statusCode: 200, body: 'ok' };
};
