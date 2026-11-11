import type { SlaClock, SlaState } from '@support-flow/shared';
import { describe, expect, it } from 'vitest';
import { clearDrafts, loadDraft, saveDraft } from './drafts';
import { ApiError, describeError, fieldErrors } from './errors';
import { safeRedirect } from './redirect';
import { describeSla, formatDuration, liveSla, liveState, mostUrgent, secondsLeft } from './sla';

const clock = (state: SlaState, remainingSeconds = 600): SlaClock => ({
  state,
  remainingSeconds,
  dueAt: '2026-11-04T12:00:00.000Z',
});

describe('safeRedirect', () => {
  it.each(['/fila', '/fila?status=OPEN', '/tickets/abc'])('aceita %s', (target) => {
    expect(safeRedirect(target)).toBe(target);
  });

  it.each([
    'https://mau.example',
    '//mau.example',
    '/\\mau.example',
    '\\\\mau.example',
    'javascript:alert(1)',
    '/\tfila',
    '/\n/mau.example',
    '',
    null,
    undefined,
    42,
    '/entrar',
    '/cadastro?x=1',
    '/.//mau.example',
    '/..//mau.example',
    '/a/..//mau.example',
    '/%2e//mau.example',
  ])('recusa %j', (target) => {
    expect(safeRedirect(target)).toBe('/');
  });
});

