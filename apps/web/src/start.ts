// Keep this entry independent of the application module graph so a rejected
// chunk produces a recoverable error instead of a permanent loading message.
import {renderBootstrapFailure} from './bootstrap-failure.ts';
const applicationModule = '/assets/app.js';
void import(applicationModule).catch(renderBootstrapFailure);
