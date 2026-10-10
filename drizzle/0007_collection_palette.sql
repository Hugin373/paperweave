-- Move collections to the new color palette, and give uncolored collections a color in creation order.
UPDATE "collections" SET "color" = CASE lower("color")
  WHEN '#3150c9' THEN '#5889e6'
  WHEN '#2b8a57' THEN '#37ab6b'
  WHEN '#c27a14' THEN '#ecae30'
  WHEN '#b8432f' THEN '#e15955'
  WHEN '#7b4bc4' THEN '#9e66d7'
  WHEN '#0f7c8a' THEN '#25aea7'
  WHEN '#69645c' THEN '#3bacda'
  WHEN '#c2417a' THEN '#df5e97'
  WHEN '#4f7a12' THEN '#85b749'
  WHEN '#2f6fb5' THEN '#3bacda'
  ELSE "color" END
WHERE "color" IS NOT NULL;--> statement-breakpoint
UPDATE "collections" AS c SET "color" = (ARRAY['#5889e6','#e78537','#37ab6b','#df5e97','#25aea7','#ecae30','#9e66d7','#e15955','#85b749','#3bacda'])[((o.n - 1) % 10) + 1]
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "workspace_id" ORDER BY "created_at") AS n FROM "collections" WHERE "color" IS NULL
) AS o
WHERE c."id" = o."id";
