import {useEffect, useEffectEvent, useRef, useState, useSyncExternalStore} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {JobEventReceiver,jobSocketUrl} from '../api/job-events';
import type {JobEventCursor} from '../api/compute-contracts';
import type {ComputeClient} from '../api/compute-client';

function onVisibilityChange(notify:()=>void){
  document.addEventListener('visibilitychange',notify);
  return ()=>document.removeEventListener('visibilitychange',notify);
}
const isVisible=()=>!document.hidden;
type ReadSnapshot=(signal:AbortSignal)=>ReturnType<ComputeClient['jobSnapshot']>;

export function useJobEvents(sessionId:string,owner:string,job:string|undefined,statusKey:readonly unknown[],resultKey:readonly unknown[],readSnapshot:ReadSnapshot){
  const cache=useQueryClient();
  const visible=useSyncExternalStore(onVisibilityChange,isVisible);
  const [instance]=useState(()=>crypto.randomUUID());
  const [generation,setGeneration]=useState(0);
  const revision=useRef(0);
  const freshSnapshot=useEffectEvent(readSnapshot);
  const statusScope=JSON.stringify(statusKey);
  const resultScope=JSON.stringify(resultKey);
  useEffect(()=>{
    if(!job) return;
    const selected=job;
    const status=JSON.parse(statusScope) as unknown[];
    const documentKey=JSON.parse(resultScope) as unknown[];
    let socket:WebSocket|undefined;
    let cursor:JobEventCursor|null=null;
    let stopped=false;
    let retries=0;
    let previousGeneration:string|undefined;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const key=(prefix:readonly unknown[])=>[...prefix,instance,revision.current];
    function retireProjection(){
      const prior=[key(status),key(documentKey)];
      revision.current++;
      if(!stopped) setGeneration(revision.current);
      for(const queryKey of prior){
        // Both the viewed job revision and its output belong to the same connection.
        // Cancelling/removing only the retired keys prevents late responses from filling the replacement view.
        void cache.cancelQueries({queryKey,exact:true});
        cache.removeQueries({queryKey,exact:true});
      }
    }
    function detach(){
      clearTimeout(timer);
      const prior=socket;
      socket=undefined;
      if(prior && prior.readyState<2) prior.close(1000);
    }
    function connect(){
      if(stopped||document.hidden||socket||typeof WebSocket==='undefined') return;
      let ws:WebSocket;
      try {ws=new WebSocket(jobSocketUrl(location.origin,owner,selected,cursor),'orange.job-events.v1');}
      catch{return;}
      socket=ws;
      const receiver=new JobEventReceiver(selected,cursor,previousGeneration);
      const current=()=>!stopped&&socket===ws&&ws.readyState===WebSocket.OPEN;
      ws.onmessage=async message=>{
        if(!current()) return;
        try {
          const ack=await receiver.accept(message.data,async(history,first)=>{
            if(first||history.kind==='reset') retireProjection();
            const target=key(status);
            if(history.kind==='page'){
              if(first||history.events.length){
                // Await an authoritative snapshot even if React hasn't mounted the new key yet.
                await cache.fetchQuery({queryKey:target,queryFn:({signal})=>freshSnapshot(signal),staleTime:0,retry:false});
              }
            } else {
              await cache.cancelQueries({queryKey:target,exact:true});
              if(current()) cache.setQueryData(target,{job:history.job,revision:history.job_version});
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
        retireProjection();
        if(!document.hidden&&retries<3){
          timer=setTimeout(connect,500*(2**retries));
          retries++;
        }
      };
    }
    function visibility(){
      if(document.hidden){detach();retireProjection();}
      else{retries=0;connect();}
    }
    document.addEventListener('visibilitychange',visibility);
    // Includes scope/visibility transitions that happened while there was no selected Job.
    setGeneration(revision.current);
    connect();
    return ()=>{
      stopped=true;
      document.removeEventListener('visibilitychange',visibility);
      detach();retireProjection();
    };
  },[cache,instance,sessionId,owner,job,statusScope,resultScope]);
  return {visible,statusKey:[...statusKey,instance,generation],resultKey:[...resultKey,instance,generation]};
}
