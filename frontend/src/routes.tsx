import { Route, Routes } from 'react-router';
import { GuestOnly, HomeRedirect, RequireAuth, RequireRole } from './components/guards';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { UsersSearchPage } from './pages/UsersSearchPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomeRedirect />} />
        <Route element={<GuestOnly />}>
          <Route path="entrar" element={<LoginPage />} />
          <Route path="cadastro" element={<RegisterPage />} />
        </Route>
        <Route element={<RequireAuth />}>
          <Route path="perfil" element={<ProfilePage />} />
          <Route element={<RequireRole role="ORGANIZER" />}>
            <Route path="usuarios" element={<UsersSearchPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
