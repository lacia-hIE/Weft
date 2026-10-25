import metadata from './package.json' with {type:'json'};

// Exact reviewed releases, shared by the installer, Host, relay and download UI.
// Do not broaden this to an untested prerelease range.
export const SUPPORTED_DSH_VERSIONS=Object.freeze(metadata.engines.dsh.split(' || '));
export const LOCAL_HOST_BUNDLE=`weft-dsh-local-host-${metadata.version}.tgz`;
export function supportsDshVersion(version) {
  return typeof version==='string'&&SUPPORTED_DSH_VERSIONS.includes(version);
}
