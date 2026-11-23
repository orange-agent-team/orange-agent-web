import {useEffect} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {JobEventReceiver,jobSocketUrl} from '../api/job-events';
import type {JobEventCursor} from '../api/compute-contracts';

export function useJobEvents(sessionId:string,owner:string,job:string|undefined,statusKey:readonly unknown[],resultKey:readonly unknown[]){
  const cache=useQueryClient();
  // These public query keys contain primitive strings. A normal rerender keeps the socket.
  const statusScope=JSON.stringify(statusKey);
  const resultScope=JSON.stringify(resultKey);
  useEffect(()=>{
    if(!job||typeof WebSocket==='undefined') return;
    const status=JSON.parse(statusScope) as unknown[];
    const documentKey=JSON.parse(resultScope) as unknown[];
    let socket:WebSocket|undefined;
    let cursor:JobEventCursor|null=null;
    let stopped=false;
    let retries=0;
    let previousGeneration:string|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    function discardResult(){
      void cache.cancelQueries({queryKey:documentKey,exact:true});
      cache.removeQueries({queryKey:documentKey,exact:true});
    }
    function detach(){
      clearTimeout(timer);
      const prior=socket;
      socket=undefined;
      if(prior && prior.readyState<2) prior.close(1000);
    }
    function connect(){
      if(stopped||document.hidden||socket||!job) return;
      let ws:WebSocket;
      try {ws=new WebSocket(jobSocketUrl(location.origin,owner,job,cursor),'orange.job-events.v1');}
      catch{return;} // HTTP status polling also supports older deployments.
      socket=ws;
      const receiver=new JobEventReceiver(job,cursor,previousGeneration);
      const current=()=>!stopped&&socket===ws&&ws.readyState===WebSocket.OPEN;
      ws.onmessage=async message=>{
        if(!current()) return;
        try {
          const ack=await receiver.accept(message.data,async(history,first)=>{
            if(first||history.kind==='reset') discardResult();
            if(history.kind==='page'){
              // Business events are metadata. Resolve terminal state and charges from the private status endpoint.
              if(first||history.events.length) await cache.refetchQueries({queryKey:status,exact:true,type:'active'},{throwOnError:true});
            } else {
              await cache.cancelQueries({queryKey:status,exact:true});
              if(current()) cache.setQueryData(status,{job:history.job,revision:history.job_version});
            }
            if(!current()) throw Error('INACTIVE_JOB_CONNECTION');
          });
          if(current()){
            ws.send(JSON.stringify(ack));
            cursor=ack.cursor;
            previousGeneration=ack.connection_generation;
          }
        }catch{
          if(current()) ws.close(4001,'invalid or unapplied frame');
        }
      };
      ws.onclose=()=>{
        if(stopped||socket!==ws) return;
        socket=undefined;
        if(previousGeneration!==undefined) discardResult();
        void cache.invalidateQueries({queryKey:status,exact:true});
        if(!document.hidden&&retries<3){
          timer=setTimeout(connect,500*(2**retries));
          retries++;
        }
      };
    }
    function visibility(){
      if(document.hidden){detach();discardResult();}
      else{retries=0;connect();}
    }
    document.addEventListener('visibilitychange',visibility);
    connect();
    return ()=>{
      stopped=true;
      document.removeEventListener('visibilitychange',visibility);
      detach();
      discardResult();
    };
  },[cache,sessionId,owner,job,statusScope,resultScope]);
}