describe('SLA', () => {
  it.each<[SlaState, SlaState, SlaState]>([
    ['BREACHED', 'OK', 'BREACHED'],
    ['OK', 'BREACHED', 'BREACHED'],
    ['AT_RISK', 'OK', 'AT_RISK'],
    ['OK', 'AT_RISK', 'AT_RISK'],
    ['MET', 'OK', 'OK'],
    ['MET', 'PAUSED', 'PAUSED'],
    ['MET', 'MET', 'MET'],
    ['NOT_APPLICABLE', 'MET', 'MET'],
    ['NOT_APPLICABLE', 'BREACHED', 'BREACHED'],
  ])('mais urgente entre %s e %s: %s', (firstResponse, resolution, expected) => {
    expect(
      mostUrgent({ firstResponse: clock(firstResponse), resolution: clock(resolution) }).state,
    ).toBe(expected);
  });

  it('no empate, vence o prazo mais curto', () => {
    const near = clock('OK', 60);
    expect(mostUrgent({ firstResponse: near, resolution: clock('OK', 600) })).toBe(near);
  });

  it('a contagem parte da resposta, e passar de zero vira Violado', () => {
    const atResponse = 1_000_000;
    const running = clock('AT_RISK', 10);
    expect(secondsLeft(running, atResponse, atResponse + 4_000)).toBe(6);
    expect(liveState(running, atResponse, atResponse + 10_000)).toBe('AT_RISK');
    expect(liveState(running, atResponse, atResponse + 11_000)).toBe('BREACHED');
  });

  it('relógio do navegador atrás do instante da resposta não aumenta o prazo', () => {
    expect(secondsLeft(clock('OK', 10), 1_000_000, 900_000)).toBe(10);
  });

  it('o mais urgente considera o relógio que estourou depois da resposta', () => {
    const sla = { firstResponse: clock('AT_RISK', 600), resolution: clock('OK', 30) };
    expect(mostUrgent(liveSla(sla, 0, 30_000)).state).toBe('AT_RISK');
    expect(mostUrgent(liveSla(sla, 0, 31_000)).state).toBe('BREACHED');
  });

  it('pausado não conta nem vira Violado sozinho', () => {
    expect(liveState(clock('PAUSED', 10), 0, 1_000_000)).toBe('PAUSED');
  });

  it.each([
    [45, '45 s'],
    [60, '1 min'],
    [3599, '59 min'],
    [3600, '1 h'],
    [3660, '1 h 1 min'],
    [86400, '1 d'],
    [90000, '1 d 1 h'],
    [-5, '0 s'],
  ])('formata %i como %s', (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  it('o texto acessível traz os dois relógios', () => {
    expect(describeSla({ firstResponse: clock('AT_RISK', 720), resolution: clock('PAUSED') })).toBe(
      'Primeira resposta: Em risco, vence em 12 min. Resolução: Pausado, aguardando cliente.',
    );
  });
});

describe('rascunhos', () => {
  it('são por usuário e ticket, e o logout apaga', () => {
    saveDraft('a', 't1', { text: 'texto', isInternal: true });
    expect(loadDraft('a', 't1')).toEqual({ text: 'texto', isInternal: true });
    expect(loadDraft('b', 't1').text).toBe('');
    expect(loadDraft('a', 't2').text).toBe('');
    sessionStorage.setItem('outra-chave', 'fica');

    clearDrafts();

    expect(loadDraft('a', 't1').text).toBe('');
    expect(sessionStorage.getItem('outra-chave')).toBe('fica');
  });

  it('texto vazio remove o rascunho', () => {
    saveDraft('a', 't1', { text: 'texto', isInternal: false });
    saveDraft('a', 't1', { text: '', isInternal: false });
    expect(sessionStorage.getItem('support-flow:draft:a:t1')).toBeNull();
  });

  it.each(['{quebrado', 'null', '{"text":1}'])('rascunho inválido %s vira vazio', (raw) => {
    sessionStorage.setItem('support-flow:draft:a:t1', raw);
    expect(loadDraft('a', 't1')).toEqual({ text: '', isInternal: false });
  });

  it('sem a marca de interna, na dúvida continua interna', () => {
    sessionStorage.setItem('support-flow:draft:a:t1', '{"text":"nota"}');
    expect(loadDraft('a', 't1').isInternal).toBe(true);
  });
});

describe('erros', () => {
  it('mapeia a validação do Nest para o texto de cada campo', () => {
    const error = new ApiError(400, {
      message: ['email must be an email', 'password must be longer', 'toString is odd'],
    });
    expect(fieldErrors(error, { email: 'E-mail inválido', password: 'Senha curta' })).toEqual({
      email: 'E-mail inválido',
      password: 'Senha curta',
    });
  });

  it('não vaza mensagem técnica em inglês', () => {
    const error = new ApiError(400, { message: ['email must be an email'] });
    expect(describeError(error)).toBe('Confira os campos e tente de novo.');
  });

  it('usa a mensagem de regra da API, que já vem em português', () => {
    const error = new ApiError(409, { message: 'Ticket fechado não aceita comentários.' });
    expect(describeError(error)).toBe('Ticket fechado não aceita comentários.');
  });

  it('avisa quando uma escrita pode ter sido gravada', () => {
    expect(describeError(new ApiError(0, null, true))).toMatch(/Confira se a ação foi concluída/);
  });

  it.each([
    ['1', 'cerca de 1 minuto'],
    ['60', 'cerca de 1 minuto'],
    ['61', 'cerca de 2 minutos'],
    ['900', 'cerca de 15 minutos'],
    ['abc', 'alguns minutos'],
    [null, 'alguns minutos'],
  ])('429 com Retry-After %s diz "%s"', (header, wait) => {
    const headers: Record<string, string> = header === null ? {} : { 'Retry-After': header };
    const error = ApiError.fromResponse(new Response(null, { status: 429, headers }), null);
    expect(describeError(error)).toBe(`Muitas tentativas. Aguarde ${wait} e tente de novo.`);
    expect(describeError(error, { action: 'login' })).toBe(
      `Muitas tentativas de entrada. Aguarde ${wait} e tente de novo.`,
    );
  });

  it('503 do hash tem texto próprio; outro 503 continua genérico', () => {
    const busy = new ApiError(503, { code: 'PASSWORD_HASH_BUSY' });
    expect(describeError(busy)).toMatch(/Nada foi salvo/);
    expect(describeError(busy, { action: 'login' })).not.toMatch(/salvo/);
    expect(describeError(new ApiError(503, null))).toBe(
      'O sistema está ocupado. Tente de novo em instantes.',
    );
  });
});
