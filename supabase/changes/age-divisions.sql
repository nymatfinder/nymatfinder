ALTER TABLE public.tournament_submissions
ADD COLUMN age_divisions text[] NULL
CONSTRAINT tournament_submissions_age_divisions_check CHECK (
  age_divisions IS NULL OR (
    cardinality(age_divisions) BETWEEN 1 AND 3
    AND array_position(age_divisions, NULL) IS NULL
    AND age_divisions <@ ARRAY['Youth', 'Modified', 'High School']::text[]
  )
);