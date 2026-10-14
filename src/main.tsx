import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import './index.css';
import App from './App';
import { LIVE, captureToken } from './live/mode';

const host = document.getElementById('root');
if (!host) throw new Error('Root element #root not found');

/*
 * Analytics and Speed Insights are the /react entry points, not /next: this is
 * a Vite SPA and the Next.js imports the Vercel dashboard suggests would fail
 * to resolve.
 *
 * Both render nothing and inject a deferred script, so neither is on the
 * critical path. They no-op outside a Vercel deployment, which keeps local
 * development free of beacons.
 */
// Live mode runs against a local daemon on the user's machine and reports
// nowhere. The token must come off the URL before App reads it.
if (LIVE) captureToken();

createRoot(host).render(
  <StrictMode>
    <App />
    {!LIVE && <Analytics />}
    {!LIVE && <SpeedInsights />}
  </StrictMode>,
);
