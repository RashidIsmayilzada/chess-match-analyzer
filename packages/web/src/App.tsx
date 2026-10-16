import type { JSX } from 'react';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { Layout } from './components/Layout';
import { GameReviewPage } from './pages/GameReviewPage';
import { GamesPage } from './pages/GamesPage';
import { ImportPage } from './pages/ImportPage';
import { OpeningsPage } from './pages/OpeningsPage';
import { SettingsPage } from './pages/SettingsPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <ImportPage /> },
      { path: 'games', element: <GamesPage /> },
      { path: 'games/:id', element: <GameReviewPage /> },
      { path: 'openings', element: <OpeningsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
