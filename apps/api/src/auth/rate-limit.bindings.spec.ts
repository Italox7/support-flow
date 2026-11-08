import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { SlaPoliciesController } from '../sla/sla-policies.controller.js';
import { CommentsController } from '../tickets/comments.controller.js';
import { TicketsController } from '../tickets/tickets.controller.js';
import { UsersController } from '../users/users.controller.js';
import { UserRateLimitGuard } from './rate-limit.guards.js';

// Ligação do UserRateLimitGuard, lida dos decorators: tirar um @UseGuards não
// quebra nenhum outro teste, e os E2E que contam requisições só cobrem algumas
// rotas e só rodam no CI. /auth e /jobs têm limites próprios e ficam de fora.

const CONTROLLERS = [TicketsController, CommentsController, UsersController, SlaPoliciesController];

const WRITE_METHODS = new Set<RequestMethod>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

function writeRoutes(): { route: string; guarded: boolean }[] {
  return CONTROLLERS.flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
      const handler: unknown = controller.prototype[name as keyof typeof controller.prototype];
      if (typeof handler !== 'function') return [];
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined || !WRITE_METHODS.has(method)) return [];
      const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];
      return [
        { route: `${controller.name}.${name}`, guarded: guards.includes(UserRateLimitGuard) },
      ];
    }),
  );
}

describe('ligação do UserRateLimitGuard', () => {
  const routes = writeRoutes();
  const guarded = routes.filter((r) => r.guarded).map((r) => r.route);
  const unguarded = routes.filter((r) => !r.guarded).map((r) => r.route);

  it('cobre as escritas que entram no lock ou enchem o banco', () => {
    expect(guarded.sort()).toEqual(
      [
        'CommentsController.create',
        'TicketsController.create',
        'TicketsController.update',
        'UsersController.createAgent',
        'UsersController.setAvailability',
        'UsersController.setMyAvailability',
      ].sort(),
    );
  });

  // Uma escrita nova cai aqui e obriga a decidir se ela entra no limite.
  it('deixa de fora só as escritas decididas', () => {
    expect(unguarded.sort()).toEqual(
      ['SlaPoliciesController.update', 'TicketsController.transition'].sort(),
    );
  });
});
