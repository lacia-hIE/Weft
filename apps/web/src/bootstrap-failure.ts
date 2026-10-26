/** A resource failure is recoverable without importing any application code. */
export class BootstrapResourceError extends Error {
  constructor(cause: unknown) {super('Application resource could not be loaded', {cause});}
}

export function renderBootstrapFailure(error: unknown): void {
  console.error('Weft application bootstrap failed', error);
  const root = document.getElementById('root');
  if (!root) return;
  const message = document.createElement('p');
  message.textContent = '界面资源加载失败，请刷新页面重试。';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = '查看错误详情';
  const diagnostic = document.createElement('pre');
  const failedResources = performance.getEntriesByType('resource')
    .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
    .filter(entry => entry.responseStatus >= 400 && new URL(entry.name).origin === location.origin)
    .slice(-10)
    .map(entry => `HTTP ${entry.responseStatus} ${new URL(entry.name).pathname}`);
  diagnostic.textContent = [error instanceof Error ? `${error.name}: ${error.message}` : String(error), ...failedResources].join('\n');
  diagnostic.style.whiteSpace = 'pre-wrap';
  diagnostic.style.overflowWrap = 'anywhere';
  details.appendChild(summary);
  details.appendChild(diagnostic);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重新加载';
  retry.addEventListener('click', () => location.reload());
  root.replaceChildren(message, details, retry);
}
