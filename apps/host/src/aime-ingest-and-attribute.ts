import {parseArgs} from 'node:util';
import {loadAimeConfiguration,runAimeEvaluation} from './aime-execution.js';

const {values}=parseArgs({options:{config:{type:'string'},watch:{type:'boolean'},help:{type:'boolean'}}});
if(values.help){console.log('npm run aime:ingest-and-attribute -- --config /absolute/path/config.json [--watch]');}
else{
  if(!values.config)throw Error('--config is required');
  const c=await loadAimeConfiguration(values.config);
  process.env.EVAL_CONFIG_FILE=c.settingsFile;process.env.EVAL_LOG_DIR=c.logDirectory;process.env.EVAL_LOG_LOCK_DIR=c.logLockDirectory;
  const controller=new AbortController(),stop=()=>controller.abort(Error('AIME run interrupted'));
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{process.exitCode=await runAimeEvaluation(c,{signal:controller.signal,watch:values.watch,manualRetry:!values.watch});}
  catch(error){console.error(String(error));process.exitCode=controller.signal.aborted?130:2;}
  finally{process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
