-- Extensions required by the schema (trigram indexes for fuzzy title search).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- array_to_string() is only STABLE, so generated columns need an IMMUTABLE wrapper.
CREATE OR REPLACE FUNCTION pw_array_to_text(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT array_to_string($1, ' ') $$;
