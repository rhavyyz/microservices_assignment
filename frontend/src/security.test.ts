import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fakeFetch,
  fillLogin,
  jsonResponse,
  loginBody,
  problem,
  profile,
  renderApp,
} from './test/helpers';

// Código de produção (sem testes e sem a pasta de apoio aos testes), lido como texto.
const modules = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
/** Remove comentários (não são código): bloco e linha, sem cortar "://" de URLs em strings. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const source = Object.entries(modules)
  .filter(([path]) => !/\.test\.|\/test\//.test(path))
  .map(([path, text]): [string, string] => [path, stripComments(text)]);

function offenders(pattern: RegExp): string[] {
  return source.filter(([, text]) => pattern.test(text)).map(([path]) => path);
}

describe('código versionado', () => {
  it('há código de produção para analisar', () => {
    expect(source.length).toBeGreaterThan(10);
  });

  it('não persiste dados no navegador (localStorage, sessionStorage, cookies, IndexedDB)', () => {
    expect(offenders(/localStorage|sessionStorage|document\.cookie|indexedDB/)).toEqual([]);
  });

  it('não escreve no console (nada de token, senha ou cabeçalhos em log)', () => {
    expect(offenders(/\bconsole\s*\./)).toEqual([]);
  });

  it('não contém endereços de backend fixos (IP, localhost, portas internas)', () => {
    expect(offenders(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)).toEqual([]);
    expect(offenders(/localhost|127\.0\.0\.1|0\.0\.0\.0/)).toEqual([]);
    // Nenhuma URL absoluta no código; só o domínio de exemplo da mensagem de configuração é tolerado.
    expect(offenders(/https?:\/\/(?!gateway\.example\.com)[a-z0-9.-]+(:\d+)?/i)).toEqual([]);
  });

  it('o cabeçalho Authorization só é montado no cliente HTTP central', () => {
    expect(offenders(/Authorization/)).toEqual(['/src/api/client.ts']);
  });

  it('não usa APIs que injetam HTML ou executam texto', () => {
    expect(offenders(/dangerouslySetInnerHTML|innerHTML|\beval\s*\(|new Function\(/)).toEqual([]);
  });
});

describe('em execução', () => {
  afterEach(() => vi.restoreAllMocks());

  it('login, consulta e erros não vazam senha, token ou Authorization para o console nem para a tela', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const f = fakeFetch({
      'POST /user/api/v1/auth/login': () => jsonResponse(200, loginBody()),
      'GET /user/api/v1/users/me': () => jsonResponse(200, profile()),
      'PATCH /user/api/v1/users/me': () => problem(500, 'INTERNAL_ERROR', 'falha interna'),
    });
    const { user, container } = renderApp(f, '/perfil');
    await fillLogin(user, 'maria@example.com', 'senha-super-secreta-1');
    await screen.findByText('maria@example.com');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    await screen.findByText(/erro inesperado/);

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secret of ['tok.en.value', 'senha-super-secreta-1', 'Bearer']) {
      expect(logged).not.toContain(secret);
      expect(container.innerHTML).not.toContain(secret);
    }
  });
});
