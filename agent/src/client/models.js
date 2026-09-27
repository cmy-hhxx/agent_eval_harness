import {createElement as h, Fragment, useEffect, useState} from 'react';
import {Modal} from '@deepseek-ai/dsh-client-ui-primitives';
import {ModelListEditor} from '../../../vendor/deepseek/packages/client/ui-settings-models/src/client/ModelListEditor.tsx';
import {zh, en} from '../../../vendor/deepseek/packages/client/ui-settings-models/src/client/locales.ts';

const namespace = 'assistant.models';
const dictionaries = {
  zh: {...zh, title: '常用模型', close: '关闭', fetchModels: '勾选常用模型', fetchTitle: '常用模型', fetchDescription: '选择输入框中可切换的网关模型', fetchAdopt: '保存选择'},
  en: {...en, title: 'Favorite models', close: 'Close', fetchModels: 'Choose favorites', fetchTitle: 'Favorite models', fetchDescription: 'Choose gateway models for the conversation selector', fetchAdopt: 'Save selection'},
};

function ModelsSection({remote, t}) {
  const [models, setModels] = useState([]);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState('');
  const load = async (refresh = false) => {
    const response = await remote.models({refresh});
    if (!response.ok) throw new Error(response.error.message);
    return response.value;
  };
  useEffect(() => {
    let active = true;
    load().then(data => { if (active) setModels(data.models.filter(model => data.favorites.includes(model.id))); })
      .catch(error => { if (active) setFailure(error.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [remote]);
  return h(Fragment, null,
    h(ModelListEditor, {
      selectionOnly: true, models, probe: {settingsNs: 'assistant', provider: 'gateway'}, disabled: busy, onBusyChange: setBusy, t,
      operations: {discoverModels: async () => {
        try { return {kind: 'discovered', models: (await load(true)).models}; }
        catch (error) { return {kind: 'refused', message: error.message}; }
      }},
      onChange: async next => {
        setBusy(true); setFailure('');
        try {
          const result = await remote.favorites({ids: next.map(model => model.id)});
          if (!result.ok) throw new Error(result.error.message);
          setModels(next);
        } catch (error) { setFailure(error.message); }
        finally { setBusy(false); }
      },
    }),
    h(Modal, {open: !!failure, onClose: () => setFailure(''), title: t('title'), description: failure, closeLabel: t('close')}),
  );
}

export const inject = ['slots', 'locale', 'remote', 'remote.assistant'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(namespace, dictionaries));
  const t = ctx.locale.bind(namespace);
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'models', order: 10, label: () => t('title'), locale: namespace,
    inject: () => ({remote: ctx.remote.assistant}),
  }, ModelsSection));
}
