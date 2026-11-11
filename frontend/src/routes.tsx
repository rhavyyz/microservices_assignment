import { Route, Routes } from 'react-router';
import { GuestOnly, HomeRedirect, RequireAuth, RequireRole } from './components/guards';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { EventsPage } from './pages/EventsPage';
import { HomePage } from './pages/HomePage';
import { CertificatesPage } from './pages/CertificatesPage';
import { ManageEventPage } from './pages/ManageEventPage';
import { MyRegistrationsPage } from './pages/MyRegistrationsPage';
import { NewEventPage } from './pages/NewEventPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OrganizerEventsPage } from './pages/OrganizerEventsPage';
import { ParticipantsPage } from './pages/ParticipantsPage';
import { ReportPage } from './pages/ReportPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { PaymentPage } from './pages/PaymentPage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { UsersSearchPage } from './pages/UsersSearchPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomeRedirect />} />
        <Route path="eventos" element={<EventsPage />} />
        <Route path="eventos/:eventId" element={<EventDetailPage />} />
        <Route element={<GuestOnly />}>
          <Route path="entrar" element={<LoginPage />} />
          <Route path="cadastro" element={<RegisterPage />} />
        </Route>
        <Route element={<RequireAuth />}>
          <Route path="inicio" element={<HomePage />} />
          <Route path="inscricoes" element={<MyRegistrationsPage />} />
          <Route path="pagamentos/:paymentId" element={<PaymentPage />} />
          <Route path="notificacoes" element={<NotificationsPage />} />
          <Route path="certificados" element={<CertificatesPage />} />
          <Route path="perfil" element={<ProfilePage />} />
          <Route element={<RequireRole role="ADMIN" />}>
            <Route path="admin/usuarios" element={<AdminUsersPage />} />
          </Route>
          <Route element={<RequireRole role="ORGANIZER" />}>
            <Route path="usuarios" element={<UsersSearchPage />} />
            <Route path="organizador" element={<OrganizerEventsPage />} />
            <Route path="organizador/novo" element={<NewEventPage />} />
            <Route path="organizador/eventos/:eventId" element={<ManageEventPage />} />
            <Route path="organizador/eventos/:eventId/relatorio" element={<ReportPage />} />
            <Route
              path="organizador/atividades/:activityId/participantes"
              element={<ParticipantsPage />}
            />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
