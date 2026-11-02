import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDatabaseUrl } from '../src/prisma/database-url.js';
import { computeDeadlines } from '../src/sla/sla-deadlines.js';
import { TEST_DATABASE_URL } from './e2e-setup.js';

// O CI aplica as migrations num banco vazio, onde o preenchimento da migration
// do SLA não tem o que preencher. Aqui ela roda sobre tickets "da Fase 3", num
// schema descartável, e o resultado é comparado com o código (computeDeadlines).

const TARGET = '20261102000000_sla_risk_and_pause';
const SCHEMA = 'sla_migration_check';
const MIGRATIONS = join(import.meta.dirname, '../prisma/migrations');
const MIN = 60_000;
const MEDIUM = { firstResponseMinutes: 480, resolutionMinutes: 2880 };

const migrationSql = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

describe.skipIf(!TEST_DATABASE_URL)('migration do SLA sobre dados existentes (e2e)', () => {
  let client: pg.Client;

  /** Ticket como a Fase 3 gravava: prazos da MEDIUM, sem *RiskAt e sem pausa gravada. */
  async function legacyTicket(
    title: string,
    fields: {
      status: string;
      createdAt: Date;
      pausedSeconds?: number;
      updatedAt?: Date;
      resolvedAt?: Date | null;
      closedAt?: Date | null;
      slaPausedAt?: Date | null;
      budgetsMs?: [number, number];
    },
  ): Promise<void> {
    const paused = fields.pausedSeconds ?? 0;
    const start = fields.createdAt.getTime() + paused * 1000;
    const [firstMs, resolutionMs] = fields.budgetsMs ?? [
      MEDIUM.firstResponseMinutes * MIN,
      MEDIUM.resolutionMinutes * MIN,
    ];
    await client.query(
      `INSERT INTO "tickets" ("id", "title", "description", "status", "requesterId", "createdAt",
         "updatedAt", "firstResponseDueAt", "resolutionDueAt", "slaPausedAt", "pausedSeconds",
         "resolvedAt", "closedAt")
       SELECT gen_random_uuid(), $1, 'legado', $2::"TicketStatus", "id", $3, $4, $5, $6, $7, $8, $9, $10
       FROM "users" LIMIT 1`,
      [
        title,
        fields.status,
        fields.createdAt,
        fields.updatedAt ?? fields.createdAt,
        new Date(start + firstMs),
        new Date(start + resolutionMs),
        fields.slaPausedAt ?? null,
        paused,
        fields.resolvedAt ?? null,
        fields.closedAt ?? null,
      ],
    );
  }

  const row = async (title: string) =>
    (await client.query(`SELECT * FROM "tickets" WHERE "title" = $1`, [title])).rows[0];

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: parseDatabaseUrl(TEST_DATABASE_URL!).connectionString,
    });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE; CREATE SCHEMA "${SCHEMA}"`);
    await client.query(`SET search_path TO "${SCHEMA}"`);
    // A migration inicial liga o RLS na tabela do Prisma, que o migrate cria antes.
    await client.query(`CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY)`);

    const all = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(all).toContain(TARGET);
    for (const name of all.filter((name) => name < TARGET)) await client.query(migrationSql(name));

    await client.query(
      `INSERT INTO "users" ("id", "email", "passwordHash", "name", "updatedAt")
       VALUES (gen_random_uuid(), 'legado@example.com', 'x', 'legado', now())`,
    );
    const createdAt = new Date('2026-10-30T12:00:00.123Z');
    await legacyTicket('aberto', { status: 'OPEN', createdAt });
    await legacyTicket('esperando', {
      status: 'WAITING_CUSTOMER',
      createdAt,
      pausedSeconds: 900,
      updatedAt: new Date('2026-10-30T15:00:00.000Z'),
    });
    await legacyTicket('resolvido', {
      status: 'RESOLVED',
      createdAt,
      resolvedAt: new Date('2026-10-30T18:00:00.000Z'),
      updatedAt: new Date('2026-10-30T19:00:00.000Z'),
    });
    await legacyTicket('fechado sem resolvedAt', {
      status: 'CLOSED',
      createdAt,
      closedAt: new Date('2026-10-31T09:00:00.000Z'),
      updatedAt: new Date('2026-10-31T10:00:00.000Z'),
    });
    await legacyTicket('correndo com sobra de pausa', {
      status: 'IN_PROGRESS',
      createdAt,
      slaPausedAt: new Date('2026-10-30T13:00:00.000Z'),
    });
    // Prazo com ms quebrados: 80% de 1001 ms é 800,8, arredonda para 801.
    await legacyTicket('prazo quebrado', { status: 'OPEN', createdAt, budgetsMs: [1001, 2003] });

    await client.query(migrationSql(TARGET));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await client?.end();
  });

  it.each(['aberto', 'esperando', 'resolvido', 'fechado sem resolvedAt'])(
    '%s: *RiskAt iguais aos do computeDeadlines',
    async (title) => {
      const t = await row(title);
      const expected = computeDeadlines(t.createdAt, MEDIUM, t.pausedSeconds);
      expect({
        firstResponseDueAt: t.firstResponseDueAt,
        firstResponseRiskAt: t.firstResponseRiskAt,
        resolutionDueAt: t.resolutionDueAt,
        resolutionRiskAt: t.resolutionRiskAt,
      }).toEqual(expected);
    },
  );

  it('arredonda como o Math.round do código', async () => {
    const t = await row('prazo quebrado');
    expect(t.firstResponseRiskAt.getTime() - t.createdAt.getTime()).toBe(Math.round(1001 * 0.8));
    expect(t.resolutionRiskAt.getTime() - t.createdAt.getTime()).toBe(Math.round(2003 * 0.8));
  });

  it('grava a pausa que a Fase 3 não gravava, e limpa a que sobrou', async () => {
    expect((await row('aberto')).slaPausedAt).toBeNull();
    expect((await row('esperando')).slaPausedAt).toEqual(new Date('2026-10-30T15:00:00.000Z'));
    expect((await row('resolvido')).slaPausedAt).toEqual(new Date('2026-10-30T18:00:00.000Z'));
    expect((await row('fechado sem resolvedAt')).slaPausedAt).toEqual(
      new Date('2026-10-31T09:00:00.000Z'),
    );
    expect((await row('correndo com sobra de pausa')).slaPausedAt).toBeNull();
  });

  it('deixa o CHECK ligado', async () => {
    await expect(
      client.query(`UPDATE "tickets" SET "slaPausedAt" = now() WHERE "title" = 'aberto'`),
    ).rejects.toThrow(/tickets_sla_paused_check/);
  });
});
