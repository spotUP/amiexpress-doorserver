import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Browse } from './pages/Browse';
import './index.css';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // The catalog announces its own changes over SSE (useLiveRevision), so
      // nothing here needs to poll or refetch on window focus.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <Tooltip.Provider>
        <Browse />
      </Tooltip.Provider>
    </QueryClientProvider>
  </StrictMode>
);
