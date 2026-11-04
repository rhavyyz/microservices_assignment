import { describe, expect, it } from 'vitest';
import { jsonResponse, problem } from '../test/helpers';
import { ApiError, CODE_MESSAGES, describeError, parseErrorResponse } from './errors';

describe('parseErrorResponse com mensagens locais (Eventos e Inscrições)', () => {
  it('traduz pelo código e ignora o detail em inglês', async () => {
    const r = problem(409, 'EVENT_CANCELLED', 'the event is cancelled', { title: 'Conflict' });
    const err = await parseErrorResponse(r, true);
    expect(err.message).toBe(CODE_MESSAGES['EVENT_CANCELLED']);
    expect(err.message).not.toContain('cancelled');
    expect(err.code).toBe('EVENT_CANCELLED');
    expect(err.traceId).toBe('trace-abc-12345');
  });

  it('entende o formato do Inscrições: title igual ao code e sem detail', async () => {
    const r = jsonResponse(409, {
      status: 409,
      title: 'ACTIVITY_FULL',
      code: 'ACTIVITY_FULL',
      traceId: 't-1',
    });
    const err = await parseErrorResponse(r, true);
    expect(err.message).toBe('A atividade está lotada.');
    expect(err.message).not.toContain('ACTIVITY_FULL');
  });

  it('código desconhecido cai numa mensagem genérica, nunca no texto do servidor', async () => {
    const r = problem(422, 'SOMETHING_NEW', 'internal detail leaked');
    const err = await parseErrorResponse(r, true);
    expect(err.message).toBe('Não foi possível concluir a operação.');
    const r500 = problem(500, 'SOMETHING_NEW', 'stack trace here');
    expect((await parseErrorResponse(r500, true)).message).toContain('Erro no servidor');
  });

  it('mensagens de campo do servidor viram "Valor inválido." (o servidor responde em inglês)', async () => {
    const r = problem(400, 'VALIDATION_ERROR', 'invalid', {
      errors: [{ field: 'title', message: 'must be string' }],
    });
    const err = await parseErrorResponse(r, true);
    expect(err.fieldErrors).toEqual([{ field: 'title', message: 'Valor inválido.' }]);
  });

  it('sem a opção local (serviço de Usuários), mantém a mensagem em português do servidor', async () => {
    const r = problem(
      409,
      'EMAIL_ALREADY_REGISTERED',
      'Não foi possível concluir o cadastro com este e-mail.',
    );
    expect((await parseErrorResponse(r)).message).toBe(
      'Não foi possível concluir o cadastro com este e-mail.',
    );
  });

  it('todo código traduzido tem texto em português sem pontuação solta e sem o próprio código', () => {
    for (const [code, message] of Object.entries(CODE_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(10);
      expect(message, code).not.toContain(code);
      expect(message.endsWith('.'), code).toBe(true);
    }
  });

  it('indisponibilidade de dependência mostra a mensagem e o código de suporte', () => {
    const d = describeError(
      new ApiError(503, 'DEPENDENCY_UNAVAILABLE', CODE_MESSAGES['DEPENDENCY_UNAVAILABLE']!, 'tr-9'),
    );
    expect(d.message).toContain('indisponível');
    expect(d.traceId).toBe('tr-9');
  });
});
