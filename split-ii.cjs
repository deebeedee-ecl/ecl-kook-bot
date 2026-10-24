'use strict';
function createSplitTwoAdapter({callEclApi,sendChannelMessage,sendNotification=sendChannelMessage,getKookUserId,isAdminEvent}){
  let timer,busy=false;
  async function handle(event,args){
    try{
      const data=await callEclApi('/api/kook/tournaments/split-ii',{command:['!split2',...args].join(' '),kookUserId:getKookUserId(event),channelId:event.target_id,isAdmin:isAdminEvent(event)});
      await sendChannelMessage(event.target_id,data.reply||'Split II request saved.');
    }catch(error){
      const reason=error?.response?.data?.message;
      await sendChannelMessage(event.target_id,typeof reason==='string'?reason.slice(0,1000):'Split II is temporarily unavailable. Your saved tournament records have not been cleared.');
    }
  }
  async function tick(){
    if(busy)return;busy=true;
    try{
      const {notice}=await callEclApi('/api/jobs/tournament-notifications',{action:'claim'});
      if(!notice)return;
      if(typeof notice.id!=='string'||typeof notice.deliveryKey!=='string'||!/^\d{1,30}$/.test(notice.channelId)||typeof notice.content!=='string'||notice.content.length>3500)return;
      let sent=false;try{sent=(await sendNotification(notice.channelId,notice.content))!==false;}catch{/* Ambiguous delivery: administrator checks before retry. */}
      await callEclApi('/api/jobs/tournament-notifications',{action:'finish',id:notice.id,deliveryKey:notice.deliveryKey,sent});
    }catch{/* Durable queue remains on the website. Never print credentials or message bodies. */}
    finally{busy=false;}
  }
  return {handle,tick,start(){if(timer)return;timer=setInterval(()=>void tick(),60000);timer.unref?.();},stop(){clearInterval(timer);timer=null;}};
}
module.exports={createSplitTwoAdapter};
