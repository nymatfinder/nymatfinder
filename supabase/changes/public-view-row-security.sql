ALTER POLICY "Public can view published tournaments" ON public.tournaments
TO anon, authenticated
USING (approval_status = 'approved' AND payment_status IN ('paid','complimentary') AND is_published = true);
GRANT SELECT (id,tournament_name,tournament_date,city,state,venue_name,street_address,zip_code,wrestling_style,age_division,skill_level,flyer_url,external_event_url,listing_package,approval_status,payment_status,is_published)
ON public.tournaments TO anon, authenticated;
ALTER VIEW public.public_tournaments SET (security_invoker = true);