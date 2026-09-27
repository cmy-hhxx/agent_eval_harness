import {createElement as h,Fragment,useEffect,useState} from 'react';
import {Button,Modal,IconDataOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives';
import {ModelListEditor} from '../../../vendor/deepseek/packages/client/ui-settings-models/src/client/ModelListEditor.tsx';
import {zh,en} from '../../../vendor/deepseek/packages/client/ui-settings-models/src/client/locales.ts';

function Favorites({wide,remote}) {
 const [open,setOpen]=useState(false),[models,setModels]=useState([]),[busy,setBusy]=useState(false),[failure,setFailure]=useState('');
 const chinese=document.documentElement.lang.startsWith('zh');
 const label=chinese?'常用模型':'Favorite models';
 const t=key=>({fetchModels:chinese?'勾选常用模型':'Choose favorites',fetchTitle:label,fetchDescription:chinese?'选择输入框中可切换的网关模型':'Choose gateway models for the conversation selector',fetchAdopt:chinese?'保存选择':'Save selection'}[key]??(chinese?zh:en)[key]);
 const load=async(refresh=false)=>{const response=await remote.models({refresh});if(!response.ok)throw new Error(response.error.message);return response.value;};
 useEffect(()=>{if(!open)return;let active=true;setBusy(true);setFailure('');load().then(data=>{if(active)setModels(data.models.filter(model=>data.favorites.includes(model.id)));}).catch(e=>{if(active)setFailure(e.message);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[open]);
 return h(Fragment,null,
  h(Button,{variant:'ghost',onClick:()=>setOpen(true),'aria-label':label,title:label},h(IconDataOutlineRegular,{size:18}),wide?label:null),
  h(Modal,{open,onClose:()=>setOpen(false),title:label,closeLabel:chinese?'关闭':'Close',description:failure||undefined},
   h(ModelListEditor,{selectionOnly:true,models,probe:{settingsNs:'assistant',provider:'gateway'},disabled:busy,onBusyChange:setBusy,t,
    operations:{discoverModels:async()=>{try{const data=await load(true);return {kind:'discovered',models:data.models};}catch(error){return {kind:'refused',message:error.message};}}},
    onChange:async next=>{setBusy(true);setFailure('');try{const result=await remote.favorites({ids:next.map(m=>m.id)});if(!result.ok)throw new Error(result.error.message);setModels(next);}catch(error){setFailure(error.message);}finally{setBusy(false);}}
   })
  ));
}
export const inject=['slots','remote','remote.assistant'];
export function apply(ctx){ctx.slots.inject('sidebar.settings',()=>ctx.slots.register({name:'sidebar.settings',inject:()=>({remote:ctx.remote.assistant})},Favorites));}
