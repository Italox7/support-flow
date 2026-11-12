import 'reflect-metadata';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RegisterDto } from '../auth/auth.dto.js';
import { CreateCommentDto, CreateTicketDto } from '../tickets/tickets.dto.js';
import { CreateAgentDto } from '../users/users.dto.js';

/** Mesmas opções do ValidationPipe de app.setup.ts. */
function failing(cls: ClassConstructor<object>, body: object) {
  return validateSync(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((error) => ({ property: error.property, rules: Object.keys(error.constraints ?? {}) }));
}

const user = { email: 'a@example.com', password: 'senha-valida', name: 'Nome' };
const ticket = { title: 'Título', description: 'Descrição' };

describe('NoNul nos campos de texto gravados no banco', () => {
  it.each([
    ['no nome do cadastro', RegisterDto, { ...user, name: 'a\u0000b' }, 'name'],
    ['no nome do agente', CreateAgentDto, { ...user, name: 'a\u0000b' }, 'name'],
    ['no título do ticket', CreateTicketDto, { ...ticket, title: 'a\u0000b' }, 'title'],
    [
      'na descrição do ticket',
      CreateTicketDto,
      { ...ticket, description: 'a\u0000b' },
      'description',
    ],
    ['no corpo do comentário', CreateCommentDto, { body: 'a\u0000b' }, 'body'],
  ])('recusa NUL %s', (_case, cls, body, property) => {
    expect(failing(cls, body)).toEqual([{ property, rules: ['noNul'] }]);
  });

  it('aceita quebra de linha, tabulação e outros caracteres de controle', () => {
    const text = 'linha 1\nlinha 2\r\n\tfim \u0001';
    expect(failing(CreateTicketDto, { ...ticket, description: text })).toEqual([]);
    expect(failing(CreateCommentDto, { body: text })).toEqual([]);
  });

  it('valor que não é string continua só com o erro do IsString', () => {
    expect(failing(CreateCommentDto, { body: 42 })).toEqual([
      { property: 'body', rules: expect.not.arrayContaining(['noNul']) },
    ]);
  });
});
