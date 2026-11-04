import type { ReactNode } from 'react';
import { AuthProvider } from './auth/AuthProvider';
import type { Services } from './services/createServices';
import { ServicesContext } from './services/ServicesContext';

export function AppProviders({ services, children }: { services: Services; children: ReactNode }) {
  return (
    <ServicesContext.Provider value={services}>
      <AuthProvider>{children}</AuthProvider>
    </ServicesContext.Provider>
  );
}
