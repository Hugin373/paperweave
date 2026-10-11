-- "Free PDF" links that a server cannot download: DOI links (the article's web page) and bot-checked PubMed
-- Central / Europe PMC PDF links. They become read-free links (opened in the browser) instead of PDFs.
UPDATE "papers"
SET "free_read_url" = coalesce("free_read_url", "open_access_pdf_url"),
    "open_access_pdf_url" = NULL
WHERE "open_access_pdf_url" ~* '^https?://(dx\.)?doi\.org/'
   OR "open_access_pdf_url" ~* '^https?://(pmc\.ncbi\.nlm\.nih\.gov|www\.ncbi\.nlm\.nih\.gov/pmc/)'
   OR ("open_access_pdf_url" ~* '^https?://(www\.)?europepmc\.org/'
       AND ("open_access_pdf_url" ~* '[?&]pdf=' OR "open_access_pdf_url" ~* 'render'));
