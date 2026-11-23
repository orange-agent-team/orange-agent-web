import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import HostedToolApproval from '../../src/app/HostedToolApproval';

const session={session_id:'fixture-session',user_id:'fixture-user',personal_owner_id:'fixture-owner',csrf_token:'a'.repeat(43),expires_at:'2099-01-01T00:00:00Z'};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <HostedToolApproval session={session} run="fixture-run" choice={{name:'list_directory',execution_digest:'e'.repeat(64)}}
      invalidate={()=>{throw Error('Unexpected session invalidation');}}/>
  </QueryClientProvider>
);
