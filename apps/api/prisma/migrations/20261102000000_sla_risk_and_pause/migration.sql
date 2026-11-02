-- Fase 5 (SLA): instante de "em risco" (80% do prazo) materializado ao lado de
-- cada prazo, para o filtro da fila ser SQL simples. Os tickets existentes são
-- preenchidos com a mesma conta de computeDeadlines (sla-deadlines.ts).

-- 1. A Fase 3 não gravava a pausa. O relógio parou na resolução (RESOLVED e
--    CLOSED) ou, em WAITING_CUSTOMER, no updatedAt: aproximação, porque um PATCH
--    de prioridade ou de responsável também mexe nele (risco aceito em
--    docs/decisions.md).
UPDATE "tickets"
SET "slaPausedAt" = COALESCE("resolvedAt", "updatedAt")
WHERE "status" IN ('RESOLVED', 'CLOSED') AND "slaPausedAt" IS NULL;

UPDATE "tickets"
SET "slaPausedAt" = "updatedAt"
WHERE "status" = 'WAITING_CUSTOMER' AND "slaPausedAt" IS NULL;

-- 2. *RiskAt = início + round(80% do prazo em ms), com início = abertura + pausas.
ALTER TABLE "tickets"
  ADD COLUMN "firstResponseRiskAt" TIMESTAMP(3),
  ADD COLUMN "resolutionRiskAt" TIMESTAMP(3);

UPDATE "tickets" AS t
SET "firstResponseRiskAt" = s.start + round(
      (extract(epoch FROM t."firstResponseDueAt" - s.start) * 1000 * 0.8)::numeric
    ) * interval '1 millisecond',
    "resolutionRiskAt" = s.start + round(
      (extract(epoch FROM t."resolutionDueAt" - s.start) * 1000 * 0.8)::numeric
    ) * interval '1 millisecond'
FROM (
  SELECT "id", "createdAt" + "pausedSeconds" * interval '1 second' AS start FROM "tickets"
) AS s
WHERE s."id" = t."id";

ALTER TABLE "tickets"
  ALTER COLUMN "firstResponseRiskAt" SET NOT NULL,
  ALTER COLUMN "resolutionRiskAt" SET NOT NULL;

-- 3. O relógio está parado se, e só se, há slaPausedAt. O cálculo na leitura e
--    o filtro da fila contam com isso; o banco garante. Fica fora do
--    schema.prisma, que não modela CHECK.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sla_paused_check"
  CHECK (("status" IN ('OPEN', 'IN_PROGRESS')) = ("slaPausedAt" IS NULL));
