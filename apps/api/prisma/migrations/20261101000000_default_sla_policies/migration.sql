-- Políticas de SLA padrão (horas corridas). Toda prioridade precisa de uma
-- política para os prazos serem calculados na criação do ticket; vindo da
-- migration, isso não depende de rodar seed em produção. O admin edita depois.
-- Só insere dados: a tabela e o RLS dela já existem desde a migration inicial.
INSERT INTO "sla_policies" ("priority", "firstResponseMinutes", "resolutionMinutes", "updatedAt")
VALUES
  ('URGENT', 60, 240, now()),
  ('HIGH', 240, 1440, now()),
  ('MEDIUM', 480, 2880, now()),
  ('LOW', 1440, 7200, now())
ON CONFLICT ("priority") DO NOTHING;
