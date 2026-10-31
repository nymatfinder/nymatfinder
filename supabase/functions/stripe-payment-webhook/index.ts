
const corsHeaders = {
  "Content-Type": "application/json",
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders,
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  webhookSecret: string
): Promise<boolean> {
  const parts = signatureHeader.split(",");

  const timestamp = parts
    .find((part) => part.startsWith("t="))
    ?.substring(2);

  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.substring(3));

  if (!timestamp || !signatures.length) return false;

  const timestampNumber = Number(timestamp);

  if (
    !Number.isSafeInteger(timestampNumber) ||
    Math.abs(Date.now() / 1000 - timestampNumber) > 300
  ) {
    return false;
  }

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`)
  );

  const expected = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((candidate) =>
    constantTimeEqual(candidate, expected)
  );
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  try {
    const stripeSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!stripeSecret || !supabaseUrl || !serviceKey) {
      return respond({ error: "Server configuration incomplete" }, 500);
    }

    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      return respond({ error: "Missing Stripe signature" }, 400);
    }

    const payload = await req.text();

    const validSignature = await verifyStripeSignature(
      payload,
      signature,
      stripeSecret
    );

    if (!validSignature) {
      return respond({ error: "Invalid Stripe signature" }, 400);
    }

    const event = JSON.parse(payload);

    if (
      event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded"
    ) {
      return respond({ received: true, ignored: true });
    }

    const session = event.data?.object;

    if (
      !session ||
      session.mode !== "payment" ||
      session.payment_status !== "paid"
    ) {
      return respond({
        received: true,
        ignored: true,
        reason: "Payment not completed",
      });
    }

    const submissionId = Number(session.metadata?.submission_id);

    if (
      !Number.isSafeInteger(submissionId) ||
      submissionId <= 0 ||
      session.client_reference_id !== String(submissionId)
    ) {
      return respond({ error: "Invalid submission reference" }, 400);
    }

    if (!session.id || !session.amount_total || session.amount_total <= 0) {
      return respond({ error: "Invalid payment session" }, 400);
    }

    const { createClient } = await import(
      "npm:@supabase/supabase-js@2"
    );

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const { data: submission, error: submissionError } =
  await adminClient
    .from("tournament_submissions")
    .select(
      "id, tournament_name, tournament_date, city, venue_name, street_address, state, contact_email, listing_package, wrestling_style, age_divisions, flyer_url, submission_status, payment_status, stripe_checkout_session_id"
    )
    .eq("id", submissionId)
    .single();
    if (submissionError || !submission) {
      return respond({ error: "Submission not found" }, 500);
    }

    if (submission.submission_status !== "approved") {
      return respond({ error: "Submission is not approved" }, 409);
    }

    if (submission.stripe_checkout_session_id !== session.id) {
      return respond({ error: "Checkout session mismatch" }, 400);
    }

    if (
      !submission.tournament_name ||
      !submission.tournament_date ||
      !submission.city ||
      !submission.state ||
      !submission.contact_email ||
      !submission.listing_package ||
      !submission.wrestling_style
    ) {
      return respond({ error: "Required tournament information missing" }, 500);
    }
     const expectedAmount =
      submission.listing_package === "Basic"
        ? 1000
        : submission.listing_package === "Featured"
        ? 2000
        : null;

    if (
      expectedAmount === null ||
      session.amount_total !== expectedAmount ||
      session.currency !== "usd"
    ) {
      return respond(
        { error: "Payment amount or currency does not match listing package" },
        400
      );
    }

    if (session.livemode !== true) {
  return respond(
    { error: "Sandbox payments are not accepted" },
    400
  );
}
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null;

    const { data: paymentUpdated, error: paymentUpdateError } =
      await adminClient
        .from("tournament_submissions")
        .update({
          payment_status: "paid",
          stripe_payment_intent_id: paymentIntentId,
        })
        .eq("id", submission.id)
        .eq("stripe_checkout_session_id", session.id)
        .eq("payment_status", "unpaid")
        .select("id")
        .maybeSingle();


    if (paymentUpdateError) {
  console.error("Payment status update failed:", paymentUpdateError);
  return respond({ error: "Unable to update payment status" }, 500);
}

if (!paymentUpdated) {
  const { data: alreadyPaid, error: paidCheckError } = await adminClient
    .from("tournament_submissions")
    .select("id, payment_status, stripe_payment_intent_id")
    .eq("id", submission.id)
    .eq("stripe_checkout_session_id", session.id)
    .maybeSingle();

  if (
    paidCheckError ||
    !alreadyPaid ||
    alreadyPaid.payment_status !== "paid"
  ) {
    return respond({ error: "Unable to confirm payment status" }, 500);
  }
}
    const { error: tournamentError } = await adminClient
      .from("tournaments")
      .upsert(
        {
          submission_id: submission.id,
          tournament_name: submission.tournament_name,
          tournament_date: submission.tournament_date,
          city: submission.city,
          state: submission.state,
          venue_name: submission.venue_name,
          street_address: submission.street_address,
          zip_code: null,
          wrestling_style: submission.wrestling_style,
          age_division: submission.age_divisions?.length
            ? submission.age_divisions.join(", ")
            : "Not specified",
          skill_level: "Not specified",
          flyer_url: submission.flyer_url,
          external_event_url: null,
          listing_package: submission.listing_package,
          director_email: submission.contact_email,
          director_name: "Tournament Director",
          approval_status: "approved",
          payment_status: "paid",
          is_published: true,
        },
        { onConflict: "submission_id" }
      );

    if (tournamentError) {
      console.error("Tournament publishing failed:", tournamentError);
      return respond({ error: "Unable to publish tournament" }, 500);
    }

    return respond({
      received: true,
      payment_status: "paid",
      tournament_published: true,
      submission_id: submission.id,
    });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return respond({ error: "Unable to process Stripe webhook" }, 500);
  }
});
