import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://nymatfinder.com",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
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
    const form = await req.formData();

    const token = String(form.get("turnstile_token") || "");
    const secret = Deno.env.get("TURNSTILE_SECRET_KEY");

    if (!token || !secret) {
      return respond({ error: "Security verification required" }, 400);
    }

    const verification = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret,
          response: token,
        }),
      }
    );

    if (!verification.ok) {
      return respond({ error: "Security verification unavailable" }, 503);
    }

    const result = await verification.json();

   if (
  !result.success ||
  result.hostname !== "nymatfinder.com"
) {
  return respond({ error: "Security verification failed" }, 403);
}
    const tournament_name = String(form.get("tournament_name") || "").trim();
const tournament_date = String(form.get("tournament_date") || "");
    const city = String(form.get("city") || "").trim();
const venue_name = String(form.get("venue_name") || "").trim();
const street_address = String(form.get("street_address") || "").trim();
const state = String(form.get("state") || "");
const contact_email = String(form.get("contact_email") || "").trim();
    const listing_package = String(form.get("listing_package") || "");
    const wrestling_style = String(form.get("wrestling_style") || "");
    const additional_details = String(form.get("additional_details") || "").trim();

    const allowedDivisions = ["Youth", "Modified", "High School"];
    const rawDivisions = form.get("age_divisions");
    let age_divisions: string[] | null = null;
    if (rawDivisions !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(String(rawDivisions)); }
      catch { return respond({ error: "Invalid age divisions" }, 400); }
      if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3 ||
          parsed.some(value => typeof value !== "string" || !allowedDivisions.includes(value))) {
        return respond({ error: "Select at least one valid age division" }, 400);
      }
      age_divisions = allowedDivisions.filter(value => parsed.includes(value));
    }

    if (
      !tournament_name ||
      !/^\d{4}-\d{2}-\d{2}$/.test(tournament_date) ||
      Number.isNaN(Date.parse(tournament_date)) ||
      !city ||
!venue_name ||
!street_address ||
      !["NY", "PA", "NJ"].includes(state) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email) ||
      !["Basic", "Featured"].includes(listing_package) ||
      !["Folkstyle", "Freestyle", "Greco-Roman"].includes(wrestling_style)
    ) {
      return respond({ error: "Invalid tournament details" }, 400);
    }

    if (
      tournament_name.length > 200 ||
      city.length > 150 ||
venue_name.length > 200 ||
street_address.length > 300 ||
      contact_email.length > 254 ||
      additional_details.length > 5000
    ) {
      return respond({ error: "Submission exceeds allowed length" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let flyer_url: string | null = null;
    let uploadedPath: string | null = null;

    const flyer = form.get("flyer");

    if (flyer instanceof File && flyer.size > 0) {
      const allowedTypes: Record<string, string> = {
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
      };

      if (
        flyer.size > 10 * 1024 * 1024 ||
        !allowedTypes[flyer.type]
      ) {
        return respond({
          error: "Flyer must be PDF, JPG, or PNG and under 10 MB",
        }, 400);
      }

      const bytes = new Uint8Array(await flyer.arrayBuffer());

      const isPDF =
        bytes[0] === 0x25 && bytes[1] === 0x50 &&
        bytes[2] === 0x44 && bytes[3] === 0x46;

      const isJPG =
        bytes[0] === 0xff && bytes[1] === 0xd8 &&
        bytes[2] === 0xff;

      const isPNG =
        bytes[0] === 0x89 && bytes[1] === 0x50 &&
        bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a &&
        bytes[6] === 0x1a && bytes[7] === 0x0a;

      if (
        (flyer.type === "application/pdf" && !isPDF) ||
        (flyer.type === "image/jpeg" && !isJPG) ||
        (flyer.type === "image/png" && !isPNG)
      ) {
        return respond({ error: "Invalid flyer file" }, 400);
      }

      uploadedPath =
        `${crypto.randomUUID()}.${allowedTypes[flyer.type]}`;

      const { error: uploadError } = await supabase.storage
        .from("tournament-flyers")
        .upload(uploadedPath, bytes, {
          contentType: flyer.type,
          upsert: false,
        });

      if (uploadError) {
        console.error("Flyer upload failed:", uploadError);
        return respond({ error: "Unable to upload flyer" }, 500);
      }

      const { data } = supabase.storage
        .from("tournament-flyers")
        .getPublicUrl(uploadedPath);

      flyer_url = data.publicUrl;
    }

    const { data: savedSubmission, error: submissionError } = await supabase
      .from("tournament_submissions")
      .insert({
        tournament_name,
        tournament_date,
                city,
        venue_name,
        street_address,
        state,
        contact_email,
        listing_package,
        wrestling_style,
        additional_details,
        age_divisions,
        flyer_url,
      })
      .select("id")
      .single();

    if (submissionError) {
      console.error("Submission failed:", submissionError);

      if (uploadedPath) {
        await supabase.storage
          .from("tournament-flyers")
          .remove([uploadedPath]);
      }

      return respond({ error: "Unable to save tournament" }, 500);
    }

    // Save the submission first: email failures must never lose the event.
    let notificationSent = false;
    try {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (!resendKey || !savedSubmission?.id) {
        console.error("Submission notification unavailable: missing email configuration or submission ID");
      } else {
        const notification = await fetch("https://api.resend.com/emails", {
          method: "POST",
          signal: AbortSignal.timeout(10000),
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `nymatfinder-submission-${savedSubmission.id}`,
          },
          body: JSON.stringify({
            from: "NYmatfinder <payments@nymatfinder.com>",
            to: ["nymatfinder@gmail.com"],
            subject: `New tournament awaiting approval: ${tournament_name}`,
            text:
              `A tournament has been submitted and is awaiting your review.\n\n` +
              `Submission ID: ${savedSubmission.id}\n` +
              `Tournament: ${tournament_name}\n` +
              `Date: ${tournament_date}\n` +
              `Location: ${city}, ${state}\n` +
              `Venue: ${venue_name}\n` +
              `Street address: ${street_address}\n` +
              `Age divisions: ${age_divisions?.join(", ") || "Not specified"}\n` +
              `Style: ${wrestling_style}\n` +
              `Package: ${listing_package}\n` +
              `Director email: ${contact_email}\n` +
              `Flyer: ${flyer_url || "Not provided"}\n\n` +
              `Additional details:\n${additional_details || "None provided"}\n\n` +
              `Review in the admin dashboard:\nhttps://nymatfinder.com/admin.html\n\n` +
              `No payment is requested until you approve the submission.\n\nNYmatfinder`,
          }),
        });
        notificationSent = notification.ok;
        if (!notification.ok) console.error("Submission notification failed:", notification.status);
      }
    } catch {
      console.error("Submission saved, but notification email could not be sent");
    }

    return respond({
      success: true,
      notification_sent: notificationSent,
      message: "Tournament submitted for approval",
    });
  } catch (error) {
    console.error("Request failed:", error);
    return respond({ error: "Unable to process submission" }, 500);
  }
});