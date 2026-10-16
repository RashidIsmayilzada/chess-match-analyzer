import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { IconGames, IconImport, IconKnight, IconOpenings, IconSettings } from '../icons';
import { QueueStatus } from './QueueStatus';

const NAV = [
  { to: '/', label: 'Import', icon: <IconImport />, end: true },
  { to: '/games', label: 'Games', icon: <IconGames />, end: false },
  { to: '/openings', label: 'Openings', icon: <IconOpenings />, end: false },
  { to: '/settings', label: 'Settings', icon: <IconSettings />, end: false },
];

export function Layout(): JSX.Element {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <IconKnight />
          <span>Chess Analyzer</span>
        </div>
        <nav>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <QueueStatus />
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
