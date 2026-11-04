import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { AppProviders } from './AppProviders';
import { ConfigError, readConfig } from './config';
import { AppRoutes } from './routes';
import { createServices } from './services/createServices';
import './styles/app.css';

const root = createRoot(document.getElementById('root')!);

try {
  const services = createServices(readConfig());
  root.render(
    <StrictMode>
      <AppProviders services={services}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </StrictMode>,
  );
} catch (e) {
  // Configuração ausente/inválida: mostra uma mensagem clara em vez de uma tela em branco.
  const message = e instanceof ConfigError ? e.message : 'Não foi possível iniciar a aplicação.';
  root.render(
    <main className="container main">
      <section className="card">
        <h1>Configuração inválida</h1>
        <p>{message}</p>
      </section>
    </main>,
  );
}
