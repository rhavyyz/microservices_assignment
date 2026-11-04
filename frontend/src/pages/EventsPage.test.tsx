import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EVENT_ID, event, eventPage } from '../test/fixtures';
import { fakeFetch, headersOf, jsonResponse, renderApp, textResponse } from '../test/helpers';

const LIST = 'GET /events/api/v1/events';
const urlOf = (c: unknown[] | undefined) => new URL(String(c?.[0]));

describe('Catálogo de eventos (público)', () => {
  it('lista os eventos com link para o detalhe, sem enviar token', async () => {
    const f = fakeFetch({
      [LIST]: () =>
        jsonResponse(
          200,
          eventPage([
            event(),
            event({ event_id: '44444444-4444-4444-8444-444444444444', title: 'Feira de Ciências' }),
          ]),
        ),
    });
    renderApp(f, '/eventos');
    expect(await screen.findByRole('link', { name: 'Semana de Tecnologia' })).toHaveAttribute(
      'href',
      `/eventos/${EVENT_ID}`,
    );
    expect(screen.getByRole('link', { name: 'Feira de Ciências' })).toBeInTheDocument();
    expect(screen.getByText('2 eventos encontrados')).toBeInTheDocument();
    expect(screen.getAllByText('Universidade Exemplo')).toHaveLength(2);
    const call = f.mock.calls[0];
    expect(headersOf(call)['Authorization']).toBeUndefined();
    expect(Object.fromEntries(urlOf(call).searchParams)).toEqual({ limit: '12', offset: '0' });
  });

  it('mostra o carregamento enquanto espera a resposta', async () => {
    let release: (r: Response) => void = () => undefined;
    const f = fakeFetch({ [LIST]: () => new Promise<Response>((r) => (release = r)) });
    renderApp(f, '/eventos');
    expect(await screen.findByText('Carregando eventos…')).toBeInTheDocument();
    release(jsonResponse(200, eventPage([event()])));
    expect(await screen.findByText('Semana de Tecnologia')).toBeInTheDocument();
    expect(screen.queryByText('Carregando eventos…')).not.toBeInTheDocument();
  });

  it('estado vazio com mensagem clara', async () => {
    renderApp(fakeFetch({ [LIST]: () => jsonResponse(200, eventPage([])) }), '/eventos');
    expect(await screen.findByText('Nenhum evento encontrado.')).toBeInTheDocument();
  });

  it('a busca envia q e atualiza a URL (a página recarrega com o mesmo filtro)', async () => {
    const f = fakeFetch({ [LIST]: () => jsonResponse(200, eventPage([event()])) });
    const { user } = renderApp(f, '/eventos');
    await screen.findByText('Semana de Tecnologia');
    await user.type(screen.getByLabelText('Buscar'), 'react');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    // Espera a PRÓPRIA requisição (e não um texto que já estava na tela do resultado anterior).
    await waitFor(() => expect(urlOf(f.mock.calls.at(-1)).searchParams.get('q')).toBe('react'));
    await screen.findByText('Semana de Tecnologia');
    expect(screen.getByLabelText('Buscar')).toHaveValue('react');
  });

  it('link compartilhável: /eventos?q=…&page=2 já chama a API com o filtro e o deslocamento certos', async () => {
    const f = fakeFetch({ [LIST]: () => jsonResponse(200, eventPage([event()], 30, 12)) });
    renderApp(f, '/eventos?q=react&page=2');
    expect(await screen.findByText('Página 2 de 3')).toBeInTheDocument();
    expect(Object.fromEntries(urlOf(f.mock.calls[0]).searchParams)).toEqual({
      q: 'react',
      limit: '12',
      offset: '12',
    });
    expect(screen.getByLabelText('Buscar')).toHaveValue('react');
  });

  it('paginação: "Próxima" pede o deslocamento seguinte e "Anterior" fica desabilitado na primeira página', async () => {
    const f = fakeFetch({ [LIST]: () => jsonResponse(200, eventPage([event()], 25)) });
    const { user } = renderApp(f, '/eventos');
    await screen.findByText('Página 1 de 3');
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Página 2 de 3')).toBeInTheDocument();
    expect(urlOf(f.mock.calls.at(-1)).searchParams.get('offset')).toBe('12');
  });

  it('o filtro de data vira instante ISO e período invertido é recusado sem chamar a API', async () => {
    const f = fakeFetch({ [LIST]: () => jsonResponse(200, eventPage([event()])) });
    const { user } = renderApp(f, '/eventos');
    await screen.findByText('Semana de Tecnologia');
    const calls = f.mock.calls.length;

    fireEvent.change(screen.getByLabelText('A partir de'), { target: { value: '2099-05-10' } });
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2099-05-01' } });
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(
      await screen.findByText('A data final deve ser igual ou posterior à inicial.'),
    ).toBeInTheDocument();
    expect(f.mock.calls.length).toBe(calls);

    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2099-05-20' } });
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(urlOf(f.mock.calls.at(-1)).searchParams.get('from')).not.toBeNull());
    const q = urlOf(f.mock.calls.at(-1)).searchParams;
    expect(q.get('from')).toMatch(/^2099-05-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(q.get('to')).toMatch(/^2099-05-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('falha de rede mostra erro e permite tentar novamente', async () => {
    let n = 0;
    const f = fakeFetch({
      [LIST]: () => {
        n += 1;
        if (n === 1) throw new TypeError('Failed to fetch');
        return jsonResponse(200, eventPage([event()]));
      },
    });
    const { user } = renderApp(f, '/eventos');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível conectar ao servidor',
    );
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Semana de Tecnologia')).toBeInTheDocument();
  });

  it('Gateway indisponível (503 em texto puro) mostra mensagem clara', async () => {
    renderApp(fakeFetch({ [LIST]: () => textResponse(503, 'no healthy instance') }), '/eventos');
    expect(await screen.findByRole('alert')).toHaveTextContent('temporariamente indisponível');
  });
});
