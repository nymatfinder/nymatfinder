import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://nymatfinder.com",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return respond({ error: "Authentication required" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey =
      Deno.env.get("SUPABASE_ANON_KEY") ??
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey || !stripeKey) {
      return respond({ error: "Server configuration incomplete" }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
      auth: { persistSession: false },
    });

    const token = authHeader.substring(7);

    const { data: userData, error: userError } =
      await userClient.auth.getUser(token);

    if (userError || !userData.user) {
      return respond({ error: "Invalid login" }, 401);
    }

    const { data: isAdmin, error: adminError } =
      await userClient.rpc("is_nymatfinder_admin");

    if (adminError || isAdmin !== true) {
      return respond({ error: "Administrator access required" }, 403);
    }

    const { submission_id } = await req.json();

    if (
  !Number.isSafeInteger(submission_id) ||
  submission_id <= 0
) {
  return respond({ error: "Invalid submission ID" }, 400);
}
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const { data: submission, error: submissionError } =
      await adminClient
        .from("tournament_submissions")
        .select(
          "id, tournament_name, contact_email, listing_package, submission_status, payment_status, stripe_checkout_session_id"
        )
        .eq("id", submission_id)
        .single();

    if (submissionError) {
  console.error("Submission lookup failed:", submissionError);
  return respond({ error: "Database lookup failed" }, 500);
}

if (!submission) {
  return respond({ error: "Submission not found" }, 404);
}

    if (submission.submission_status !== "approved") {
      return respond({ error: "Tournament is not approved" }, 400);
    }

    if (submission.payment_status !== "unpaid") {
      return respond({ error: "Tournament is not unpaid" }, 400);
    }

    const previousSessionId = submission.stripe_checkout_session_id;
    if (previousSessionId) {
  const existingResponse = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(submission.stripe_checkout_session_id)}`,
    {
      headers: {
        Authorization: `Bearer ${stripeKey}`,
      },
    }
  );

  const existingSession = await existingResponse.json();

  if (!existingResponse.ok) {
    return respond(
      { error: "Unable to retrieve existing payment session" },
      502
    );
  }

  // Only expired sessions may be replaced. Completed sessions stay protected.
  if (existingSession.status !== "expired") {
  if (existingSession.status !== "open" || !existingSession.url) {
    return respond(
      { error: "Existing payment link has expired or is no longer available" },
      409
    );
  }

  const resendKey = Deno.env.get("RESEND_API_KEY");

  if (!resendKey) {
    return respond({ error: "Email service not configured" }, 500);
  }

  const emailResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "NYmatfinder <payments@nymatfinder.com>",
      to: [submission.contact_email],
      subject: `Payment Link: ${submission.tournament_name}`,
      text:
        `Your tournament "${submission.tournament_name}" has been approved!\n\n` +
        `Listing package: ${submission.listing_package}\n` +
        `Amount due: $${submission.listing_package === "Featured" ? "20" : "10"}.00\n\n` +
        `Complete your payment using this secure Stripe link:\n${existingSession.url}\n\n` +
        `Your tournament will be published after payment is confirmed.\n\n` +
        `NYmatfinder`,
    }),
  });

  if (!emailResponse.ok) {
    console.error("Resend email failed:", emailResponse.status);
    return respond(
      { error: "Unable to email existing payment link" },
      502
    );
  }

  const { error: emailUpdateError } = await adminClient
    .from("tournament_submissions")
    .update({ payment_email_sent_at: new Date().toISOString() })
    .eq("id", submission.id);

  if (emailUpdateError) {
    console.error("Unable to record payment email timestamp:", emailUpdateError);
  }

  return respond({
    message: "Payment link emailed successfully",
    submission_id: submission.id,
  });
}

  }

    const priceId =
      submission.listing_package === "Basic"
        ? Deno.env.get("STRIPE_BASIC_PRICE_ID")
        : submission.listing_package === "Featured"
        ? Deno.env.get("STRIPE_FEATURED_PRICE_ID")
        : null;

    if (!priceId) {
      return respond({ error: "Invalid listing package configuration" }, 500);
    }

    const params = new URLSearchParams();

    params.set("mode", "payment");
    params.set("line_items[0][price]", priceId);
    params.set("line_items[0][quantity]", "1");
    params.set("customer_email", submission.contact_email);
    params.set(
      "success_url",
      "https://nymatfinder.com/?payment=success"
    );
    params.set(
      "cancel_url",
      "https://nymatfinder.com/?payment=cancelled"
    );
    params.set("client_reference_id", submission.id);
    params.set("metadata[submission_id]", submission.id);

    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": previousSessionId
            ? `nymatfinder-checkout-${submission.id}-after-${previousSessionId}`
            : `nymatfinder-checkout-${submission.id}`,
        },
        body: params.toString(),
      }
    );

    const session = await stripeResponse.json();

    if (!stripeResponse.ok || !session.id || !session.url) {
      return respond(
        { error: "Unable to create Stripe Checkout session" },
        502
      );
    }

    const reservation = adminClient
      .from("tournament_submissions")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", submission.id)
      .eq("submission_status", "approved")
      .eq("payment_status", "unpaid");

    const { data: updated, error: updateError } = await (previousSessionId
      ? reservation.eq("stripe_checkout_session_id", previousSessionId)
      : reservation.is("stripe_checkout_session_id", null))
      .select("id")
      .maybeSingle();

    if (updateError || !updated) {
      return respond(
        { error: "Unable to reserve checkout session" },
        409
      );
    }

  const resendKey = Deno.env.get("RESEND_API_KEY");

    if (!resendKey) {
      return respond({ error: "Email service not configured" }, 500);
    }

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "NYmatfinder <payments@nymatfinder.com>",
        to: [submission.contact_email],
        subject: `Payment Link: ${submission.tournament_name}`,
        text:
          `Your tournament "${submission.tournament_name}" has been approved!\n\n` +
          `Listing package: ${submission.listing_package}\n` +
          `Amount due: $${submission.listing_package === "Featured" ? "20" : "10"}.00\n\n` +
          `Complete your payment using this secure Stripe link:\n${session.url}\n\n` +
          `Your tournament will be published after payment is confirmed.\n\n` +
          `NYmatfinder`,
      }),
    });

    if (!emailResponse.ok) {
      console.error("Resend email failed:", emailResponse.status);
      return respond({ error: "Payment link created, but email delivery failed" }, 502);
    }

    const { error: emailUpdateError } = await adminClient
      .from("tournament_submissions")
      .update({ payment_email_sent_at: new Date().toISOString() })
      .eq("id", submission.id);

    if (emailUpdateError) {
      console.error("Unable to record payment email timestamp:", emailUpdateError);
    }

    return respond({
      message: "Payment link emailed successfully",
      submission_id: submission.id,
    });
  } catch {
    return respond({ error: "Unable to process checkout request" }, 500);
  }
});